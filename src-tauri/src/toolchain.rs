use crate::model::{ContainerRuntime, ToolInfo};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;

/// The tools we resolve once at startup and then only ever invoke by absolute path.
///
/// A function rather than a constant because the list is not the same everywhere:
/// `ss` and `lsof` have no Windows equivalent — port inspection there goes through
/// `netstat`, which is always present and so never needs resolving. Leaving them in
/// would put two rows in the Toolbox that can never be anything but missing.
pub fn tools() -> &'static [&'static str] {
    // pnpm belongs here even though `preferred_package_manager` lists it: without a
    // resolved path, `require("pnpm")` fails for every repo whose lockfile or
    // `packageManager` field asks for it, and no script in it can be run at all.
    const COMMON: &[&str] = &[
        "git", "bun", "npm", "pnpm", "yarn", "node", "gh", "docker", "podman", "jq",
        // The non-JS runners `runner` builds argv for. A repo can be a Rust service or
        // a Django app, and without these resolved there is no way to start one — the
        // same reason the package managers are here rather than left to PATH.
        "cargo", "go", "python3", "python", "flutter", "dart",
        // The programs `chores` builds one-shot commands from. A repo can be a Gradle
        // module or a CocoaPods project, and the menu entry has to resolve to a real
        // path for the same reason every other tool here does.
        "gradle", "swift", "xcodebuild", "pod", "mvn", "composer", "php", "bundle", "mix",
        "dotnet", "cmake", "ctest",
    ];

    #[cfg(windows)]
    {
        COMMON
    }
    #[cfg(not(windows))]
    {
        // `ss` first, `lsof` as the fallback — see `platform::port_holders`.
        const UNIX: &[&str] = &["ss", "lsof"];
        static ALL: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
        ALL.get_or_init(|| COMMON.iter().chain(UNIX).copied().collect())
            .as_slice()
    }
}

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

    /// The Node package manager to use when a repo states no preference.
    ///
    /// Order is "fastest that is actually installed". Only consulted when a repo
    /// has neither a `packageManager` field nor a lockfile, so it never overrides
    /// what a repo asked for.
    pub fn preferred_package_manager(&self) -> Option<&'static str> {
        ["bun", "pnpm", "yarn", "npm"]
            .into_iter()
            .find(|m| self.has(m))
    }

    /// Prefer docker, fall back to podman. Either may be the only one present, so
    /// neither is treated as the special case.
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
        tools()
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
    let script = format!("command -v {} 2>/dev/null || true", tools().join(" "));

    // 1. The user's shell. `-i` as well as `-l`, because nvm is usually
    //    initialised in .zshrc / .bashrc — files a *non-interactive* login shell
    //    never reads. Using $SHELL matters: probing bash when the user runs zsh
    //    finds nothing at all.
    //
    //    Unix only, and not merely because Windows has no login shell. Under Git
    //    Bash this stage is actively *wrong*: `command -v git` answers
    //    `/mingw64/bin/git`, an MSYS path that `is_executable` rejects and
    //    `Command::new` cannot exec. Making it work would mean piping every result
    //    through `cygpath -m`, to recover paths that stages 2 and 3 already find
    //    correctly. Do not "fix" this by removing the gate.
    #[cfg(unix)]
    for sh in login_shells() {
        collect_from_shell(&mut tc, &sh, &script).await;
    }
    #[cfg(not(unix))]
    let _ = &script;

    // 2. Whatever we inherited.
    for &t in tools() {
        if !tc.paths.contains_key(t) {
            if let Some(p) = which(t) {
                tc.paths.insert(t.to_string(), p);
            }
        }
    }

    // 3. Well-known locations. This is the path that survives a desktop launcher
    //    with no shell involvement whatsoever.
    let dirs = crate::platform::tool_search_dirs();
    for dir in &dirs {
        for &t in tools() {
            if tc.paths.contains_key(t) {
                continue;
            }
            // `which_in` rather than `dir.join(t)`, so `git` finds `git.exe` and
            // `npm` finds `npm.cmd`.
            if let Some(cand) = crate::platform::which_in(std::slice::from_ref(dir), t) {
                tc.paths.insert(t.to_string(), cand);
            }
        }
    }

    // Pretend a tool is absent, for reviewing the not-ready paths on a machine that
    // has everything. Applied after resolution and before `path_env`, so a faked tool is
    // missing as far as every consumer is concerned.
    for t in fake_missing() {
        tc.paths.remove(&t);
    }

    tc.path_env = build_path_env(&tc.paths);

    // Concurrently, because this loop is on the startup path and each probe is a
    // process spawn with a 3s timeout. Serially, the cost was the *sum* of every
    // slow tool — and `flutter --version` alone can spend seconds rebuilding a
    // snapshot. Now the whole pass costs about as much as the slowest single tool.
    let mut probes = Vec::new();
    for &t in tools() {
        if let Some(p) = tc.paths.get(t).cloned() {
            let path_env = tc.path_env.clone();
            probes.push(tokio::spawn(async move {
                (t, version_of(&p, t, &path_env).await)
            }));
        }
    }
    for probe in probes {
        // A panicking probe must not take startup with it; a tool with no version
        // is already a state every consumer handles.
        if let Ok((t, Some(v))) = probe.await {
            tc.versions.insert(t.to_string(), v);
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
    // Unix only. On Windows the OpenSSH agent is a *service* reached over a named
    // pipe, and SSH_AUTH_SOCK is never set even when the agent is running and loaded
    // — so this would be a permanent, unactionable warning. `creds::status` probes
    // the agent properly there, by running `ssh-add -l` and reading the exit code.
    #[cfg(unix)]
    if std::env::var_os("SSH_AUTH_SOCK").is_none() {
        tc.warnings.push(
            "SSH_AUTH_SOCK is not set — git operations over SSH will fail. Start an ssh-agent and \
             relaunch."
                .into(),
        );
    }

    tc
}

/// Tools to treat as absent, from `WORK_ALLEY_FAKE_MISSING=git,node`.
///
/// The only practical way to see the first-run takeover, the error banner and the
/// blocked-step states on a development machine — each needs a tool to be genuinely
/// missing, and uninstalling git to check a banner is not reasonable.
///
/// An env var rather than `cfg(debug_assertions)`, because it is wanted in a release dev
/// build too. It only ever *removes*, so it cannot make a machine look more capable than
/// it is.
pub fn fake_missing() -> std::collections::BTreeSet<String> {
    std::env::var("WORK_ALLEY_FAKE_MISSING")
        .ok()
        .map(|v| parse_fake_missing(&v))
        .unwrap_or_default()
}

fn parse_fake_missing(raw: &str) -> std::collections::BTreeSet<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
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
///
/// Unix only; see the gate on stage 1 of `probe` for why Git Bash must not stand in
/// for this on Windows.
#[cfg(unix)]
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

#[cfg(unix)]
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
                if tools().contains(&name) {
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

/// Numeric comparison, so v9 does not sort above v24.
/// Only the unix nvm-directory scan needs this; `cfg(test)` keeps it covered.
#[cfg(any(unix, test))]
pub(crate) fn parse_version(name: &str) -> Vec<u32> {
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

// Both live in `platform` now: resolving a name to a program is the one thing
// Windows does completely differently, because the name on disk is `git.exe` and a
// bare `dir.join("git")` finds nothing at all.
use crate::platform::which;
// Only the login-shell probe uses this, and that is unix-only — see `probe`.
#[cfg(unix)]
use crate::platform::is_executable;

async fn version_of(path: &std::path::Path, tool: &str, path_env: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(path);
    crate::platform::hide_console(&mut cmd);
    // `go --version` is not a thing — the go toolchain spells it as a subcommand,
    // and asking the wrong way reports go as installed-but-versionless.
    cmd.arg(if tool == "go" { "version" } else { "--version" })
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
/// Detected separately from `tools()`: these are user-facing choices, not things the
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
    for p in crate::platform::gui_install_dirs() {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }

    EDITORS
        .iter()
        .filter_map(|(bin, label)| {
            // On Windows most of these are `code.cmd` or `<name>64.exe`, so the
            // extension search is what finds them at all.
            crate::platform::which_in(&dirs, bin).map(|p| crate::model::EditorInfo {
                id: (*bin).to_string(),
                label: (*label).to_string(),
                path: p.display().to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod fake_missing_tests {
    use super::parse_fake_missing;

    #[test]
    fn parses_a_list_with_whitespace() {
        let set = parse_fake_missing("git, node ,gh");
        assert!(set.contains("git") && set.contains("node") && set.contains("gh"));
        assert_eq!(set.len(), 3);
    }

    #[test]
    fn an_empty_or_ragged_value_fakes_nothing() {
        // A stray comma must not remove a tool named "".
        assert!(parse_fake_missing("").is_empty());
        assert!(parse_fake_missing(" , ,").is_empty());
    }

    #[test]
    fn an_unknown_name_is_harmless() {
        // It can only ever remove, so a typo costs nothing but the intended effect.
        let set = parse_fake_missing("nosuchtool");
        assert_eq!(set.len(), 1);
    }
}
