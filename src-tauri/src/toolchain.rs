use crate::model::{ContainerRuntime, ToolInfo};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;

/// The tools we resolve once at startup and then only ever invoke by absolute path.
pub const TOOLS: [&str; 11] = [
    "git", "bun", "npm", "yarn", "node", "gh", "docker", "podman", "jq", "ss", "lsof",
];

#[derive(Debug, Clone, Default)]
pub struct Toolchain {
    pub paths: BTreeMap<String, PathBuf>,
    pub versions: BTreeMap<String, String>,
    pub warnings: Vec<String>,
    /// PATH for child processes: the directories of every tool we resolved,
    /// prepended to the inherited PATH.
    ///
    /// Resolving an absolute path is not enough on its own. `npm` and `yarn` are
    /// shell scripts that `exec node`, so launching them by absolute path from a
    /// GUI app still fails unless node's directory is on the child's PATH.
    pub path_env: String,
}

impl Toolchain {
    pub fn path(&self, tool: &str) -> Option<&PathBuf> {
        self.paths.get(tool)
    }

    pub fn require(&self, tool: &str) -> Result<PathBuf, crate::error::AppError> {
        self.paths
            .get(tool)
            .cloned()
            .ok_or_else(|| crate::error::AppError::ToolMissing(tool.to_string()))
    }

    pub fn has(&self, tool: &str) -> bool {
        self.paths.contains_key(tool)
    }

    /// Prefer docker, fall back to podman. On this machine only podman exists, so
    /// the fallback is the primary path — not an edge case.
    pub fn container_runtime(&self) -> Option<ContainerRuntime> {
        if self.has("docker") {
            Some(ContainerRuntime::Docker)
        } else if self.has("podman") {
            Some(ContainerRuntime::Podman)
        } else {
            None
        }
    }

    /// Applies the augmented PATH to a child command.
    pub fn apply_path(&self, cmd: &mut tokio::process::Command) {
        if !self.path_env.is_empty() {
            cmd.env("PATH", &self.path_env);
        }
    }

    pub fn to_infos(&self) -> Vec<ToolInfo> {
        TOOLS
            .iter()
            .map(|t| ToolInfo {
                name: (*t).to_string(),
                path: self.paths.get(*t).map(|p| p.display().to_string()),
                version: self.versions.get(*t).cloned(),
            })
            .collect()
    }
}

/// Resolves every tool to an absolute path, once.
///
/// This is mandatory, not a nicety: `bun` and `node` are commonly installed by a
/// version manager (nvm, fnm, asdf) that exists only as shell-rc state. A
/// GUI-launched app inherits none of it, so relying on PATH gives ENOENT for
/// `bun run dev` — and the symptom (works from a terminal, fails from the
/// launcher) is maximally confusing.
///
/// Three sources, most authoritative first:
///   1. the user's own login+interactive shell, so their version manager applies
///   2. the inherited PATH
///   3. known install directories, which depend on no shell rc at all
pub async fn probe() -> Toolchain {
    let mut tc = Toolchain::default();
    let script = format!("command -v {} 2>/dev/null || true", TOOLS.join(" "));

    // 1. The user's shell. `-i` as well as `-l`, because nvm is usually
    //    initialised in .zshrc / .bashrc — files a *non-interactive* login shell
    //    never reads. Using $SHELL matters: probing bash when the user runs zsh
    //    finds nothing at all.
    for sh in login_shells() {
        collect_from_shell(&mut tc, &sh, &script).await;
    }

    // 2. Whatever we inherited.
    for t in TOOLS {
        if !tc.paths.contains_key(t) {
            if let Some(p) = which(t) {
                tc.paths.insert(t.to_string(), p);
            }
        }
    }

    // 3. Well-known locations. This is the path that survives a desktop launcher
    //    with no shell involvement whatsoever.
    for dir in candidate_dirs() {
        for t in TOOLS {
            if tc.paths.contains_key(t) {
                continue;
            }
            let cand = dir.join(t);
            if is_executable(&cand) {
                tc.paths.insert(t.to_string(), cand);
            }
        }
    }

    tc.path_env = build_path_env(&tc.paths);

    for t in TOOLS {
        if let Some(p) = tc.paths.get(t).cloned() {
            if let Some(v) = version_of(&p, t, &tc.path_env).await {
                tc.versions.insert(t.to_string(), v);
            }
        }
    }

    if !tc.has("git") {
        tc.warnings
            .push("git was not found — the workspace cannot be scanned.".into());
    }
    if !tc.has("bun") && !tc.has("npm") && !tc.has("yarn") {
        tc.warnings
            .push("no package manager found (bun/npm/yarn) — dev servers cannot start.".into());
    }
    if tc.container_runtime().is_none() {
        tc.warnings
            .push("neither docker nor podman found — the services panel will be empty.".into());
    }
    if std::env::var_os("SSH_AUTH_SOCK").is_none() {
        tc.warnings.push(
            "SSH_AUTH_SOCK is not set — git operations over SSH will fail. Start an ssh-agent and \
             relaunch."
                .into(),
        );
    }

    tc
}

/// Every resolved tool's directory, then the inherited PATH, deduplicated.
fn build_path_env(paths: &BTreeMap<String, PathBuf>) -> String {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for p in paths.values() {
        if let Some(d) = p.parent() {
            if !dirs.iter().any(|x| x == d) {
                dirs.push(d.to_path_buf());
            }
        }
    }
    if let Some(existing) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&existing) {
            if !dirs.iter().any(|x| *x == d) {
                dirs.push(d);
            }
        }
    }
    std::env::join_paths(dirs)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// $SHELL first, then bash as a backstop.
fn login_shells() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(sh) = std::env::var_os("SHELL") {
        let p = PathBuf::from(sh);
        if is_executable(&p) {
            out.push(p);
        }
    }
    for fallback in ["/bin/bash", "/bin/sh"] {
        let p = PathBuf::from(fallback);
        if is_executable(&p) && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

async fn collect_from_shell(tc: &mut Toolchain, shell: &std::path::Path, script: &str) {
    // -lic: login so profile files apply, interactive so rc files do too. Both are
    // needed in practice — nvm lives in .zshrc, asdf often in .bash_profile.
    for arg in ["-lic", "-lc"] {
        let fut = tokio::process::Command::new(shell)
            .arg(arg)
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();

        // An interactive shell can hang on a misbehaving rc; that must not block
        // startup.
        let Ok(Ok(out)) = tokio::time::timeout(std::time::Duration::from_secs(6), fut).await else {
            continue;
        };

        let mut found_any = false;
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let p = PathBuf::from(line.trim());
            if !is_executable(&p) {
                continue;
            }
            if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                if TOOLS.contains(&name) {
                    tc.paths.entry(name.to_string()).or_insert(p);
                    found_any = true;
                }
            }
        }
        if found_any {
            return;
        }
    }
}

/// Install locations that exist independently of any shell configuration.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os("HOME").map(PathBuf::from);

    if let Some(h) = &home {
        // nvm: newest version first, so a stale old install does not win.
        dirs.extend(nvm_bin_dirs(h));
        dirs.push(h.join(".bun/bin"));
        dirs.push(h.join(".local/share/fnm/aliases/default/bin"));
        dirs.push(h.join(".asdf/shims"));
        dirs.push(h.join(".volta/bin"));
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(".cargo/bin"));
    }

    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/snap/bin"));

    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// `~/.nvm/versions/node/*/bin`, newest version first.
fn nvm_bin_dirs(home: &std::path::Path) -> Vec<PathBuf> {
    let root = home.join(".nvm/versions/node");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut versions: Vec<(Vec<u32>, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.join("bin").is_dir())
        .map(|p| {
            let name = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .trim_start_matches('v')
                .to_string();
            (parse_version(&name), p.join("bin"))
        })
        .collect();

    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, p)| p).collect()
}

/// Numeric comparison, so v9 does not sort above v24.
fn parse_version(name: &str) -> Vec<u32> {
    name.split('.').map(|x| x.parse().unwrap_or(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[test]
    fn versions_compare_numerically_not_lexically() {
        let mut v = vec![parse_version("9.5.0"), parse_version("24.12.0"), parse_version("20.1.0")];
        v.sort_by(|a, b| b.cmp(a));
        assert_eq!(v[0], vec![24, 12, 0]);
        assert_eq!(v[2], vec![9, 5, 0]);
    }

    #[test]
    fn junk_version_does_not_panic() {
        assert_eq!(parse_version("lts-hydrogen"), vec![0]);
    }
}

fn which(tool: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(tool))
        .find(|c| is_executable(c))
}

fn is_executable(p: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

async fn version_of(path: &std::path::Path, tool: &str, path_env: &str) -> Option<String> {
    let _ = tool;
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // npm/yarn need node reachable, even when called by absolute path.
    if !path_env.is_empty() {
        cmd.env("PATH", path_env);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(3), cmd.output())
    .await
    .ok()?
    .ok()?;

    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?.trim();
    if first.is_empty() {
        return None;
    }
    // "git version 2.55.0" -> "2.55.0"; "gh version 2.89.0 (…)" -> "2.89.0"
    let v = first
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or(first);
    Some(v.trim_start_matches('v').to_string())
}

/// Editors we offer an "open repo in…" action for.
///
/// Detected separately from TOOLS: these are user-facing choices, not things the
/// app depends on, and the list is intentionally broad.
pub const EDITORS: [(&str, &str); 11] = [
    ("code", "VS Code"),
    ("cursor", "Cursor"),
    ("antigravity-ide", "Antigravity"),
    ("windsurf", "Windsurf"),
    ("zed", "Zed"),
    ("code-insiders", "VS Code Insiders"),
    ("codium", "VSCodium"),
    ("subl", "Sublime Text"),
    ("idea", "IntelliJ IDEA"),
    ("webstorm", "WebStorm"),
    ("nvim", "Neovim"),
];

/// Resolved editors, in EDITORS order so the common ones come first.
pub fn detect_editors(path_env: &str) -> Vec<crate::model::EditorInfo> {
    // Search the augmented PATH, plus the places GUI installers use that are often
    // missing from a login shell's PATH.
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path_env).collect();
    for extra in ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/snap/bin"] {
        let p = PathBuf::from(extra);
        if p.is_dir() && !dirs.contains(&p) {
            dirs.push(p);
        }
    }

    EDITORS
        .iter()
        .filter_map(|(bin, label)| {
            dirs.iter().map(|d| d.join(bin)).find(|c| is_executable(c)).map(|p| {
                crate::model::EditorInfo {
                    id: (*bin).to_string(),
                    label: (*label).to_string(),
                    path: p.display().to_string(),
                }
            })
        })
        .collect()
}
