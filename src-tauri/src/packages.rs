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

use crate::model::{
    Danger, PackageOp, PackageStatus, PackageUpdate, PackageVersion, ToolPackage, UpdateReport,
};
use crate::toolchain::Toolchain;
use std::path::PathBuf;

/// The system package manager on this machine.
///
/// Detected at runtime. Hardcoding one would make the whole Toolbox useless to
/// anyone not on the same distribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemPm {
    Dnf,
    Apt,
    Pacman,
    Zypper,
    Apk,
    Brew,
}

impl SystemPm {
    pub fn id(&self) -> &'static str {
        match self {
            SystemPm::Dnf => "dnf",
            SystemPm::Apt => "apt-get",
            SystemPm::Pacman => "pacman",
            SystemPm::Zypper => "zypper",
            SystemPm::Apk => "apk",
            SystemPm::Brew => "brew",
        }
    }

    /// Homebrew refuses to run under sudo and installs into a user-owned prefix,
    /// so it is the one manager that needs no password and can stream in-app.
    pub fn needs_root(&self) -> bool {
        !matches!(self, SystemPm::Brew)
    }

    /// Arguments between the program and the package name.
    fn verb(&self, op: PackageOp) -> &'static [&'static str] {
        match (self, op) {
            (SystemPm::Dnf, PackageOp::Install) => &["install", "-y"],
            (SystemPm::Dnf, PackageOp::Upgrade) => &["upgrade", "-y"],
            (SystemPm::Dnf, PackageOp::Remove) => &["remove", "-y"],

            (SystemPm::Apt, PackageOp::Install) => &["install", "-y"],
            // `install --only-upgrade` upgrades just this package; a bare
            // `upgrade` would upgrade the entire system, which is not what the
            // button says it does.
            (SystemPm::Apt, PackageOp::Upgrade) => &["install", "-y", "--only-upgrade"],
            (SystemPm::Apt, PackageOp::Remove) => &["remove", "-y"],

            (SystemPm::Pacman, PackageOp::Install) => &["-S", "--needed", "--noconfirm"],
            (SystemPm::Pacman, PackageOp::Upgrade) => &["-S", "--noconfirm"],
            (SystemPm::Pacman, PackageOp::Remove) => &["-R", "--noconfirm"],

            (SystemPm::Zypper, PackageOp::Install) => &["--non-interactive", "install"],
            (SystemPm::Zypper, PackageOp::Upgrade) => &["--non-interactive", "update"],
            (SystemPm::Zypper, PackageOp::Remove) => &["--non-interactive", "remove"],

            (SystemPm::Apk, PackageOp::Install) => &["add"],
            (SystemPm::Apk, PackageOp::Upgrade) => &["add", "--upgrade"],
            (SystemPm::Apk, PackageOp::Remove) => &["del"],

            (SystemPm::Brew, PackageOp::Install) => &["install"],
            (SystemPm::Brew, PackageOp::Upgrade) => &["upgrade"],
            (SystemPm::Brew, PackageOp::Remove) => &["uninstall"],
        }
    }
}

/// The system package manager to use, preferring the distribution's own over
/// Homebrew when both are present.
pub fn detect_system_pm(tc: &Toolchain) -> Option<SystemPm> {
    let dirs = search_dirs(tc);
    [
        ("dnf", SystemPm::Dnf),
        ("apt-get", SystemPm::Apt),
        ("pacman", SystemPm::Pacman),
        ("zypper", SystemPm::Zypper),
        ("apk", SystemPm::Apk),
        ("brew", SystemPm::Brew),
    ]
    .into_iter()
    .find(|(bin, _)| which_in(&dirs, bin).is_some() || tc.has(bin))
    .map(|(_, pm)| pm)
}

/// How a package is managed. Determines the command and whether root is needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    /// Whatever system package manager this machine has. Usually needs root, so
    /// it goes to a terminal.
    System,
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
    /// Label shown on the row. The system manager reports its real name, so the
    /// user can see it is about to run dnf rather than apt.
    pub fn id(&self, sys: Option<SystemPm>) -> &'static str {
        match self {
            Manager::System => sys.map(|s| s.id()).unwrap_or("system"),
            Manager::Nvm => "nvm",
            Manager::BunSelf => "bun",
            Manager::NpmGlobal => "npm",
            Manager::Rustup => "rustup",
            Manager::Cargo => "cargo",
        }
    }

    /// True when the operation runs as root, so a password prompt is coming.
    pub fn needs_root(&self, sys: Option<SystemPm>) -> bool {
        match self {
            // Unknown manager: assume root, which is the safe assumption — it
            // sends the command to a terminal instead of failing silently.
            Manager::System => sys.map(|s| s.needs_root()).unwrap_or(true),
            _ => false,
        }
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
    /// Overrides `package` for managers that name it differently, keyed by the
    /// manager's own id. An empty name means "not packaged here", which produces
    /// a clear refusal instead of an install that cannot succeed.
    aliases: &'static [(&'static str, &'static str)],
    /// Binary to probe for "is it installed", when it differs from `id`.
    bin: &'static str,
    /// Removal is not offered for things the app itself depends on.
    removable: bool,
}

/// A deliberately curated list. Not a package browser — the point is the tools a
/// working repo actually needs, front end and back end, with one obvious way to
/// get each.
///
/// `package` is the name most managers use; `aliases` covers the ones that don't.
const CATALOG: &[Entry] = &[
    // --- runtimes -----------------------------------------------------------
    Entry { id: "node", label: "Node.js", description: "JavaScript runtime, installed as the latest LTS via nvm.", group: "Runtimes", manager: Manager::Nvm, package: "--lts", aliases: &[], bin: "node", removable: false },
    Entry { id: "bun", label: "Bun", description: "Fast JavaScript runtime and package manager.", group: "Runtimes", manager: Manager::BunSelf, package: "bun", aliases: &[], bin: "bun", removable: false },
    Entry { id: "pnpm", label: "pnpm", description: "Alternative Node package manager.", group: "Runtimes", manager: Manager::NpmGlobal, package: "pnpm", aliases: &[], bin: "pnpm", removable: true },
    Entry { id: "yarn", label: "Yarn", description: "Node package manager, for repos with a yarn.lock.", group: "Runtimes", manager: Manager::NpmGlobal, package: "yarn", aliases: &[], bin: "yarn", removable: true },
    Entry { id: "rustup", label: "Rust toolchain", description: "rustc and cargo, managed by rustup.", group: "Runtimes", manager: Manager::Rustup, package: "stable", aliases: &[], bin: "rustc", removable: false },

    // --- web dev ------------------------------------------------------------
    Entry { id: "typescript", label: "TypeScript", description: "The tsc compiler, available globally.", group: "Web dev", manager: Manager::NpmGlobal, package: "typescript", aliases: &[], bin: "tsc", removable: true },
    Entry { id: "vercel", label: "Vercel CLI", description: "Deploy and manage Vercel projects.", group: "Web dev", manager: Manager::NpmGlobal, package: "vercel", aliases: &[], bin: "vercel", removable: true },
    Entry { id: "firebase", label: "Firebase CLI", description: "Deploy and manage Firebase projects.", group: "Web dev", manager: Manager::NpmGlobal, package: "firebase-tools", aliases: &[], bin: "firebase", removable: true },
    Entry { id: "serve", label: "serve", description: "Static file server for checking a build output.", group: "Web dev", manager: Manager::NpmGlobal, package: "serve", aliases: &[], bin: "serve", removable: true },
    Entry { id: "nest", label: "NestJS CLI", description: "nest generate/build, for the backend services.", group: "Web dev", manager: Manager::NpmGlobal, package: "@nestjs/cli", aliases: &[], bin: "nest", removable: true },

    // --- git & github -------------------------------------------------------
    Entry { id: "git", label: "Git", description: "Required — the whole dashboard reads git state.", group: "Git", manager: Manager::System, package: "git", aliases: &[], bin: "git", removable: false },
    Entry { id: "gh", label: "GitHub CLI", description: "Powers the pull-request list on each repo.", group: "Git", manager: Manager::System, package: "gh", aliases: &[("pacman", "github-cli"), ("apk", "github-cli")], bin: "gh", removable: true },
    Entry { id: "lazygit", label: "lazygit", description: "Terminal UI for git.", group: "Git", manager: Manager::System, package: "lazygit", aliases: &[("apt-get", ""), ("zypper", "")], bin: "lazygit", removable: true },
    Entry { id: "delta", label: "delta", description: "Better git diffs in the terminal.", group: "Git", manager: Manager::System, package: "git-delta", aliases: &[("pacman", "git-delta"), ("apk", "delta"), ("brew", "git-delta")], bin: "delta", removable: true },

    // --- shell --------------------------------------------------------------
    Entry { id: "zsh", label: "Zsh", description: "Shell. Work Alley probes it to find your tools.", group: "Shell", manager: Manager::System, package: "zsh", aliases: &[], bin: "zsh", removable: false },
    Entry { id: "fish", label: "Fish", description: "Friendly interactive shell.", group: "Shell", manager: Manager::System, package: "fish", aliases: &[], bin: "fish", removable: true },
    Entry { id: "starship", label: "Starship", description: "Cross-shell prompt.", group: "Shell", manager: Manager::System, package: "starship", aliases: &[("apt-get", "")], bin: "starship", removable: true },
    Entry { id: "tmux", label: "tmux", description: "Terminal multiplexer.", group: "Shell", manager: Manager::System, package: "tmux", aliases: &[], bin: "tmux", removable: true },

    // --- cli ----------------------------------------------------------------
    Entry { id: "ripgrep", label: "ripgrep", description: "Fast recursive search.", group: "CLI", manager: Manager::System, package: "ripgrep", aliases: &[], bin: "rg", removable: true },
    Entry { id: "fd", label: "fd", description: "Fast file finder.", group: "CLI", manager: Manager::System, package: "fd-find", aliases: &[("pacman", "fd"), ("zypper", "fd"), ("apk", "fd"), ("brew", "fd")], bin: "fd", removable: true },
    Entry { id: "fzf", label: "fzf", description: "Fuzzy finder.", group: "CLI", manager: Manager::System, package: "fzf", aliases: &[], bin: "fzf", removable: true },
    Entry { id: "jq", label: "jq", description: "JSON processor. Some workspace scripts need it.", group: "CLI", manager: Manager::System, package: "jq", aliases: &[], bin: "jq", removable: false },
    Entry { id: "httpie", label: "HTTPie", description: "Human-friendly HTTP client.", group: "CLI", manager: Manager::System, package: "httpie", aliases: &[("brew", "httpie")], bin: "http", removable: true },
    Entry { id: "neovim", label: "Neovim", description: "Terminal editor.", group: "CLI", manager: Manager::System, package: "neovim", aliases: &[], bin: "nvim", removable: true },

    // --- backend languages --------------------------------------------------
    //
    // Names diverge more here than anywhere else, so an empty alias marks the
    // managers that do not package a tool at all rather than guessing a name and
    // producing an install that cannot succeed.
    Entry { id: "go", label: "Go", description: "Go toolchain, for Go services.", group: "Languages", manager: Manager::System, package: "golang", aliases: &[("apt-get", "golang-go"), ("pacman", "go"), ("zypper", "go"), ("apk", "go"), ("brew", "go")], bin: "go", removable: true },
    Entry { id: "python", label: "Python 3", description: "Python interpreter.", group: "Languages", manager: Manager::System, package: "python3", aliases: &[("pacman", "python"), ("brew", "python")], bin: "python3", removable: false },
    Entry { id: "php", label: "PHP", description: "PHP command-line interpreter.", group: "Languages", manager: Manager::System, package: "php-cli", aliases: &[("pacman", "php"), ("zypper", "php8-cli"), ("apk", "php"), ("brew", "php")], bin: "php", removable: true },
    Entry { id: "ruby", label: "Ruby", description: "Ruby interpreter.", group: "Languages", manager: Manager::System, package: "ruby", aliases: &[], bin: "ruby", removable: true },
    Entry { id: "jdk", label: "Java (JDK)", description: "Java compiler and runtime.", group: "Languages", manager: Manager::System, package: "java-latest-openjdk-devel", aliases: &[("apt-get", "default-jdk"), ("pacman", "jdk-openjdk"), ("zypper", "java-openjdk-devel"), ("apk", "openjdk17"), ("brew", "openjdk")], bin: "javac", removable: true },

    // --- python tooling -----------------------------------------------------
    Entry { id: "uv", label: "uv", description: "Fast Python package and project manager.", group: "Languages", manager: Manager::System, package: "uv", aliases: &[("apt-get", ""), ("zypper", ""), ("apk", "")], bin: "uv", removable: true },
    Entry { id: "pipx", label: "pipx", description: "Installs Python CLI tools in isolated environments.", group: "Languages", manager: Manager::System, package: "pipx", aliases: &[("pacman", "python-pipx"), ("apk", "")], bin: "pipx", removable: true },
    Entry { id: "poetry", label: "Poetry", description: "Python dependency management.", group: "Languages", manager: Manager::System, package: "poetry", aliases: &[("apt-get", "python3-poetry"), ("pacman", "python-poetry"), ("apk", "")], bin: "poetry", removable: true },

    // --- database clients ---------------------------------------------------
    //
    // Clients only, never servers: a dashboard should not be quietly installing a
    // daemon that then listens on a port.
    Entry { id: "psql", label: "PostgreSQL client", description: "psql, for connecting to Postgres.", group: "Databases", manager: Manager::System, package: "postgresql", aliases: &[("apt-get", "postgresql-client"), ("zypper", "postgresql"), ("apk", "postgresql-client"), ("brew", "libpq")], bin: "psql", removable: true },
    Entry { id: "mysql", label: "MySQL/MariaDB client", description: "mysql, for connecting to MySQL or MariaDB.", group: "Databases", manager: Manager::System, package: "mariadb", aliases: &[("apt-get", "mariadb-client"), ("pacman", "mariadb-clients"), ("apk", "mariadb-client"), ("brew", "mysql-client")], bin: "mysql", removable: true },
    Entry { id: "redis-cli", label: "Redis client", description: "redis-cli, for inspecting a Redis instance.", group: "Databases", manager: Manager::System, package: "redis", aliases: &[("apt-get", "redis-tools"), ("brew", "redis")], bin: "redis-cli", removable: true },
    Entry { id: "sqlite", label: "SQLite", description: "sqlite3 command-line shell.", group: "Databases", manager: Manager::System, package: "sqlite", aliases: &[("apt-get", "sqlite3")], bin: "sqlite3", removable: true },
    Entry { id: "mongosh", label: "MongoDB shell", description: "mongosh, installed globally through npm.", group: "Databases", manager: Manager::NpmGlobal, package: "mongosh", aliases: &[], bin: "mongosh", removable: true },
    Entry { id: "prisma", label: "Prisma CLI", description: "Migrations and schema tooling for Prisma.", group: "Databases", manager: Manager::NpmGlobal, package: "prisma", aliases: &[], bin: "prisma", removable: true },

    // --- api & service tooling ----------------------------------------------
    Entry { id: "curl", label: "curl", description: "HTTP client. A great many tools shell out to it.", group: "API", manager: Manager::System, package: "curl", aliases: &[], bin: "curl", removable: false },
    Entry { id: "yq", label: "yq", description: "YAML processor, the jq of config files.", group: "API", manager: Manager::System, package: "yq", aliases: &[("pacman", "go-yq")], bin: "yq", removable: true },
    Entry { id: "kcat", label: "kcat", description: "Produce to and consume from Kafka, without a JVM.", group: "API", manager: Manager::System, package: "kcat", aliases: &[("pacman", ""), ("zypper", "")], bin: "kcat", removable: true },
    Entry { id: "grpcurl", label: "grpcurl", description: "curl for gRPC services.", group: "API", manager: Manager::System, package: "grpcurl", aliases: &[("apt-get", ""), ("zypper", ""), ("apk", "")], bin: "grpcurl", removable: true },
    Entry { id: "pm2", label: "PM2", description: "Process manager for long-running Node services.", group: "API", manager: Manager::NpmGlobal, package: "pm2", aliases: &[], bin: "pm2", removable: true },
    Entry { id: "nodemon", label: "nodemon", description: "Restarts a Node process when files change.", group: "API", manager: Manager::NpmGlobal, package: "nodemon", aliases: &[], bin: "nodemon", removable: true },

    // --- build toolchain ----------------------------------------------------
    //
    // Native npm modules fall back to compiling from source, so a missing compiler
    // shows up as a confusing install failure rather than as a missing compiler.
    Entry { id: "make", label: "make", description: "Needed to build native dependencies.", group: "Build", manager: Manager::System, package: "make", aliases: &[], bin: "make", removable: true },
    Entry { id: "cc", label: "C/C++ compiler", description: "Needed to build native npm modules from source.", group: "Build", manager: Manager::System, package: "gcc", aliases: &[("apt-get", "build-essential"), ("pacman", "base-devel"), ("apk", "build-base"), ("brew", "")], bin: "gcc", removable: true },
    Entry { id: "cargo-watch", label: "cargo-watch", description: "Rebuilds a Rust service when files change.", group: "Build", manager: Manager::Cargo, package: "cargo-watch", aliases: &[], bin: "cargo-watch", removable: true },

    // --- kubernetes & cloud -------------------------------------------------
    Entry { id: "kubectl", label: "kubectl", description: "Kubernetes CLI.", group: "Cloud", manager: Manager::System, package: "kubernetes-client", aliases: &[("apt-get", ""), ("pacman", "kubectl"), ("apk", "kubectl"), ("brew", "kubernetes-cli")], bin: "kubectl", removable: true },
    Entry { id: "helm", label: "Helm", description: "Kubernetes package manager.", group: "Cloud", manager: Manager::System, package: "helm", aliases: &[("apt-get", ""), ("zypper", "")], bin: "helm", removable: true },
    Entry { id: "k9s", label: "k9s", description: "Terminal UI for a Kubernetes cluster.", group: "Cloud", manager: Manager::System, package: "k9s", aliases: &[("dnf", ""), ("apt-get", ""), ("zypper", "")], bin: "k9s", removable: true },
    Entry { id: "terraform", label: "Terraform", description: "Infrastructure as code.", group: "Cloud", manager: Manager::System, package: "terraform", aliases: &[("dnf", ""), ("apt-get", ""), ("zypper", "")], bin: "terraform", removable: true },
    Entry { id: "awscli", label: "AWS CLI", description: "Amazon Web Services CLI.", group: "Cloud", manager: Manager::System, package: "awscli2", aliases: &[("apt-get", "awscli"), ("pacman", "aws-cli-v2"), ("zypper", "aws-cli"), ("apk", "aws-cli"), ("brew", "awscli")], bin: "aws", removable: true },

    // --- containers ---------------------------------------------------------
    Entry { id: "podman", label: "Podman", description: "Container runtime. Feeds the Local services panel.", group: "Containers", manager: Manager::System, package: "podman", aliases: &[], bin: "podman", removable: true },
    Entry { id: "docker", label: "Docker CLI", description: "Container runtime. Feeds the Local services panel.", group: "Containers", manager: Manager::System, package: "docker", aliases: &[("apt-get", "docker.io")], bin: "docker", removable: true },
    Entry { id: "podman-compose", label: "podman-compose", description: "Runs a compose file against podman.", group: "Containers", manager: Manager::System, package: "podman-compose", aliases: &[("brew", ""), ("apk", "")], bin: "podman-compose", removable: true },
];

pub fn find(id: &str) -> Option<&'static Entry> {
    CATALOG.iter().find(|e| e.id == id)
}

fn to_model(e: &Entry, sys: Option<SystemPm>) -> ToolPackage {
    ToolPackage {
        id: e.id.to_string(),
        label: e.label.to_string(),
        description: e.description.to_string(),
        group: e.group.to_string(),
        manager: e.manager.id(sys).to_string(),
        needs_root: e.manager.needs_root(sys),
        removable: e.removable,
    }
}

/// The name this entry has under a given system package manager.
///
/// Returns None when it is not packaged there at all, so the UI can say so
/// instead of offering an install that is guaranteed to fail.
fn package_name(e: &Entry, sys: SystemPm) -> Option<&'static str> {
    match e.aliases.iter().find(|(m, _)| *m == sys.id()) {
        Some((_, "")) => None,
        Some((_, name)) => Some(name),
        None => Some(e.package),
    }
}

/// Detects what is installed, with versions.
///
/// Searches the augmented PATH plus the locations GUI/script installers use, since
/// a desktop-launched app inherits neither.
pub async fn list(tc: &Toolchain) -> Vec<PackageStatus> {
    let dirs = search_dirs(tc);
    let sys = detect_system_pm(tc);
    let mut out = Vec::with_capacity(CATALOG.len());

    for e in CATALOG {
        let path = which_in(&dirs, e.bin).or_else(|| tc.path(e.bin).cloned());

        let version = match &path {
            Some(p) => version_of(p, &tc.path_env).await,
            None => None,
        };

        // nvm is a shell function, so its availability is the script's presence.
        let manager_available = match e.manager {
            Manager::Nvm => nvm_script().is_some(),
            // Available only if we found a system manager *and* it packages this.
            Manager::System => sys.is_some_and(|s| package_name(e, s).is_some()),
            Manager::BunSelf => tc.has("bun"),
            Manager::NpmGlobal => tc.has("npm"),
            Manager::Rustup => which_in(&dirs, "rustup").is_some(),
            Manager::Cargo => which_in(&dirs, "cargo").is_some(),
        };

        out.push(PackageStatus {
            package: to_model(e, sys),
            installed: path.is_some(),
            path: path.map(|p| p.display().to_string()),
            version,
            manager_available,
        });
    }

    out
}

pub(crate) fn search_dirs(tc: &Toolchain) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&tc.path_env).collect();
    if let Some(home) = crate::platform::home_dir() {
        for extra in [".local/bin", ".cargo/bin", ".bun/bin"] {
            let p = home.join(extra);
            if p.is_dir() && !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }
    // The places an installer writes to that a login shell's PATH often misses —
    // on Windows that includes the WindowsApps aliases, which is where winget
    // itself lives.
    for p in crate::platform::gui_install_dirs() {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    dirs
}

// Extension-aware, so `winget` resolves to `winget.exe` and `npm` to `npm.cmd`.
pub(crate) use crate::platform::which_in;

pub fn nvm_script() -> Option<PathBuf> {
    let home = crate::platform::home_dir()?;
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

// --- version enumeration ----------------------------------------------------

/// Installable versions for one tool, newest first, capped.
///
/// Best-effort by design: every branch can return an empty list, and the UI then
/// offers only "whatever is current". A registry timeout must not make a row look
/// broken.
pub async fn versions(tc: &Toolchain, id: &str) -> Vec<PackageVersion> {
    let Some(e) = find(id) else {
        return Vec::new();
    };

    match e.manager {
        Manager::Nvm => node_versions().await,

        // Channels, not versions: pinning an exact toolchain is a per-project
        // concern that belongs in rust-toolchain.toml, not in a global install.
        Manager::Rustup => ["stable", "beta", "nightly"]
            .into_iter()
            .map(|c| PackageVersion {
                value: c.to_string(),
                label: c.to_string(),
                note: (c == "stable").then(|| "recommended".to_string()),
            })
            .collect(),

        Manager::NpmGlobal => npm_versions(tc, e.package).await,

        Manager::System => match detect_system_pm(tc) {
            Some(sys) => system_versions(tc, sys, e).await,
            None => Vec::new(),
        },

        // `bun upgrade` has no version argument, and cargo would need a registry
        // query this app has no business making.
        Manager::BunSelf | Manager::Cargo => Vec::new(),
    }
}

async fn node_versions() -> Vec<PackageVersion> {
    let Some(script) = nvm_script() else {
        return Vec::new();
    };
    let out = shell_capture(&format!(
        ". {} && nvm ls-remote --no-colors",
        script.display()
    ))
    .await;
    parse_nvm_ls_remote(&out)
}

/// Parses `nvm ls-remote`, keeping every LTS plus the newest few of anything.
///
/// The raw list is hundreds of releases going back to v0.1.14, which is not a menu
/// anyone can use. LTS lines are what people actually want, so those are kept in
/// full and the rest is trimmed to the recent tail.
pub fn parse_nvm_ls_remote(text: &str) -> Vec<PackageVersion> {
    let mut all: Vec<PackageVersion> = Vec::new();

    for line in text.lines() {
        // Lines look like "        v22.11.0   (LTS: Jasmine)", sometimes with a
        // leading "->" marking the version in use.
        let Some(tok) = line
            .split_whitespace()
            .find(|t| t.starts_with('v') && t[1..].starts_with(|c: char| c.is_ascii_digit()))
        else {
            continue;
        };
        let value = tok.trim_start_matches('v').to_string();
        let lts = line.contains("(LTS") || line.contains("(Latest LTS");
        all.push(PackageVersion {
            value: value.clone(),
            label: value,
            note: lts.then(|| "LTS".to_string()),
        });
    }

    all.reverse(); // newest first
    let mut out: Vec<PackageVersion> = Vec::new();
    for v in all {
        let is_lts = v.note.is_some();
        if is_lts || out.len() < 12 {
            out.push(v);
        }
        if out.len() >= 40 {
            break;
        }
    }
    out
}

async fn npm_versions(tc: &Toolchain, package: &str) -> Vec<PackageVersion> {
    let Some(npm) = tc.path("npm") else {
        return Vec::new();
    };
    let out = capture(
        npm,
        &["view", package, "versions", "--json"],
        &tc.path_env,
        std::time::Duration::from_secs(20),
    )
    .await;
    parse_npm_versions(&out)
}

/// `npm view <pkg> versions --json` prints a JSON array, oldest first.
pub fn parse_npm_versions(json: &str) -> Vec<PackageVersion> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    // A package with a single published version prints a bare string, not an array.
    let list: Vec<String> = match value {
        serde_json::Value::String(one) => vec![one],
        serde_json::Value::Array(a) => a
            .into_iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => return Vec::new(),
    };

    let mut out: Vec<PackageVersion> = list
        .into_iter()
        .rev()
        // Pre-releases are noise in a menu; someone who wants one can install it
        // from a terminal.
        .filter(|v| !v.contains('-'))
        .take(40)
        .map(|v| PackageVersion {
            value: v.clone(),
            label: v,
            note: None,
        })
        .collect();
    if let Some(first) = out.first_mut() {
        first.note = Some("latest".to_string());
    }
    out
}

async fn system_versions(tc: &Toolchain, sys: SystemPm, e: &Entry) -> Vec<PackageVersion> {
    let Some(name) = package_name(e, sys) else {
        return Vec::new();
    };
    let dirs = search_dirs(tc);
    let timeout = std::time::Duration::from_secs(20);

    match sys {
        SystemPm::Dnf => {
            let Some(bin) = which_in(&dirs, "dnf") else {
                return Vec::new();
            };
            let out = capture(
                &bin,
                &["--quiet", "list", "--showduplicates", name],
                &tc.path_env,
                timeout,
            )
            .await;
            parse_dnf_list(&out)
        }
        SystemPm::Apt => {
            let Some(bin) = which_in(&dirs, "apt-cache") else {
                return Vec::new();
            };
            let out = capture(&bin, &["madison", name], &tc.path_env, timeout).await;
            parse_apt_madison(&out)
        }
        // pacman and apk carry exactly one version of a package at a time, and
        // brew's versioned formulae are separate packages rather than a list.
        _ => Vec::new(),
    }
}

/// `dnf list --showduplicates` prints "name.arch  version-release  repo".
pub fn parse_dnf_list(text: &str) -> Vec<PackageVersion> {
    let mut out: Vec<PackageVersion> = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Three columns, and the first must look like a package, not a heading such
        // as "Available packages".
        if cols.len() != 3 || !cols[0].contains('.') {
            continue;
        }
        let version = cols[1].to_string();
        if out.iter().any(|v| v.value == version) {
            continue;
        }
        out.push(PackageVersion {
            value: version.clone(),
            label: version,
            note: None,
        });
    }
    // dnf lists oldest first.
    out.reverse();
    out.truncate(40);
    out
}

/// `apt-cache madison pkg` prints "pkg | 1.2.3-1 | http://… Packages".
pub fn parse_apt_madison(text: &str) -> Vec<PackageVersion> {
    let mut out: Vec<PackageVersion> = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split('|').map(|c| c.trim()).collect();
        if cols.len() < 3 || cols[1].is_empty() {
            continue;
        }
        let version = cols[1].to_string();
        if out.iter().any(|v| v.value == version) {
            continue;
        }
        out.push(PackageVersion {
            value: version.clone(),
            label: version,
            note: None,
        });
    }
    // madison is already newest first.
    out.truncate(40);
    out
}

// --- update checking --------------------------------------------------------

/// What every manager on this machine reports as upgradable.
///
/// One bulk query per manager rather than one per tool: `dnf check-update` answers
/// for all 30 system packages in a single call, and asking 30 times would be both
/// slow and rude to the mirror. Nothing here is fatal — a manager that cannot be
/// asked is simply left out of `checked`, and its rows keep the plain Upgrade
/// button instead of claiming to be current.
pub async fn updates(tc: &Toolchain) -> UpdateReport {
    let sys = detect_system_pm(tc);

    let (system, npm, rust, node) = tokio::join!(
        system_updates(tc, sys),
        npm_global_updates(tc),
        rustup_update(tc),
        node_update(tc),
    );

    let mut report = UpdateReport::default();

    for e in CATALOG {
        match e.manager {
            Manager::System => {
                let Some(found) = &system else { continue };
                let Some(name) = sys.and_then(|s| package_name(e, s)) else {
                    continue;
                };
                report.checked.push(e.id.to_string());
                if let Some((_, latest)) = found.iter().find(|(n, _)| n == name) {
                    report.updates.push(PackageUpdate {
                        id: e.id.to_string(),
                        latest: latest.clone(),
                    });
                }
            }
            Manager::NpmGlobal => {
                let Some(found) = &npm else { continue };
                report.checked.push(e.id.to_string());
                if let Some((_, latest)) = found.iter().find(|(n, _)| n == e.package) {
                    report.updates.push(PackageUpdate {
                        id: e.id.to_string(),
                        latest: latest.clone(),
                    });
                }
            }
            Manager::Rustup => {
                let Some(latest) = &rust else { continue };
                report.checked.push(e.id.to_string());
                if let Some(v) = latest {
                    report.updates.push(PackageUpdate {
                        id: e.id.to_string(),
                        latest: Some(v.clone()),
                    });
                }
            }
            Manager::Nvm => {
                let Some(latest) = &node else { continue };
                report.checked.push(e.id.to_string());
                if let Some(v) = latest {
                    report.updates.push(PackageUpdate {
                        id: e.id.to_string(),
                        latest: Some(v.clone()),
                    });
                }
            }
            // `bun upgrade` and `cargo install` decide for themselves whether there
            // is anything to do, and neither can be asked without doing it.
            Manager::BunSelf | Manager::Cargo => {}
        }
    }

    report
}

/// Upgradable system packages as (package name, new version). None = not asked.
async fn system_updates(
    tc: &Toolchain,
    sys: Option<SystemPm>,
) -> Option<Vec<(String, Option<String>)>> {
    let sys = sys?;
    let dirs = search_dirs(tc);
    let timeout = std::time::Duration::from_secs(45);

    match sys {
        SystemPm::Dnf => {
            let bin = which_in(&dirs, "dnf")?;
            // Exit 100 means "updates available" and 0 means "none" — anything else
            // is a real failure, and reading it as "up to date" would be a lie.
            let (out, code) =
                capture_status(&bin, &["--quiet", "check-update"], &tc.path_env, timeout).await;
            matches!(code, Some(0) | Some(100)).then(|| parse_dnf_check_update(&out))
        }
        SystemPm::Apt => {
            let bin = which_in(&dirs, "apt")?;
            let (out, code) =
                capture_status(&bin, &["list", "--upgradable"], &tc.path_env, timeout).await;
            (code == Some(0)).then(|| parse_apt_upgradable(&out))
        }
        SystemPm::Pacman => {
            let bin = which_in(&dirs, "pacman")?;
            // -Qu reads the local database, so it needs neither root nor a sync.
            // It exits 1 when nothing is upgradable.
            let (out, code) = capture_status(&bin, &["-Qu"], &tc.path_env, timeout).await;
            matches!(code, Some(0) | Some(1)).then(|| parse_pacman_qu(&out))
        }
        SystemPm::Zypper => {
            let bin = which_in(&dirs, "zypper")?;
            let (out, code) = capture_status(
                &bin,
                &["--non-interactive", "list-updates"],
                &tc.path_env,
                timeout,
            )
            .await;
            (code == Some(0)).then(|| parse_zypper_list_updates(&out))
        }
        SystemPm::Brew => {
            let bin = which_in(&dirs, "brew")?;
            let (out, code) =
                capture_status(&bin, &["outdated", "--verbose"], &tc.path_env, timeout).await;
            (code == Some(0)).then(|| parse_brew_outdated(&out))
        }
        // `apk version` reports every package's state in a format that needs the
        // package name split back out of "name-1.2.3-r0"; not worth guessing.
        SystemPm::Apk => None,
    }
}

/// `dnf check-update` prints "name.arch  new-version  repo" per upgradable package.
pub fn parse_dnf_check_update(text: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for line in text.lines() {
        // The obsoletes section that can follow is about replacements, not upgrades.
        if line.starts_with("Obsoleting") {
            break;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() != 3 || !cols[0].contains('.') {
            continue;
        }
        // "git.x86_64" -> "git". The arch is always the final dot-segment.
        let Some((name, _arch)) = cols[0].rsplit_once('.') else {
            continue;
        };
        out.push((name.to_string(), Some(cols[1].to_string())));
    }
    out
}

/// `apt list --upgradable` prints "name/suite 1.2.3 arch [upgradable from: 1.2.2]".
pub fn parse_apt_upgradable(text: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 2 {
            continue;
        }
        let Some((name, _suite)) = cols[0].split_once('/') else {
            continue;
        };
        out.push((name.to_string(), Some(cols[1].to_string())));
    }
    out
}

/// `pacman -Qu` prints "name 1.0-1 -> 1.1-1".
pub fn parse_pacman_qu(text: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 || cols[2] != "->" {
            continue;
        }
        out.push((cols[0].to_string(), Some(cols[3].to_string())));
    }
    out
}

/// `zypper list-updates` prints a table: "v | repo | name | current | available | arch".
pub fn parse_zypper_list_updates(text: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split('|').map(|c| c.trim()).collect();
        // The header row names its own columns, which is how it is recognised.
        if cols.len() < 5 || cols[0] != "v" || cols[2] == "Name" {
            continue;
        }
        out.push((cols[2].to_string(), Some(cols[4].to_string())));
    }
    out
}

/// `brew outdated --verbose` prints "name (1.2.2) < 1.2.3".
pub fn parse_brew_outdated(text: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let Some(name) = cols.first() else { continue };
        // Casks print as "name (1.2.2) != 1.2.3"; either arrow leaves the new
        // version last, and a bare name is still a usable "outdated".
        let latest = (cols.len() >= 4).then(|| cols[cols.len() - 1].to_string());
        out.push((name.to_string(), latest));
    }
    out
}

/// Outdated global npm packages. None = npm could not be asked.
async fn npm_global_updates(tc: &Toolchain) -> Option<Vec<(String, Option<String>)>> {
    let npm = tc.path("npm")?;
    // npm exits 1 when anything is outdated, which is not an error here.
    let (out, code) = capture_status(
        npm,
        &["outdated", "-g", "--json"],
        &tc.path_env,
        std::time::Duration::from_secs(45),
    )
    .await;
    if !matches!(code, Some(0) | Some(1)) {
        return None;
    }
    parse_npm_outdated(&out)
}

/// `npm outdated -g --json` prints `{"pnpm":{"current":"9.0.0","latest":"9.5.0"}}`,
/// and `{}` when everything is current. Anything else means npm did not answer.
pub fn parse_npm_outdated(json: &str) -> Option<Vec<(String, Option<String>)>> {
    let obj = serde_json::from_str::<serde_json::Value>(json.trim())
        .ok()?
        .as_object()?
        .clone();
    Some(
        obj.into_iter()
            .filter_map(|(name, v)| {
                let latest = v.get("latest").and_then(|l| l.as_str()).map(String::from);
                let current = v.get("current").and_then(|c| c.as_str());
                // A package npm reports with no installed version is not something
                // this machine can upgrade.
                match (current, &latest) {
                    // Identical versions do happen, for packages installed from a
                    // tag; those are not an upgrade.
                    (Some(c), Some(l)) if c == l => None,
                    (Some(_), _) => Some((name, latest)),
                    _ => None,
                }
            })
            .collect(),
    )
}

/// The new rustc version, if any. Outer None = rustup could not be asked.
async fn rustup_update(tc: &Toolchain) -> Option<Option<String>> {
    let dirs = search_dirs(tc);
    let bin = which_in(&dirs, "rustup")?;
    let (out, code) = capture_status(
        &bin,
        &["check"],
        &tc.path_env,
        std::time::Duration::from_secs(45),
    )
    .await;
    // 100 is rustup's "something is out of date", the same convention dnf uses.
    matches!(code, Some(0) | Some(100)).then(|| parse_rustup_check(&out))
}

/// The new toolchain version from `rustup check`, which prints one line per
/// component:
///
/// ```text
/// stable-x86_64-unknown-linux-gnu - update available: 1.96.0 (ac68faa20 2026-05-25) -> 1.97.1 (8bab26f4f 2026-07-14)
/// rustup - up to date : 1.29.0
/// ```
///
/// Only the toolchain line matters — rustup upgrading itself is not what the row's
/// version shows. Case is not load-bearing: older releases capitalise the label.
pub fn parse_rustup_check(text: &str) -> Option<String> {
    for line in text.lines() {
        if line.starts_with("rustup") || !line.to_ascii_lowercase().contains("update available") {
            continue;
        }
        // The token straight after the arrow, not the last one on the line: current
        // rustup appends a commit hash and date to each version.
        if let Some(v) = line
            .split_whitespace()
            .skip_while(|t| *t != "->")
            .nth(1)
        {
            return Some(v.to_string());
        }
    }
    None
}

/// The newest Node LTS, when it is newer than the installed one.
///
/// Node is the one tool whose "latest" has to be worked out rather than reported:
/// nvm lists what it could install but says nothing about what is in use, so the
/// comparison happens here.
async fn node_update(tc: &Toolchain) -> Option<Option<String>> {
    let dirs = search_dirs(tc);
    let node = which_in(&dirs, "node").or_else(|| tc.path("node").cloned())?;
    let current = version_of(&node, &tc.path_env).await?;
    let latest = node_versions()
        .await
        .into_iter()
        .find(|v| v.note.is_some())?
        .value;

    let (cur, new) = (
        semver::Version::parse(&current).ok()?,
        semver::Version::parse(&latest).ok()?,
    );
    // Someone on a newer non-LTS release is not behind.
    Some((new > cur).then_some(latest))
}

async fn capture(
    program: &std::path::Path,
    args: &[&str],
    path_env: &str,
    timeout: std::time::Duration,
) -> String {
    capture_status(program, args, path_env, timeout).await.0
}

/// `capture`, plus the exit code — None on a timeout or a spawn failure.
///
/// The code is what separates "nothing to upgrade" from "the mirror is
/// unreachable" for most managers, and both print nothing on stdout.
async fn capture_status(
    program: &std::path::Path,
    args: &[&str],
    path_env: &str,
    timeout: std::time::Duration,
) -> (String, Option<i32>) {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    if !path_env.is_empty() {
        cmd.env("PATH", path_env);
    }
    // Same hardening as every other child: never let one sit waiting on a prompt.
    cmd.env("NO_COLOR", "1").env("CI", "1");

    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(out)) => (
            String::from_utf8_lossy(&out.stdout).into_owned(),
            out.status.code(),
        ),
        _ => (String::new(), None),
    }
}

/// For nvm, which only exists inside a shell that has sourced nvm.sh.
async fn shell_capture(script: &str) -> String {
    let Ok(argv) = login_shell_script(script) else {
        return String::new();
    };
    let (prog, args) = argv.split_first().expect("argv is never empty");
    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    match tokio::time::timeout(std::time::Duration::from_secs(25), cmd.output()).await {
        Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    }
}

#[derive(Debug)]
pub struct Plan {
    pub argv: Vec<String>,
    /// True when this needs root, and so a tty and a password prompt. Every
    /// package operation runs in the integrated terminal now, so this is no longer
    /// a routing decision — only a warning the confirmation dialog repeats.
    pub in_terminal: bool,
    pub danger: Danger,
    pub warnings: Vec<String>,
    pub typed_confirm: Option<String>,
    pub description: String,
}

/// Builds the command for an operation, detecting the system package manager.
pub fn plan(
    tc: &Toolchain,
    id: &str,
    op: PackageOp,
    version: Option<&str>,
) -> Result<Plan, String> {
    plan_with_version(tc, detect_system_pm(tc), id, op, version)
}

/// The real implementation, with the system manager passed in.
///
/// Split out so it can be tested against every manager rather than only whichever
/// one the test machine happens to run.
pub fn plan_with(
    tc: &Toolchain,
    sys: Option<SystemPm>,
    id: &str,
    op: PackageOp,
) -> Result<Plan, String> {
    plan_with_version(tc, sys, id, op, None)
}

pub fn plan_with_version(
    tc: &Toolchain,
    sys: Option<SystemPm>,
    id: &str,
    op: PackageOp,
    version: Option<&str>,
) -> Result<Plan, String> {
    let e = find(id).ok_or_else(|| format!("unknown package '{id}'"))?;

    // A version only ever means something when installing or upgrading; asking to
    // remove "version 3" of something is not a thing any of these managers do.
    let version = version.filter(|v| !v.is_empty() && op != PackageOp::Remove);

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
        Manager::System => {
            let sys = sys.ok_or_else(|| {
                "no system package manager found (looked for dnf, apt-get, pacman, \
                 zypper, apk and brew)"
                    .to_string()
            })?;
            let name = package_name(e, sys).ok_or_else(|| {
                format!("{} is not available through {}", e.label, sys.id())
            })?;

            // Pinning syntax differs per manager, and two of them have none at all:
            // pacman and apk track a single rolling version, so a pin request has to
            // be refused rather than silently ignored.
            let target = match (version, sys) {
                (None, _) => name.to_string(),
                (Some(v), SystemPm::Dnf | SystemPm::Zypper) => format!("{name}-{v}"),
                (Some(v), SystemPm::Apt) => format!("{name}={v}"),
                (Some(v), SystemPm::Brew) => format!("{name}@{v}"),
                (Some(_), SystemPm::Pacman | SystemPm::Apk) => {
                    return Err(format!(
                        "{} installs whatever version it currently has — it cannot pin one",
                        sys.id()
                    ))
                }
            };

            let mut argv: Vec<String> = Vec::new();
            // Homebrew refuses to run as root; everything else needs it.
            if sys.needs_root() {
                argv.push("sudo".to_string());
                warnings.push("Runs in the integrated terminal, where you can enter your password.".into());
            }
            argv.push(sys.id().to_string());
            argv.extend(sys.verb(op).iter().map(|a| a.to_string()));
            argv.push(target.clone());

            (
                argv,
                // Root cannot be requested from inside the app, so those go to a
                // terminal. Homebrew can stream like any other run.
                sys.needs_root(),
                format!("System package via {}: {}", sys.id(), target),
            )
        }

        Manager::Nvm => {
            // nvm only exists inside a shell that sourced nvm.sh.
            let script = nvm_script().ok_or_else(|| {
                "nvm is not installed (~/.nvm/nvm.sh not found)".to_string()
            })?;
            let inner = match op {
                PackageOp::Install | PackageOp::Upgrade => match version {
                    // An explicit version becomes the default too, or installing it
                    // would appear to do nothing: `node -v` would still report the
                    // old one.
                    Some(v) => format!(
                        "nvm install {v} && nvm alias default {v} && nvm use default"
                    ),
                    // --lts installs the newest LTS; --latest-npm brings npm with it.
                    None => "nvm install --lts --latest-npm && nvm alias default lts/* \
                             && nvm use default"
                        .to_string(),
                },
                PackageOp::Remove => {
                    return Err("Removing Node would break the workspace's package managers. \
                                Uninstall a specific version with `nvm uninstall <version>`."
                        .into())
                }
            };
            (
                login_shell_script(&format!(". {} && {}", script.display(), inner))?,
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
            // `@latest` unless a version was chosen. npm resolves the tag itself, so
            // this is the one manager where pinning needs no special syntax.
            let spec = match version {
                Some(v) => format!("{}@{v}", e.package),
                None => format!("{}@latest", e.package),
            };
            let args = match op {
                PackageOp::Install => vec!["install".to_string(), "-g".to_string(), spec.clone()],
                PackageOp::Upgrade => vec!["install".to_string(), "-g".to_string(), spec.clone()],
                PackageOp::Remove => vec![
                    "uninstall".to_string(),
                    "-g".to_string(),
                    e.package.to_string(),
                ],
            };
            let mut argv = vec![npm.display().to_string()];
            argv.extend(args);
            (argv, false, format!("Global npm package: {spec}"))
        }

        Manager::Rustup => {
            let rustup = which_in(&search_dirs(tc), "rustup")
                .ok_or_else(|| "rustup is not installed".to_string())?;
            match op {
                PackageOp::Install | PackageOp::Upgrade => {
                    // `rustup update <channel>` both installs and updates, so the
                    // same command covers a fresh install and a version switch.
                    let channel = version.unwrap_or("stable");
                    (
                        vec![
                            rustup.display().to_string(),
                            "update".to_string(),
                            channel.to_string(),
                        ],
                        false,
                        format!("Installs or updates the Rust {channel} toolchain."),
                    )
                }
                PackageOp::Remove => {
                    return Err("Removing the Rust toolchain would break this app's own build".into())
                }
            }
        }

        Manager::Cargo => {
            let cargo = which_in(&search_dirs(tc), "cargo")
                .ok_or_else(|| "cargo is not installed".to_string())?;
            let args = match op {
                PackageOp::Install | PackageOp::Upgrade => match version {
                    Some(v) => vec![
                        "install".to_string(),
                        e.package.to_string(),
                        "--version".to_string(),
                        v.to_string(),
                    ],
                    None => vec!["install".to_string(), e.package.to_string()],
                },
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
            PackageOp::Install | PackageOp::Upgrade
                if e.manager.needs_root(sys) =>
            {
                Danger::Medium
            }
            _ => Danger::Low,
        },
        warnings,
        typed_confirm,
        description,
    })
}

/// One command that installs several catalog entries through the system package
/// manager.
///
/// A setup step means "make these five things exist". Doing that as five separate
/// installs means five terminal tabs and five password prompts, which is how a
/// ten-minute setup becomes a chore. One command is one prompt.
pub fn plan_system_group(tc: &Toolchain, ids: &[&str]) -> Result<Plan, String> {
    plan_system_group_with(detect_system_pm(tc), ids)
}

/// The real implementation, with the system manager passed in so it can be tested
/// against every distribution rather than only the one running the tests.
pub fn plan_system_group_with(sys: Option<SystemPm>, ids: &[&str]) -> Result<Plan, String> {
    let sys = sys.ok_or_else(|| {
        "no system package manager found (looked for dnf, apt-get, pacman, zypper, \
         apk and brew)"
            .to_string()
    })?;

    let mut names: Vec<String> = Vec::new();
    let mut skipped: Vec<&str> = Vec::new();
    for id in ids {
        let e = find(id).ok_or_else(|| format!("unknown package '{id}'"))?;
        match package_name(e, sys) {
            Some(name) => {
                // The same package can back two catalog ids (gcc for a compiler and
                // for make on some distributions); installing it twice in one
                // command is a manager error on pacman.
                if !names.iter().any(|n| n == name) {
                    names.push(name.to_string());
                }
            }
            None => skipped.push(e.label),
        }
    }

    if names.is_empty() {
        return Err(format!(
            "{} does not package any of these — install them another way",
            sys.id()
        ));
    }

    let mut warnings = Vec::new();
    let mut argv: Vec<String> = Vec::new();
    if sys.needs_root() {
        argv.push("sudo".to_string());
        warnings.push("Runs in the integrated terminal, where you can enter your password.".into());
    }
    argv.push(sys.id().to_string());
    argv.extend(sys.verb(PackageOp::Install).iter().map(|a| a.to_string()));
    argv.extend(names.iter().cloned());

    if !skipped.is_empty() {
        // Named rather than silently dropped: "why is delta still missing" is a
        // question the page should already have answered.
        warnings.push(format!(
            "{} does not package {} — that one is skipped.",
            sys.id(),
            skipped.join(", ")
        ));
    }

    Ok(Plan {
        argv,
        in_terminal: sys.needs_root(),
        danger: Danger::Medium,
        warnings,
        typed_confirm: None,
        description: format!("System packages via {}: {}", sys.id(), names.join(" ")),
    })
}

/// One `npm install -g` for several catalog entries.
pub fn plan_npm_group(tc: &Toolchain, ids: &[&str]) -> Result<Plan, String> {
    let npm = tc
        .path("npm")
        .ok_or_else(|| "npm is not installed — install Node first".to_string())?;

    let mut specs: Vec<String> = Vec::new();
    for id in ids {
        let e = find(id).ok_or_else(|| format!("unknown package '{id}'"))?;
        specs.push(format!("{}@latest", e.package));
    }
    if specs.is_empty() {
        return Err("nothing to install".to_string());
    }

    let mut argv = vec![npm.display().to_string(), "install".to_string(), "-g".to_string()];
    argv.extend(specs.iter().cloned());

    Ok(Plan {
        argv,
        in_terminal: false,
        danger: Danger::Low,
        warnings: vec![],
        typed_confirm: None,
        description: format!("Global npm packages: {}", specs.join(" ")),
    })
}

/// The argv to run `script` in the user's login shell.
///
/// An error rather than a `/bin/bash` fallback: on Windows there is no such path,
/// and a plan whose argv[0] does not exist fails at spawn time with an ENOENT that
/// names nothing the user can act on.
pub fn login_shell_script(script: &str) -> Result<Vec<String>, String> {
    crate::platform::shell()
        .map(|sh| sh.login_script_argv(script))
        .ok_or_else(|| {
            "no shell was found — install Git for Windows, which provides Git Bash".to_string()
        })
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

    /// `plan_with` rather than `plan`, so the result does not depend on which
    /// distribution the test happens to run on.
    fn sys_plan(sys: SystemPm, id: &str, op: PackageOp) -> Plan {
        plan_with(&tc(), Some(sys), id, op).unwrap()
    }

    #[test]
    fn every_system_manager_produces_a_privileged_install() {
        for sys in [
            SystemPm::Dnf,
            SystemPm::Apt,
            SystemPm::Pacman,
            SystemPm::Zypper,
            SystemPm::Apk,
        ] {
            let p = sys_plan(sys, "ripgrep", PackageOp::Install);
            assert!(p.in_terminal, "{sys:?}: root operations cannot run in-app");
            assert_eq!(p.argv[0], "sudo", "{sys:?}");
            assert_eq!(p.argv[1], sys.id(), "{sys:?}");
            assert_eq!(p.argv.last().unwrap(), "ripgrep", "{sys:?}");
        }
    }

    #[test]
    fn homebrew_neither_sudos_nor_needs_a_terminal() {
        let p = sys_plan(SystemPm::Brew, "ripgrep", PackageOp::Install);
        assert_eq!(p.argv[0], "brew", "brew refuses to run under sudo");
        assert!(!p.in_terminal, "no password prompt, so it can stream in-app");
    }

    #[test]
    fn per_manager_package_names_are_honoured() {
        // The same tool is named differently by different managers.
        assert_eq!(sys_plan(SystemPm::Dnf, "fd", PackageOp::Install).argv.last().unwrap(), "fd-find");
        assert_eq!(sys_plan(SystemPm::Pacman, "fd", PackageOp::Install).argv.last().unwrap(), "fd");
        assert_eq!(sys_plan(SystemPm::Apt, "docker", PackageOp::Install).argv.last().unwrap(), "docker.io");
        assert_eq!(sys_plan(SystemPm::Pacman, "gh", PackageOp::Install).argv.last().unwrap(), "github-cli");
    }

    #[test]
    fn upgrading_one_package_never_upgrades_the_whole_system() {
        // A bare `apt-get upgrade` would upgrade everything, which is not what an
        // "Upgrade" button next to one package promises.
        let p = sys_plan(SystemPm::Apt, "ripgrep", PackageOp::Upgrade);
        assert!(p.argv.contains(&"--only-upgrade".to_string()));
        assert!(!p.argv.contains(&"upgrade".to_string()));
    }

    #[test]
    fn a_tool_the_manager_does_not_package_is_refused() {
        // Better a clear refusal than an install command that cannot succeed.
        let err = plan_with(&tc(), Some(SystemPm::Apt), "lazygit", PackageOp::Install)
            .expect_err("apt does not package lazygit");
        assert!(err.contains("apt-get"), "the error should name the manager: {err}");
    }

    #[test]
    fn with_no_system_manager_at_all_the_error_says_so() {
        let err = plan_with(&tc(), None, "ripgrep", PackageOp::Install).unwrap_err();
        assert!(err.contains("no system package manager"), "got: {err}");
    }

    #[test]
    fn npm_global_streams_without_a_terminal() {
        let p = plan_with(&tc(), Some(SystemPm::Dnf), "typescript", PackageOp::Upgrade).unwrap();
        assert!(!p.in_terminal);
        assert!(p.argv.contains(&"typescript@latest".to_string()));
    }

    #[test]
    fn removal_demands_a_typed_confirmation() {
        let p = sys_plan(SystemPm::Dnf, "fzf", PackageOp::Remove);
        assert_eq!(p.typed_confirm.as_deref(), Some("remove"));
        assert!(matches!(p.danger, Danger::High));
    }

    #[test]
    fn essentials_cannot_be_removed() {
        for id in ["git", "jq", "zsh", "node", "bun"] {
            assert!(
                plan_with(&tc(), Some(SystemPm::Dnf), id, PackageOp::Remove).is_err(),
                "{id} must not be removable"
            );
        }
    }

    #[test]
    fn unknown_package_is_rejected() {
        assert!(plan_with(&tc(), Some(SystemPm::Dnf), "definitely-not-real", PackageOp::Install).is_err());
    }

    #[test]
    fn a_chosen_version_reaches_the_command_in_each_manager_s_own_syntax() {
        let v = Some("1.2.3");
        assert!(plan_with_version(&tc(), Some(SystemPm::Dnf), "ripgrep", PackageOp::Install, v)
            .unwrap()
            .argv
            .contains(&"ripgrep-1.2.3".to_string()));
        assert!(plan_with_version(&tc(), Some(SystemPm::Apt), "ripgrep", PackageOp::Install, v)
            .unwrap()
            .argv
            .contains(&"ripgrep=1.2.3".to_string()));
        assert!(plan_with_version(&tc(), Some(SystemPm::Dnf), "typescript", PackageOp::Install, v)
            .unwrap()
            .argv
            .contains(&"typescript@1.2.3".to_string()));
    }

    #[test]
    fn a_manager_that_cannot_pin_says_so_instead_of_ignoring_the_request() {
        // pacman and apk carry one version at a time. Silently installing a
        // different version than the one asked for is the worst option here.
        for sys in [SystemPm::Pacman, SystemPm::Apk] {
            let err = plan_with_version(&tc(), Some(sys), "ripgrep", PackageOp::Install, Some("1.0"))
                .expect_err("{sys:?} cannot pin");
            assert!(err.contains("cannot pin"), "{sys:?}: {err}");
        }
    }

    #[test]
    fn a_version_is_ignored_when_removing() {
        // "remove version 3" is not an operation any of these managers has.
        let p = plan_with_version(&tc(), Some(SystemPm::Dnf), "fzf", PackageOp::Remove, Some("1.0"))
            .unwrap();
        assert!(p.argv.contains(&"fzf".to_string()));
        assert!(!p.argv.iter().any(|a| a.contains("1.0")));
    }

    #[test]
    fn parses_nvm_ls_remote_keeping_every_lts() {
        let out = "\
        v18.20.0   (LTS: Hydrogen)
        v19.0.0
        v20.11.1   (LTS: Iron)
        v21.7.0
        v22.11.0   (LTS: Jasmine)
->      v24.12.0 *";
        let vs = parse_nvm_ls_remote(out);
        // Newest first, and the arrow-marked current version is not mangled.
        assert_eq!(vs[0].value, "24.12.0");
        let lts: Vec<&str> = vs.iter().filter(|v| v.note.is_some()).map(|v| v.value.as_str()).collect();
        assert_eq!(lts, ["22.11.0", "20.11.1", "18.20.0"]);
    }

    #[test]
    fn parses_npm_versions_newest_first_without_prereleases() {
        let vs = parse_npm_versions(r#"["1.0.0","1.1.0","2.0.0-beta.1","2.0.0"]"#);
        assert_eq!(
            vs.iter().map(|v| v.value.as_str()).collect::<Vec<_>>(),
            ["2.0.0", "1.1.0", "1.0.0"]
        );
        assert_eq!(vs[0].note.as_deref(), Some("latest"));
        // A single-version package prints a bare string, not an array.
        assert_eq!(parse_npm_versions(r#""1.0.0""#).len(), 1);
        assert_eq!(parse_npm_versions("not json").len(), 0);
    }

    #[test]
    fn parses_dnf_and_apt_version_listings() {
        let dnf = "Available packages\nripgrep.x86_64   14.1.0-1.fc43   fedora\nripgrep.x86_64   14.1.1-2.fc43   updates";
        let vs = parse_dnf_list(dnf);
        assert_eq!(vs.iter().map(|v| v.value.as_str()).collect::<Vec<_>>(), ["14.1.1-2.fc43", "14.1.0-1.fc43"]);

        let apt = "  ripgrep | 14.1.0-1 | http://deb.debian.org/debian trixie/main amd64 Packages\n  ripgrep | 13.0.0-4 | http://deb.debian.org/debian bookworm/main amd64 Packages";
        let av = parse_apt_madison(apt);
        assert_eq!(av.iter().map(|v| v.value.as_str()).collect::<Vec<_>>(), ["14.1.0-1", "13.0.0-4"]);
    }

    #[test]
    fn a_group_becomes_one_command_per_manager() {
        // The whole point of the setup page: five tools, one password prompt.
        let p = plan_system_group_with(Some(SystemPm::Dnf), &["git", "curl", "make", "jq"]).unwrap();
        assert_eq!(p.argv[..3], ["sudo", "dnf", "install"]);
        assert!(p.in_terminal);
        for name in ["git", "curl", "make", "jq"] {
            assert!(p.argv.contains(&name.to_string()), "missing {name}: {:?}", p.argv);
        }

        // Per-manager names still apply inside a group.
        let apt = plan_system_group_with(Some(SystemPm::Apt), &["cc", "fd"]).unwrap();
        assert!(apt.argv.contains(&"build-essential".to_string()));
        assert!(apt.argv.contains(&"fd-find".to_string()));
    }

    #[test]
    fn a_group_skips_what_the_manager_lacks_and_says_so() {
        // apt has no lazygit. Dropping it silently would leave the page claiming a
        // step succeeded while one tool is still missing.
        let p = plan_system_group_with(Some(SystemPm::Apt), &["git", "lazygit"]).unwrap();
        assert!(!p.argv.contains(&"lazygit".to_string()));
        assert!(
            p.warnings.iter().any(|w| w.contains("lazygit")),
            "the skip must be reported: {:?}",
            p.warnings
        );
    }

    #[test]
    fn a_group_of_only_unavailable_packages_is_refused() {
        let err = plan_system_group_with(Some(SystemPm::Apt), &["lazygit"]).unwrap_err();
        assert!(err.contains("apt-get"), "got: {err}");
    }

    #[test]
    fn a_group_never_repeats_a_package_name() {
        // pacman errors on a duplicated target, and two catalog ids can resolve to
        // the same package on some distributions.
        let p = plan_system_group_with(Some(SystemPm::Pacman), &["go", "go"]).unwrap();
        assert_eq!(p.argv.iter().filter(|a| *a == "go").count(), 1);
    }

    #[test]
    fn an_npm_group_installs_every_spec_at_latest() {
        let p = plan_npm_group(&tc(), &["pnpm", "yarn", "typescript"]).unwrap();
        assert!(!p.in_terminal);
        assert_eq!(p.argv[1..3], ["install", "-g"]);
        assert!(p.argv.contains(&"pnpm@latest".to_string()));
        assert!(p.argv.contains(&"typescript@latest".to_string()));
    }

    #[test]
    fn an_npm_group_without_npm_names_the_real_problem() {
        let err = plan_npm_group(&Toolchain::default(), &["pnpm"]).unwrap_err();
        assert!(err.contains("Node"), "got: {err}");
    }

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<&str> = CATALOG.iter().map(|e| e.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate id in the catalog");
    }

    #[test]
    fn alias_keys_name_a_real_manager() {
        // A typo'd key silently does nothing, which is the worst failure mode
        // here: the wrong package name reaches a real install command.
        let known = [
            SystemPm::Dnf,
            SystemPm::Apt,
            SystemPm::Pacman,
            SystemPm::Zypper,
            SystemPm::Apk,
            SystemPm::Brew,
        ]
        .map(|s| s.id());
        for e in CATALOG {
            for (m, _) in e.aliases {
                assert!(known.contains(m), "{}: unknown manager key '{m}'", e.id);
            }
        }
    }
}

#[cfg(test)]
mod update_tests {
    use super::*;

    #[test]
    fn parses_dnf_check_update() {
        let out = "\nLast metadata expiration check: 0:03:11 ago on Wed 30 Jul 2026.\n\
             git.x86_64                 2.51.1-1.fc43        updates\n\
             ripgrep.x86_64             14.1.1-2.fc43        updates\n\
             Obsoleting Packages\n\
             old-thing.noarch           1.0-1.fc43           updates\n";
        assert_eq!(
            parse_dnf_check_update(out),
            vec![
                ("git".into(), Some("2.51.1-1.fc43".into())),
                ("ripgrep".into(), Some("14.1.1-2.fc43".into())),
            ]
        );
        // Nothing to do prints no package rows at all.
        assert!(parse_dnf_check_update("").is_empty());
    }

    #[test]
    fn parses_apt_upgradable() {
        let out = "Listing...\n\
            git/stable-security 1:2.39.5-0+deb12u2 amd64 [upgradable from: 1:2.39.2-1.1]\n\
            jq/stable 1.6-2.1 amd64 [upgradable from: 1.6-2]\n";
        assert_eq!(
            parse_apt_upgradable(out),
            vec![
                ("git".into(), Some("1:2.39.5-0+deb12u2".into())),
                ("jq".into(), Some("1.6-2.1".into())),
            ]
        );
    }

    #[test]
    fn parses_pacman_and_zypper_and_brew() {
        assert_eq!(
            parse_pacman_qu("git 2.50.0-1 -> 2.51.1-1\njq 1.7-1 -> 1.8-1\n"),
            vec![
                ("git".into(), Some("2.51.1-1".into())),
                ("jq".into(), Some("1.8-1".into())),
            ]
        );

        let z = "S | Repository | Name | Current Version | Available Version | Arch\n\
                 --+------------+------+-----------------+-------------------+-----\n\
                 v | repo-oss   | git  | 2.50.0-1.1      | 2.51.1-1.1        | x86_64\n";
        assert_eq!(
            parse_zypper_list_updates(z),
            vec![("git".into(), Some("2.51.1-1.1".into()))]
        );

        assert_eq!(
            parse_brew_outdated("git (2.50.0) < 2.51.1\njq\n"),
            vec![
                ("git".into(), Some("2.51.1".into())),
                // A bare name still says "outdated", just not what to.
                ("jq".into(), None),
            ]
        );
    }

    #[test]
    fn parses_npm_outdated() {
        let json = r#"{
            "pnpm": {"current":"9.0.0","latest":"10.2.0"},
            "typescript": {"current":"5.6.0","latest":"5.6.0"},
            "serve": {"latest":"14.2.0"}
        }"#;
        let mut got = parse_npm_outdated(json).expect("npm answered");
        got.sort();
        // Only a package that is installed *and* behind counts as an upgrade.
        assert_eq!(got, vec![("pnpm".to_string(), Some("10.2.0".to_string()))]);
        // Everything current is an empty object, which is still an answer.
        assert_eq!(parse_npm_outdated("{}"), Some(Vec::new()));
        // Anything unparseable means npm did not answer, not "up to date".
        assert_eq!(parse_npm_outdated("npm ERR! code E404"), None);
    }

    #[test]
    fn parses_rustup_check() {
        // Verbatim from rustup 1.29: lowercase label, and a commit hash and date
        // after each version, so the new version is not the last token.
        let out = "stable-x86_64-unknown-linux-gnu - update available: \
                   1.96.0 (ac68faa20 2026-05-25) -> 1.97.1 (8bab26f4f 2026-07-14)\n\
                   rustup - up to date : 1.29.0\n";
        assert_eq!(parse_rustup_check(out).as_deref(), Some("1.97.1"));
        // The older, capitalised, hashless form still parses.
        assert_eq!(
            parse_rustup_check("stable-x86_64-unknown-linux-gnu - Update available : 1.88.0 -> 1.90.0")
                .as_deref(),
            Some("1.90.0")
        );
        // rustup upgrading itself is not the row's version.
        assert_eq!(parse_rustup_check("rustup - Update available : 1.27.1 -> 1.28.2"), None);
        assert_eq!(
            parse_rustup_check("stable-x86_64-unknown-linux-gnu - Up to date : 1.90.0"),
            None
        );
    }
}

