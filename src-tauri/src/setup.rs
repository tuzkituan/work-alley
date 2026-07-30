//! First-run setup: the ordered path from a bare Fedora or Ubuntu install to a
//! machine that can clone a web project and run it.
//!
//! The Toolbox answers "is this tool here?". This answers "what do I do first?",
//! which on a fresh machine is a different and harder question — the dependencies
//! between these tools are real and invisible:
//!
//! * nothing can be downloaded before `curl` and `git` exist;
//! * `npm install -g` needs Node, and Node comes from nvm;
//! * nvm is a shell function, so it only exists after a new shell is started.
//!
//! So every step reports what blocks it rather than running a command that cannot
//! succeed, and each step batches its packages into a single install — five tools
//! through one `sudo` prompt instead of five.

use crate::model::{PackageOp, PackageStatus, SetupItem, SetupPlan, SetupStepStatus};
use crate::packages;
use crate::toolchain::Toolchain;

/// What a step runs.
enum Kind {
    /// Catalog ids installed together through the system package manager.
    System(&'static [&'static str]),
    /// Catalog ids installed together with `npm install -g`.
    NpmGlobal(&'static [&'static str]),
    /// A vendor install script, for the two tools where no distribution package is
    /// the right answer. `bin` is what proves it worked.
    Script { bin: &'static str, script: &'static str },
    /// Node itself, through nvm.
    Node,
    /// `git config --global user.name` / `user.email`. Not an install, but a repo
    /// you clone is unusable without it, and git only complains at the first commit
    /// — by which point you have stopped thinking about setup.
    GitIdentity,
    /// An ssh key in an agent, or a signed-in `gh`.
    ///
    /// Two routes to one outcome, so unlike every other kind this has no single
    /// command of its own — the page shows both and the user picks. Detection only:
    /// running `ssh-keygen` means owning a passphrase prompt, and `gh auth login`
    /// means owning a browser handoff, neither of which belongs in this codebase.
    Credentials,
}

struct Step {
    id: &'static str,
    title: &'static str,
    /// What it gets you.
    summary: &'static str,
    /// Why it is here rather than later. The ordering is the whole value of this
    /// page, so it explains itself.
    why: &'static str,
    kind: Kind,
    /// Optional steps do not count towards "setup complete".
    optional: bool,
    /// Something the command cannot do for you.
    note: Option<&'static str>,
}

/// The order matters. Each step assumes only what the steps above it installed.
const STEPS: &[Step] = &[
    Step {
        id: "essentials",
        title: "Build essentials",
        summary: "git, curl, make, a C compiler and jq.",
        why: "First, because everything below is downloaded with curl or cloned with \
              git. The compiler is what npm falls back to when a dependency has no \
              prebuilt binary for your machine — without it those installs fail with \
              a wall of C errors instead of \"no compiler\".",
        kind: Kind::System(&["git", "curl", "make", "cc", "jq"]),
        optional: false,
        note: None,
    },
    Step {
        id: "git-identity",
        title: "Your git identity",
        summary: "The name and email recorded on every commit.",
        why: "Git refuses to commit without them, and it tells you that at the first \
              commit rather than now. Two minutes here saves that.",
        kind: Kind::GitIdentity,
        optional: false,
        note: Some(
            "Use the email your git host knows about, or your commits will not be \
             linked to your account.",
        ),
    },
    Step {
        id: "nvm",
        title: "nvm — the Node version manager",
        summary: "Installs nvm into ~/.nvm.",
        why: "Distributions ship a single Node version and it is usually behind. nvm \
              lets each project run the version it was built against, and installs \
              Node under your home directory so no npm command ever needs root.",
        // Pinned to a tag rather than the installer's main branch. This downloads a
        // script and runs it in the user's shell, and "whatever is at that URL
        // today" is not something to hand a shell.
        kind: Kind::Script {
            bin: "nvm",
            script: "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/\
                     v0.40.3/install.sh | bash",
        },
        optional: false,
        note: Some(
            "nvm is a shell function, not a program: it appears in new terminals \
             only. Work Alley resolves it through a login shell, so restart the app \
             once this finishes.",
        ),
    },
    Step {
        id: "node",
        title: "Node.js (latest LTS)",
        summary: "Node and npm, set as your default version.",
        why: "The LTS release is what almost every project targets. Installing it as \
              the default means a new terminal has it without `nvm use`.",
        kind: Kind::Node,
        optional: false,
        note: None,
    },
    Step {
        id: "js-tools",
        title: "Package managers and TypeScript",
        summary: "pnpm, Yarn and the tsc compiler, installed globally.",
        why: "A repo's lockfile decides which package manager it needs, and you do \
              not get to choose. Having all three means anything you clone will \
              install on the first try.",
        kind: Kind::NpmGlobal(&["pnpm", "yarn", "typescript"]),
        optional: false,
        note: None,
    },
    Step {
        id: "github",
        title: "GitHub CLI",
        summary: "gh — sign-in for cloning, and the pull-request list.",
        why: "`gh auth login` is the least painful way to get credentials for cloning \
              over HTTPS, and it is what fills the pull-request list on each repo card.",
        // gh alone. `delta` used to be bundled in here, which meant a *required* step
        // stayed unfinished over a diff pager — someone with gh installed still saw
        // "Install", and required setup could not be completed without a cosmetic tool.
        // It lives in the optional terminal group now.
        kind: Kind::System(&["gh"]),
        optional: false,
        note: None,
    },
    Step {
        id: "credentials",
        title: "Credentials for cloning",
        summary: "An SSH key in an agent, or sign in with the GitHub CLI.",
        why: "The first thing you will do is clone, and it is the first thing that \
              fails: git asks for a password it cannot prompt for from a window, so \
              with neither of these a clone hangs or dies with `Permission denied \
              (publickey)` and no explanation of what to fix.",
        kind: Kind::Credentials,
        optional: false,
        note: Some(
            "Either route is enough. After creating a key, add the public half at \
             github.com/settings/keys — the commands below print it.",
        ),
    },
    Step {
        id: "bun",
        title: "Bun",
        summary: "Installs Bun into ~/.bun.",
        why: "Fast installs, and a bundler and test runner in one binary. Optional \
              — but a repo with a bun.lock wants it.",
        kind: Kind::Script {
            bin: "bun",
            script: "curl -fsSL https://bun.sh/install | bash",
        },
        optional: true,
        note: None,
    },
    Step {
        id: "terminal",
        title: "Terminal tools",
        summary: "ripgrep, fd, fzf, Neovim, and delta for readable diffs.",
        why: "Searching a monorepo with grep is slow enough to change how you work. \
              None of this is required; all of it pays for itself in a week.",
        kind: Kind::System(&["ripgrep", "fd", "fzf", "neovim", "delta"]),
        optional: true,
        note: None,
    },
    Step {
        id: "containers",
        title: "Containers",
        summary: "Docker, for compose files.",
        why: "Most backends ship a compose file for their database and queue. The \
              Local services panel reads whichever runtime is installed.",
        kind: Kind::System(&["docker"]),
        optional: true,
        note: Some(
            "Two things the installer will not do: `sudo systemctl enable --now \
             docker`, and `sudo usermod -aG docker $USER` so you can run it without \
             sudo. The group change takes effect at your next login.",
        ),
    },
    Step {
        id: "databases",
        title: "Database and queue clients",
        summary: "mysql, redis-cli and kcat.",
        why: "Clients only, never servers — a dashboard should not quietly start a \
              daemon listening on a port. Run the servers in containers instead. \
              Chosen from what the services in be/ actually connect to: MySQL, Redis \
              and Kafka. Postgres and SQLite are in the Toolbox if you need them.",
        kind: Kind::System(&["mysql", "redis-cli", "kcat"]),
        optional: true,
        note: None,
    },
    Step {
        id: "backend",
        title: "Backend tooling",
        summary: "The NestJS CLI, and the MongoDB shell.",
        why: "Every service in be/ is NestJS, so `nest generate` is a daily command, \
              and most of them store in MongoDB — mongosh is the only way to look at \
              what they wrote. Both come from npm: neither is packaged by a \
              distribution in a version worth having.",
        kind: Kind::NpmGlobal(&["nest", "mongosh"]),
        optional: true,
        note: None,
    },
];

fn find_step(id: &str) -> Option<&'static Step> {
    STEPS.iter().find(|s| s.id == id)
}

/// The `blocked` reason for one step, or None when it can run.
///
/// Its own entry point so `build_action` can refuse a blocked step up front. Costs a
/// catalog probe, which is acceptable for a click and is what `status` does anyway.
pub async fn blocked_reason(tc: &Toolchain, id: &str) -> Option<String> {
    let step = STEPS.iter().find(|s| s.id == id)?;
    let pkgs = packages::list(tc).await;
    let has_nvm = packages::nvm_script().is_some();
    let (name, email) = git_identity(tc).await;
    let creds = crate::creds::status(tc).await;
    step_state(step, &pkgs, &name, &email, has_nvm, &creds).1
}

// --- status -----------------------------------------------------------------

/// Every step with its current state, for the setup page.
pub async fn status(tc: &Toolchain) -> SetupPlan {
    let pkgs = packages::list(tc).await;
    let sys = packages::detect_system_pm(tc);
    let has_nvm = packages::nvm_script().is_some();
    let (git_name, git_email) = git_identity(tc).await;
    let creds = crate::creds::status(tc).await;

    let steps = STEPS
        .iter()
        .map(|s| {
            let (items, blocked) =
                step_state(s, &pkgs, &git_name, &git_email, has_nvm, &creds);
            // Anything the manager cannot provide is not a reason to keep telling
            // someone their setup is unfinished.
            let done = !items.is_empty()
                && items.iter().all(|i| i.installed || !i.available);

            SetupStepStatus {
                id: s.id.to_string(),
                title: s.title.to_string(),
                summary: s.summary.to_string(),
                why: s.why.to_string(),
                kind: kind_id(&s.kind).to_string(),
                manager: manager_label(&s.kind, sys).to_string(),
                needs_root: matches!(s.kind, Kind::System(_))
                    && sys.map(|p| p.needs_root()).unwrap_or(true),
                optional: s.optional,
                items,
                done,
                blocked,
                // Best effort: a step that cannot be planned yet shows no command
                // rather than an error, because the blocked reason already says why.
                command_preview: plan_for(tc, s, &pkgs)
                    .map(|p| p.argv)
                    .unwrap_or_default(),
                note: s.note.map(str::to_string),
            }
        })
        .collect();

    SetupPlan {
        os_label: os_label(),
        package_manager: sys.map(|p| p.id().to_string()),
        steps,
        git_name,
        git_email,
    }
}

/// The items of a step, and what stops it from running.
fn step_state(
    s: &Step,
    pkgs: &[crate::model::PackageStatus],
    git_name: &Option<String>,
    git_email: &Option<String>,
    has_nvm: bool,
    creds: &crate::creds::CredsStatus,
) -> (Vec<SetupItem>, Option<String>) {
    match &s.kind {
        Kind::System(ids) => (ids.iter().map(|id| item_for(pkgs, id)).collect(), None),

        Kind::NpmGlobal(ids) => {
            let items: Vec<SetupItem> = ids.iter().map(|id| item_for(pkgs, id)).collect();
            let blocked = (!pkgs.installed("node") && !items.iter().all(|i| i.installed))
                .then(|| "Install Node first — these are npm packages.".to_string());
            (items, blocked)
        }

        Kind::Script { bin, .. } => {
            let installed = match *bin {
                "nvm" => has_nvm,
                other => pkgs.installed(other),
            };
            let items = vec![SetupItem {
                id: (*bin).to_string(),
                label: s.title.split(' ').next().unwrap_or(s.title).to_string(),
                installed,
                available: true,
                version: pkgs.version(bin),
            }];
            let blocked = (!installed && !pkgs.installed("curl"))
                .then(|| "Install curl first — the installer is downloaded.".to_string());
            (items, blocked)
        }

        Kind::Node => {
            let items = vec![item_for(pkgs, "node")];
            let blocked = (!has_nvm && !items[0].installed)
                .then(|| "Install nvm first — Node is installed through it.".to_string());
            (items, blocked)
        }

        Kind::Credentials => {
            // Two alternatives, not a checklist: `done` is computed from all items
            // being installed, so reporting both as separate unmet items would leave
            // this step permanently unfinished for someone who picked one route.
            // Marking the route not taken `available: false` is how the existing
            // "the manager cannot provide this" rule expresses "not needed".
            let ssh_ok = !creds.ssh_keys.is_empty() && creds.ssh_agent;
            let gh_ok = creds.gh_account.is_some();
            let either = ssh_ok || gh_ok;

            let items = vec![
                SetupItem {
                    id: "ssh".to_string(),
                    label: if ssh_ok {
                        format!("{} key(s) in the agent", creds.ssh_keys.len())
                    } else if !creds.ssh_key_files.is_empty() {
                        // The "so close" state, and worth naming: the key exists, the
                        // agent just is not holding it, so the fix is `ssh-add`.
                        "key on disk, not in the agent".to_string()
                    } else {
                        "SSH key".to_string()
                    },
                    installed: ssh_ok,
                    available: !gh_ok || ssh_ok,
                    version: None,
                },
                SetupItem {
                    id: "gh".to_string(),
                    label: match &creds.gh_account {
                        Some(login) => format!("signed in as {login}"),
                        None => "GitHub CLI sign-in".to_string(),
                    },
                    installed: gh_ok,
                    available: !ssh_ok || gh_ok,
                    version: None,
                },
            ];

            // Only genuinely blocked with no way to do either.
            let blocked = (!either && !creds.gh_present && creds.ssh_key_files.is_empty())
                .then(|| {
                    "Install the GitHub CLI first, or generate an SSH key — neither is \
                     available yet."
                        .to_string()
                });
            (items, blocked)
        }

        Kind::GitIdentity => {
            let items = vec![
                SetupItem {
                    id: "user.name".to_string(),
                    label: git_name.clone().unwrap_or_else(|| "Name".to_string()),
                    installed: git_name.is_some(),
                    available: true,
                    version: None,
                },
                SetupItem {
                    id: "user.email".to_string(),
                    label: git_email.clone().unwrap_or_else(|| "Email".to_string()),
                    installed: git_email.is_some(),
                    available: true,
                    version: None,
                },
            ];
            let blocked = (!pkgs.installed("git"))
                .then(|| "Install git first.".to_string());
            (items, blocked)
        }
    }
}

fn item_for(pkgs: &[crate::model::PackageStatus], id: &str) -> SetupItem {
    match pkgs.iter().find(|p| p.package.id == id) {
        Some(p) => SetupItem {
            id: id.to_string(),
            label: p.package.label.clone(),
            installed: p.installed,
            available: p.manager_available,
            version: p.version.clone(),
        },
        // Unreachable with a correct STEPS table, and the unit test below keeps it
        // that way. Reported rather than skipped, so a typo is visible.
        None => SetupItem {
            id: id.to_string(),
            label: id.to_string(),
            installed: false,
            available: false,
            version: None,
        },
    }
}

fn kind_id(kind: &Kind) -> &'static str {
    match kind {
        Kind::System(_) => "system",
        Kind::NpmGlobal(_) => "npmGlobal",
        Kind::Script { .. } => "script",
        Kind::Node => "node",
        Kind::GitIdentity => "gitIdentity",
        Kind::Credentials => "credentials",
    }
}

fn manager_label(kind: &Kind, sys: Option<packages::SystemPm>) -> &'static str {
    match kind {
        Kind::System(_) => sys.map(|p| p.id()).unwrap_or("system"),
        Kind::NpmGlobal(_) => "npm",
        Kind::Script { .. } => "curl",
        Kind::Node => "nvm",
        Kind::Credentials => "ssh / gh",
        Kind::GitIdentity => "git",
    }
}

/// `PRETTY_NAME` from os-release, which is the name the user recognises.
fn os_label() -> String {
    for path in ["/etc/os-release", "/usr/lib/os-release"] {
        if let Ok(text) = std::fs::read_to_string(path) {
            for line in text.lines() {
                if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                    let v = v.trim().trim_matches('"');
                    if !v.is_empty() {
                        return v.to_string();
                    }
                }
            }
        }
    }
    std::env::consts::OS.to_string()
}

pub(crate) async fn git_identity(tc: &Toolchain) -> (Option<String>, Option<String>) {
    let Some(git) = tc.path("git") else {
        return (None, None);
    };
    let name = git_config(git, &tc.path_env, "user.name").await;
    let email = git_config(git, &tc.path_env, "user.email").await;
    (name, email)
}

async fn git_config(git: &std::path::Path, path_env: &str, key: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(git);
    cmd.args(["config", "--global", "--get", key])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    if !path_env.is_empty() {
        cmd.env("PATH", path_env);
    }

    let out = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output())
        .await
        .ok()?
        .ok()?;
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

// --- planning ---------------------------------------------------------------

pub struct StepPlan {
    pub title: String,
    pub plan: packages::Plan,
}

/// The command for one step, or why it cannot be built.
pub async fn plan(tc: &Toolchain, id: &str) -> Result<StepPlan, String> {
    let s = find_step(id).ok_or_else(|| format!("unknown setup step '{id}'"))?;
    // One probe of the catalog, so the command only names what is actually missing.
    let pkgs = packages::list(tc).await;
    Ok(StepPlan {
        title: s.title.to_string(),
        plan: plan_for(tc, s, &pkgs)?,
    })
}

/// The real planner, with detection results passed in.
///
/// Split out because the page shows a preview of every step's command, and
/// re-probing fifty binaries once per step to render ten previews would make the
/// page take seconds to load.
///
/// Only the packages that are actually missing are installed, so re-running a
/// half-finished step does not reinstall what is already there. When nothing is
/// missing the whole set is used, which is what the page's "Re-run" offers.
fn plan_for(
    tc: &Toolchain,
    s: &Step,
    pkgs: &[PackageStatus],
) -> Result<packages::Plan, String> {
    let plan = match &s.kind {
        Kind::System(ids) => packages::plan_system_group(tc, &missing_of(ids, pkgs))?,

        Kind::NpmGlobal(ids) => packages::plan_npm_group(tc, &missing_of(ids, pkgs))?,

        Kind::Script { script, .. } => packages::Plan {
            argv: packages::login_shell_script(script)?,
            // No root anywhere in these: both installers write under $HOME.
            in_terminal: false,
            danger: crate::model::Danger::Medium,
            warnings: vec![
                "Downloads a script from the vendor and runs it in your shell."
                    .to_string(),
                "It appends a few lines to your shell profile, so open a new \
                 terminal afterwards."
                    .to_string(),
            ],
            typed_confirm: None,
            description: format!(
                "The official installer for {}. The full command is above — read it \
                 before you accept.",
                s.title
            ),
        },

        Kind::Node => packages::plan(tc, "node", PackageOp::Install, None)?,

        Kind::GitIdentity => {
            return Err(
                "Fill in your name and email on the setup page — this step has no \
                 command of its own."
                    .to_string(),
            )
        }

        // No single command, on purpose: there are two routes and the user picks. The
        // page renders the commands to copy instead of a Run button, which is what an
        // empty `commandPreview` means.
        Kind::Credentials => {
            return Err(
                "Pick a route on the setup page — an SSH key or the GitHub CLI."
                    .to_string(),
            )
        }
    };

    Ok(plan)
}

/// The ids of a step that are not installed yet, falling back to all of them so a
/// finished step can still be re-run.
fn missing_of(ids: &'static [&'static str], pkgs: &[PackageStatus]) -> Vec<&'static str> {
    let missing: Vec<&'static str> = ids
        .iter()
        .copied()
        .filter(|id| !pkgs.installed(id))
        .collect();
    if missing.is_empty() {
        ids.to_vec()
    } else {
        missing
    }
}

// --- git identity -----------------------------------------------------------

/// Validates one side of the git identity.
///
/// These two strings end up inside a shell command, so they are quoted at the call
/// site — but a value with a newline or a control character in it would be wrong in
/// a commit trailer regardless of how it got there, so it is rejected here.
pub fn clean_identity(field: &str, value: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(format!("{field} cannot be empty"));
    }
    if v.chars().count() > 200 {
        return Err(format!("{field} is too long"));
    }
    if v.chars().any(char::is_control) {
        return Err(format!("{field} cannot contain line breaks or control characters"));
    }
    if field == "email" && (!v.contains('@') || v.split_whitespace().count() > 1) {
        return Err("that does not look like an email address".to_string());
    }
    Ok(v.to_string())
}

/// The command that writes both config values.
///
/// One command rather than two so it is a single run with a single result: a setup
/// step that half-succeeded is worse than one that failed.
pub fn git_identity_argv(
    sh: &crate::platform::Shell,
    git: &std::path::Path,
    name: &str,
    email: &str,
) -> Vec<String> {
    let g = git.display().to_string();
    let set = |key: &str, value: &str| {
        sh.cmd(&[
            g.clone(),
            "config".into(),
            "--global".into(),
            key.into(),
            value.into(),
        ])
    };
    sh.login_script_argv(&sh.both(&set("user.name", name), &set("user.email", email)))
}

// --- helpers ----------------------------------------------------------------

/// Lookup helpers over the catalog status list, so the code above reads as
/// questions about tools rather than as list plumbing.
pub trait PackageStatusExt {
    fn installed(&self, id: &str) -> bool;
    fn version(&self, id: &str) -> Option<String>;
}

impl PackageStatusExt for [crate::model::PackageStatus] {
    fn installed(&self, id: &str) -> bool {
        self.iter().any(|p| p.package.id == id && p.installed)
    }
    fn version(&self, id: &str) -> Option<String> {
        self.iter()
            .find(|p| p.package.id == id)
            .and_then(|p| p.version.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::procs::sh_quote;

    #[test]
    fn every_step_id_is_unique() {
        let mut ids: Vec<&str> = STEPS.iter().map(|s| s.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate setup step id");
    }

    #[test]
    fn every_package_a_step_names_exists_in_the_catalog() {
        // A typo here would render a row labelled with the id, permanently "not
        // available", and no install would ever fix it.
        for s in STEPS {
            let ids: &[&str] = match &s.kind {
                Kind::System(ids) | Kind::NpmGlobal(ids) => ids,
                Kind::Node => &["node"],
                Kind::Script { bin, .. } => {
                    // nvm is the one thing that is not a catalog entry: it is a
                    // shell function, detected by its script.
                    if *bin == "nvm" {
                        &[]
                    } else {
                        std::slice::from_ref(bin)
                    }
                }
                Kind::GitIdentity | Kind::Credentials => &[],
            };
            for id in ids {
                assert!(
                    packages::find(id).is_some(),
                    "step '{}' names unknown package '{id}'",
                    s.id
                );
            }
        }
    }

    #[test]
    fn the_order_puts_each_dependency_before_its_dependent() {
        let pos = |id: &str| STEPS.iter().position(|s| s.id == id).expect(id);
        assert!(pos("essentials") < pos("nvm"), "nvm is downloaded with curl");
        assert!(pos("nvm") < pos("node"), "Node comes from nvm");
        assert!(pos("node") < pos("js-tools"), "npm -g needs Node");
        assert!(pos("essentials") < pos("git-identity"), "git config needs git");
        // Last of the required ones: `gh auth login` is one of its two routes, so the
        // CLI has to exist before the step that offers it.
        assert!(pos("github") < pos("credentials"), "the gh route needs gh installed");
    }

    #[test]
    fn the_required_steps_are_the_ones_a_web_project_cannot_start_without() {
        let required: Vec<&str> = STEPS.iter().filter(|s| !s.optional).map(|s| s.id).collect();
        assert_eq!(
            required,
            [
                "essentials",
                "git-identity",
                "nvm",
                "node",
                "js-tools",
                "github",
                // Required because cloning is the first thing anyone does here, and
                // with neither an ssh key nor a gh login it fails with a message that
                // does not say what to fix.
                "credentials",
            ]
        );
    }

    /// The credentials step across its four combinations.
    ///
    /// The trap it guards: `done` is "every item installed or unavailable", so two
    /// unmet items would leave this step permanently unfinished for someone who
    /// legitimately picked one route. The route not taken is marked unavailable.
    #[test]
    fn either_credential_route_finishes_the_step() {
        let step = STEPS.iter().find(|s| s.id == "credentials").unwrap();
        let none: Option<String> = None;
        let state = |creds: crate::creds::CredsStatus| {
            let (items, blocked) = step_state(step, &[], &none, &none, false, &creds);
            let done = !items.is_empty() && items.iter().all(|i| i.installed || !i.available);
            (done, blocked)
        };

        let ssh_only = crate::creds::CredsStatus {
            ssh_agent: true,
            ssh_keys: vec!["SHA256:AbC".into()],
            ..Default::default()
        };
        assert!(state(ssh_only).0, "an ssh key in the agent is enough on its own");

        let gh_only = crate::creds::CredsStatus {
            gh_present: true,
            gh_account: Some("ada".into()),
            ..Default::default()
        };
        assert!(state(gh_only).0, "a gh sign-in is enough on its own");

        let both = crate::creds::CredsStatus {
            ssh_agent: true,
            ssh_keys: vec!["SHA256:AbC".into()],
            gh_present: true,
            gh_account: Some("ada".into()),
            ..Default::default()
        };
        assert!(state(both).0);

        // Neither, and nothing to do either with: blocked rather than silently
        // unfinished.
        let (done, blocked) = state(crate::creds::CredsStatus::default());
        assert!(!done);
        assert!(blocked.is_some(), "with no gh and no key this needs a reason");

        // A key on disk but no agent holding it is unfinished but NOT blocked — there
        // is something to do, and `ssh-add` is it.
        let stranded = crate::creds::CredsStatus {
            ssh_key_files: vec!["id_ed25519.pub".into()],
            ..Default::default()
        };
        let (done, blocked) = state(stranded);
        assert!(!done);
        assert!(blocked.is_none(), "there is a fix, so this must not read as blocked");
    }

    #[test]
    fn single_quoting_survives_an_apostrophe() {
        assert_eq!(sh_quote("plain"), "'plain'");
        // The classic: a name with a quote in it must stay one argument.
        assert_eq!(sh_quote("O'Brien"), r"'O'\''Brien'");
        // And a shell metacharacter must stay literal.
        assert_eq!(sh_quote("a; rm -rf /"), "'a; rm -rf /'");
    }

    #[test]
    fn identities_are_validated_before_they_reach_a_command() {
        assert_eq!(clean_identity("name", "  Ada Lovelace  ").unwrap(), "Ada Lovelace");
        assert!(clean_identity("name", "   ").is_err());
        assert!(clean_identity("name", "two\nlines").is_err());
        assert!(clean_identity("email", "not-an-email").is_err());
        assert!(clean_identity("email", "ada@example.com").is_ok());
        assert!(clean_identity("name", &"x".repeat(201)).is_err());
    }

    #[test]
    fn the_identity_command_writes_both_keys_in_one_run() {
        let sh = crate::platform::test_shell(crate::platform::ShellKind::Posix);
        let argv = git_identity_argv(
            sh,
            std::path::Path::new("/usr/bin/git"),
            "O'Brien",
            "o@example.com",
        );
        let script = argv.last().unwrap();
        assert!(script.contains("user.name"));
        assert!(script.contains("user.email"));
        assert!(script.contains(r"'O'\''Brien'"), "got: {script}");
        // One run, so the step cannot half-succeed.
        assert!(script.contains("&&"), "got: {script}");
    }

    #[test]
    fn the_identity_command_is_also_correct_under_powershell() {
        // The Windows fallback when Git Bash is absent. PowerShell has no `&&`, so a
        // naive translation would write the name and silently skip the email.
        let sh = crate::platform::test_shell(crate::platform::ShellKind::PowerShell);
        let argv = git_identity_argv(
            sh,
            std::path::Path::new(r"C:\Program Files\Git\cmd\git.exe"),
            "O'Brien",
            "o@example.com",
        );
        let script = argv.last().unwrap();
        assert!(script.contains("$LASTEXITCODE"), "got: {script}");
        assert!(!script.contains("&&"), "got: {script}");
        // Doubled apostrophe, which is how PowerShell escapes one.
        assert!(script.contains("'O''Brien'"), "got: {script}");
        // A program path with a space in it must be quoted; the old code left it bare.
        assert!(script.contains(r"'C:\Program Files\Git\cmd\git.exe'"), "got: {script}");
    }

    #[test]
    fn an_unknown_step_has_no_command() {
        // The frontend sends a step id, so an unknown one must be refused rather
        // than falling through to some default command.
        assert!(find_step("nope").is_none());
        assert!(find_step("essentials").is_some());
    }

    #[test]
    fn a_step_installs_only_what_is_missing() {
        let pkgs = vec![status_of("git", true), status_of("curl", false)];
        assert_eq!(missing_of(&["git", "curl"], &pkgs), ["curl"]);
        // Nothing missing falls back to the whole set, so "Re-run" still has a
        // command to run.
        let all = vec![status_of("git", true), status_of("curl", true)];
        assert_eq!(missing_of(&["git", "curl"], &all), ["git", "curl"]);
    }

    fn status_of(id: &str, installed: bool) -> PackageStatus {
        PackageStatus {
            package: crate::model::ToolPackage {
                id: id.to_string(),
                label: id.to_string(),
                description: String::new(),
                group: String::new(),
                manager: String::new(),
                needs_root: false,
                removable: true,
            },
            installed,
            path: None,
            version: None,
            manager_available: true,
        }
    }
}

