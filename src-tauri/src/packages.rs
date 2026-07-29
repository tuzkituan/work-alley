//! Install / upgrade / remove developer tooling.
//!
//! Two hard constraints shape this:
//!
//! 1. **A GUI cannot silently `sudo`.** Anything needing root is handed to a real
//!    terminal so the password prompt is visible and the user stays in control.
//!    Unprivileged operations stream into the output pane like any other run.
//!
//! 2. **`nvm` is not a binary.** It is a shell function defined by `nvm.sh`, so it
//!    only exists inside a shell that has sourced it. Those commands are therefore
//!    run as `$SHELL -lic '…'` rather than executed directly.

use crate::model::{Danger, PackageOp, PackageStatus, ToolPackage};
use crate::toolchain::Toolchain;
use std::path::PathBuf;

/// How a package is managed. Determines the command and whether root is needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    /// System packages. Needs root, so it goes to a terminal.
    Dnf,
    /// Node versions, via the nvm shell function.
    Nvm,
    /// Bun itself (`bun upgrade`).
    BunSelf,
    /// Global npm packages.
    NpmGlobal,
    /// Rust toolchain.
    Rustup,
    /// `cargo install`.
    Cargo,
}

impl Manager {
    pub fn id(&self) -> &'static str {
        match self {
            Manager::Dnf => "dnf",
            Manager::Nvm => "nvm",
            Manager::BunSelf => "bun",
            Manager::NpmGlobal => "npm",
            Manager::Rustup => "rustup",
            Manager::Cargo => "cargo",
        }
    }

    /// True when the operation must run as root, and therefore in a terminal.
    pub fn needs_root(&self) -> bool {
        matches!(self, Manager::Dnf)
    }
}

pub struct Entry {
    id: &'static str,
    pub label: &'static str,
    description: &'static str,
    group: &'static str,
    manager: Manager,
    /// Package name for the manager, when it differs from `id`.
    package: &'static str,
    /// Binary to probe for "is it installed", when it differs from `id`.
    bin: &'static str,
    /// Removal is not offered for things the app itself depends on.
    removable: bool,
}

/// A deliberately curated list. Not a package browser — the point is the tools a
/// web-dev workspace actually needs, with one obvious way to get each.
const CATALOG: &[Entry] = &[
    // --- runtimes -----------------------------------------------------------
    Entry { id: "node", label: "Node.js", description: "JavaScript runtime, installed as the latest LTS via nvm.", group: "Runtimes", manager: Manager::Nvm, package: "--lts", bin: "node", removable: false },
    Entry { id: "bun", label: "Bun", description: "The workspace's default package manager and runtime.", group: "Runtimes", manager: Manager::BunSelf, package: "bun", bin: "bun", removable: false },
    Entry { id: "pnpm", label: "pnpm", description: "Alternative Node package manager.", group: "Runtimes", manager: Manager::NpmGlobal, package: "pnpm", bin: "pnpm", removable: true },
    Entry { id: "yarn", label: "Yarn", description: "Node package manager used by a few repos here.", group: "Runtimes", manager: Manager::NpmGlobal, package: "yarn", bin: "yarn", removable: true },
    Entry { id: "rustup", label: "Rust toolchain", description: "rustc and cargo, managed by rustup.", group: "Runtimes", manager: Manager::Rustup, package: "stable", bin: "rustc", removable: false },

    // --- web dev ------------------------------------------------------------
    Entry { id: "typescript", label: "TypeScript", description: "The tsc compiler, available globally.", group: "Web dev", manager: Manager::NpmGlobal, package: "typescript", bin: "tsc", removable: true },
    Entry { id: "vercel", label: "Vercel CLI", description: "Deploy and manage Vercel projects.", group: "Web dev", manager: Manager::NpmGlobal, package: "vercel", bin: "vercel", removable: true },
    Entry { id: "firebase", label: "Firebase CLI", description: "Used by the hostapp for auth and hosting.", group: "Web dev", manager: Manager::NpmGlobal, package: "firebase-tools", bin: "firebase", removable: true },
    Entry { id: "serve", label: "serve", description: "Static file server for checking a build output.", group: "Web dev", manager: Manager::NpmGlobal, package: "serve", bin: "serve", removable: true },

    // --- git & github -------------------------------------------------------
    Entry { id: "git", label: "Git", description: "Required — the whole dashboard reads git state.", group: "Git", manager: Manager::Dnf, package: "git", bin: "git", removable: false },
    Entry { id: "gh", label: "GitHub CLI", description: "Powers the pull-request list on each repo.", group: "Git", manager: Manager::Dnf, package: "gh", bin: "gh", removable: true },
    Entry { id: "lazygit", label: "lazygit", description: "Terminal UI for git.", group: "Git", manager: Manager::Dnf, package: "lazygit", bin: "lazygit", removable: true },
    Entry { id: "delta", label: "delta", description: "Better git diffs in the terminal.", group: "Git", manager: Manager::Dnf, package: "git-delta", bin: "delta", removable: true },

    // --- shell --------------------------------------------------------------
    Entry { id: "zsh", label: "Zsh", description: "Shell. Work Alley probes it to find your tools.", group: "Shell", manager: Manager::Dnf, package: "zsh", bin: "zsh", removable: false },
    Entry { id: "fish", label: "Fish", description: "Friendly interactive shell.", group: "Shell", manager: Manager::Dnf, package: "fish", bin: "fish", removable: true },
    Entry { id: "starship", label: "Starship", description: "Cross-shell prompt.", group: "Shell", manager: Manager::Dnf, package: "starship", bin: "starship", removable: true },
    Entry { id: "tmux", label: "tmux", description: "Terminal multiplexer.", group: "Shell", manager: Manager::Dnf, package: "tmux", bin: "tmux", removable: true },

    // --- cli ----------------------------------------------------------------
    Entry { id: "ripgrep", label: "ripgrep", description: "Fast recursive search.", group: "CLI", manager: Manager::Dnf, package: "ripgrep", bin: "rg", removable: true },
    Entry { id: "fd", label: "fd", description: "Fast file finder.", group: "CLI", manager: Manager::Dnf, package: "fd-find", bin: "fd", removable: true },
    Entry { id: "fzf", label: "fzf", description: "Fuzzy finder.", group: "CLI", manager: Manager::Dnf, package: "fzf", bin: "fzf", removable: true },
    Entry { id: "jq", label: "jq", description: "JSON processor. verify-repos.sh needs it.", group: "CLI", manager: Manager::Dnf, package: "jq", bin: "jq", removable: false },
    Entry { id: "httpie", label: "HTTPie", description: "Human-friendly HTTP client.", group: "CLI", manager: Manager::Dnf, package: "httpie", bin: "http", removable: true },
    Entry { id: "neovim", label: "Neovim", description: "Terminal editor.", group: "CLI", manager: Manager::Dnf, package: "neovim", bin: "nvim", removable: true },

    // --- containers ---------------------------------------------------------
    Entry { id: "podman", label: "Podman", description: "Container runtime. Feeds the Local services panel.", group: "Containers", manager: Manager::Dnf, package: "podman", bin: "podman", removable: true },
    Entry { id: "docker", label: "Docker CLI", description: "Alternative container runtime.", group: "Containers", manager: Manager::Dnf, package: "docker", bin: "docker", removable: true },
];

pub fn find(id: &str) -> Option<&'static Entry> {
    CATALOG.iter().find(|e| e.id == id)
}

fn to_model(e: &Entry) -> ToolPackage {
    ToolPackage {
        id: e.id.to_string(),
        label: e.label.to_string(),
        description: e.description.to_string(),
        group: e.group.to_string(),
        manager: e.manager.id().to_string(),
        needs_root: e.manager.needs_root(),
        removable: e.removable,
    }
}

/// Detects what is installed, with versions.
///
/// Searches the augmented PATH plus the locations GUI/script installers use, since
/// a desktop-launched app inherits neither.
pub async fn list(tc: &Toolchain) -> Vec<PackageStatus> {
    let dirs = search_dirs(tc);
    let mut out = Vec::with_capacity(CATALOG.len());

    for e in CATALOG {
        let path = dirs
            .iter()
            .map(|d| d.join(e.bin))
            .find(|c| is_exec(c))
            .or_else(|| tc.path(e.bin).cloned());

        let version = match &path {
            Some(p) => version_of(p, &tc.path_env).await,
            None => None,
        };

        // nvm is a shell function, so its availability is the script's presence.
        let manager_available = match e.manager {
            Manager::Nvm => nvm_script().is_some(),
            Manager::Dnf => tc.has("dnf") || PathBuf::from("/usr/bin/dnf").is_file(),
            Manager::BunSelf => tc.has("bun"),
            Manager::NpmGlobal => tc.has("npm"),
            Manager::Rustup => which_in(&dirs, "rustup").is_some(),
            Manager::Cargo => which_in(&dirs, "cargo").is_some(),
        };

        out.push(PackageStatus {
            package: to_model(e),
            installed: path.is_some(),
            path: path.map(|p| p.display().to_string()),
            version,
            manager_available,
        });
    }

    out
}

fn search_dirs(tc: &Toolchain) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&tc.path_env).collect();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for extra in [".local/bin", ".cargo/bin", ".bun/bin"] {
            let p = home.join(extra);
            if p.is_dir() && !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }
    for extra in ["/usr/local/bin", "/usr/bin", "/snap/bin"] {
        let p = PathBuf::from(extra);
        if p.is_dir() && !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    dirs
}

fn which_in(dirs: &[PathBuf], bin: &str) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(bin)).find(|c| is_exec(c))
}

fn is_exec(p: &std::path::Path) -> bool {
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

pub fn nvm_script() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let p = home.join(".nvm/nvm.sh");
    p.is_file().then_some(p)
}

async fn version_of(path: &std::path::Path, path_env: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
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
    let v = first
        .split_whitespace()
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or(first);
    Some(v.trim_start_matches('v').to_string())
}

pub struct Plan {
    pub argv: Vec<String>,
    /// True when this must open a terminal instead of streaming.
    pub in_terminal: bool,
    pub danger: Danger,
    pub warnings: Vec<String>,
    pub typed_confirm: Option<String>,
    pub description: String,
}

/// Builds the command for an operation. Pure apart from resolving tool paths.
pub fn plan(tc: &Toolchain, id: &str, op: PackageOp) -> Result<Plan, String> {
    let e = find(id).ok_or_else(|| format!("unknown package '{id}'"))?;

    if op == PackageOp::Remove && !e.removable {
        return Err(format!(
            "{} is not removable from here — Work Alley depends on it",
            e.label
        ));
    }

    let mut warnings = Vec::new();
    let mut typed_confirm = None;

    if op == PackageOp::Remove {
        // Removing a system package can drag dependents with it, which is not
        // something to discover after the fact.
        warnings.push(format!(
            "Removing {} may also remove packages that depend on it.",
            e.label
        ));
        typed_confirm = Some("remove".to_string());
    }

    let (argv, in_terminal, description) = match e.manager {
        Manager::Dnf => {
            let verb = match op {
                PackageOp::Install => "install",
                PackageOp::Upgrade => "upgrade",
                PackageOp::Remove => "remove",
            };
            warnings.push("Runs in a terminal so you can enter your password.".into());
            (
                vec![
                    "sudo".to_string(),
                    "dnf".to_string(),
                    verb.to_string(),
                    "-y".to_string(),
                    e.package.to_string(),
                ],
                // Root is impossible to request from inside the app.
                true,
                format!("System package via dnf: {}", e.package),
            )
        }

        Manager::Nvm => {
            // nvm only exists inside a shell that sourced nvm.sh.
            let script = nvm_script().ok_or_else(|| {
                "nvm is not installed (~/.nvm/nvm.sh not found)".to_string()
            })?;
            let inner = match op {
                PackageOp::Install | PackageOp::Upgrade => {
                    // --lts installs the newest LTS; reinstall-packages carries the
                    // global npm packages over from the version being replaced.
                    "nvm install --lts --latest-npm && nvm alias default lts/* && nvm use default"
                        .to_string()
                }
                PackageOp::Remove => {
                    return Err("Removing Node would break the workspace's package managers. \
                                Uninstall a specific version with `nvm uninstall <version>`."
                        .into())
                }
            };
            let shell = shell_path();
            (
                vec![
                    shell,
                    "-lc".to_string(),
                    format!(". {} && {}", script.display(), inner),
                ],
                false,
                "Node LTS via nvm, kept as the default version.".to_string(),
            )
        }

        Manager::BunSelf => {
            let bun = tc
                .path("bun")
                .ok_or_else(|| "bun is not installed".to_string())?;
            match op {
                PackageOp::Install | PackageOp::Upgrade => (
                    vec![bun.display().to_string(), "upgrade".to_string()],
                    false,
                    "Bun upgrades itself in place.".to_string(),
                ),
                PackageOp::Remove => return Err("Bun cannot be removed from here".into()),
            }
        }

        Manager::NpmGlobal => {
            let npm = tc
                .path("npm")
                .ok_or_else(|| "npm is not installed".to_string())?;
            let args = match op {
                PackageOp::Install => vec![
                    "install".to_string(),
                    "-g".to_string(),
                    e.package.to_string(),
                ],
                PackageOp::Upgrade => vec![
                    "install".to_string(),
                    "-g".to_string(),
                    format!("{}@latest", e.package),
                ],
                PackageOp::Remove => vec![
                    "uninstall".to_string(),
                    "-g".to_string(),
                    e.package.to_string(),
                ],
            };
            let mut argv = vec![npm.display().to_string()];
            argv.extend(args);
            (
                argv,
                false,
                format!("Global npm package: {}", e.package),
            )
        }

        Manager::Rustup => {
            let rustup = which_in(&search_dirs(tc), "rustup")
                .ok_or_else(|| "rustup is not installed".to_string())?;
            match op {
                PackageOp::Install | PackageOp::Upgrade => (
                    vec![rustup.display().to_string(), "update".to_string()],
                    false,
                    "Updates the Rust toolchain.".to_string(),
                ),
                PackageOp::Remove => {
                    return Err("Removing the Rust toolchain would break this app's own build".into())
                }
            }
        }

        Manager::Cargo => {
            let cargo = which_in(&search_dirs(tc), "cargo")
                .ok_or_else(|| "cargo is not installed".to_string())?;
            let args = match op {
                PackageOp::Install | PackageOp::Upgrade => {
                    vec!["install".to_string(), e.package.to_string()]
                }
                PackageOp::Remove => vec!["uninstall".to_string(), e.package.to_string()],
            };
            let mut argv = vec![cargo.display().to_string()];
            argv.extend(args);
            (argv, false, format!("cargo package: {}", e.package))
        }
    };

    Ok(Plan {
        argv,
        in_terminal,
        danger: match op {
            PackageOp::Remove => Danger::High,
            PackageOp::Install | PackageOp::Upgrade if e.manager.needs_root() => Danger::Medium,
            _ => Danger::Low,
        },
        warnings,
        typed_confirm,
        description,
    })
}

fn shell_path() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tc() -> Toolchain {
        let mut t = Toolchain::default();
        t.paths.insert("npm".into(), PathBuf::from("/usr/bin/npm"));
        t.paths.insert("bun".into(), PathBuf::from("/usr/bin/bun"));
        t
    }

    #[test]
    fn dnf_operations_go_to_a_terminal() {
        let p = plan(&tc(), "ripgrep", PackageOp::Install).unwrap();
        assert!(p.in_terminal, "root operations cannot run inside the app");
        assert_eq!(p.argv[0], "sudo");
        assert!(p.argv.contains(&"ripgrep".to_string()));
    }

    #[test]
    fn npm_global_streams_without_a_terminal() {
        let p = plan(&tc(), "typescript", PackageOp::Upgrade).unwrap();
        assert!(!p.in_terminal);
        assert!(p.argv.contains(&"typescript@latest".to_string()));
    }

    #[test]
    fn removal_demands_a_typed_confirmation() {
        let p = plan(&tc(), "fzf", PackageOp::Remove).unwrap();
        assert_eq!(p.typed_confirm.as_deref(), Some("remove"));
        assert!(matches!(p.danger, Danger::High));
    }

    #[test]
    fn essentials_cannot_be_removed() {
        for id in ["git", "jq", "zsh", "node", "bun"] {
            assert!(
                plan(&tc(), id, PackageOp::Remove).is_err(),
                "{id} must not be removable"
            );
        }
    }

    #[test]
    fn unknown_package_is_rejected() {
        assert!(plan(&tc(), "definitely-not-real", PackageOp::Install).is_err());
    }

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|e| e.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate id in the catalog");
    }
}
