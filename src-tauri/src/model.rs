//! Wire types. Mirrored in src/domain/types.ts — keep the two in lockstep.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A group of repos: the name of an immediate subdirectory of the workspace.
///
/// Discovered, not enumerated — the workspace folder is user-chosen, so `be/ fe/
/// sa/ ui/` is one workspace's shape, not a universal one. The empty string means
/// "repos sitting directly in the workspace root", which is the common shape for
/// a plain `~/projects` folder.
pub type Category = String;

/// Repos directly in the root have no subdirectory name.
pub const ROOT_GROUP: &str = "";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub category: Category,
    pub name: String,
}

impl RepoRef {
    /// `"frontend/web"`, or just `"my-repo"` for an ungrouped repo.
    pub fn key(&self) -> String {
        if self.category.is_empty() {
            self.name.clone()
        } else {
            format!("{}/{}", self.category, self.name)
        }
    }

    /// Inverse of `key`.
    pub fn parse_key(key: &str) -> RepoRef {
        match key.split_once('/') {
            Some((group, name)) => RepoRef {
                category: group.to_string(),
                name: name.to_string(),
            },
            None => RepoRef {
                category: ROOT_GROUP.to_string(),
                name: key.to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncState {
    NoUpstream,
    InSync,
    #[serde(rename_all = "camelCase")]
    Diverged { ahead: u32, behind: u32 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StaleState {
    Unknown,
    #[serde(rename_all = "camelCase")]
    Fresh { last_fetch_unix: i64 },
    #[serde(rename_all = "camelCase")]
    Stale { last_fetch_unix: i64, days: i64 },
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedDep {
    pub declared: Option<String>,
    pub resolved: Option<String>,
    pub field: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub unix: i64,
    pub relative: String,
}

/// One way to run a repo, as the UI needs it: enough to label a button and predict
/// a URL, and nothing about how the argv is built — that stays in `runner`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnableTask {
    /// What a `devStart` action passes back as `task`.
    pub id: String,
    /// Goes after "Start" / "Stop": "dev", "cargo run", "runserver".
    pub label: String,
    pub port: Option<u16>,
}

/// One one-shot command a repo's ecosystem offers, as the UI needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoreInfo {
    /// What a `runChore` action passes back.
    pub id: String,
    /// The command as you would type it — "flutter pub get", "./gradlew clean".
    pub label: String,
    /// Submenu heading: "Flutter", "Gradle", "Django".
    pub group: String,
    /// Deletes build output or rewrites files, so the UI confirms first.
    pub destructive: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    #[serde(rename = "ref")]
    pub repo: RepoRef,
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head_sha: Option<String>,
    pub detached: bool,
    pub dirty_count: u32,
    pub untracked_count: u32,
    pub conflict_count: u32,
    pub sync: SyncState,
    pub stale: StaleState,
    pub last_commit: Option<LastCommit>,
    pub tracked_dep: TrackedDep,
    /// The port this repo's dev server would use, resolved from .env /
    /// vite.config. Present whether or not a server is running, so the UI can
    /// offer to free a port held by a stale process.
    pub dev_port: Option<u16>,
    /// What this repo appears to be — frontend, backend, library, mobile.
    pub shape: RepoShape,
    /// Long-running scripts this repo declares in package.json — "dev",
    /// "storybook". A subset of `runnable`, kept because the Storybook affordance
    /// is specifically about a declared script.
    pub available_tasks: Vec<String>,
    /// Every way this repo can be run, best first — declared scripts, then the
    /// ecosystem runner its files imply. Empty means nothing here runs, which is a
    /// real answer for a library or a docs repo.
    pub runnable: Vec<RunnableTask>,
    /// `runnable`'s first entry. The task a Run button starts when the user has not
    /// picked one; None disables that button rather than failing on "dev".
    pub primary_task: Option<String>,
    /// One-shot scripts this repo declares — "build", "lint", "format". Also the
    /// closed set a `runScript` action is validated against.
    pub available_scripts: Vec<String>,
    /// One-shot commands this repo's *ecosystems* offer — `flutter pub get`,
    /// `cargo clippy`, `./gradlew clean`. The closed set a `runChore` action is
    /// validated against, and the non-JS counterpart of `available_scripts`.
    pub chores: Vec<ChoreInfo>,
    /// What a Build button runs here, or None for a repo with no build step — which
    /// a docs repo and a Python service legitimately have not.
    pub primary_build: Option<BuildTarget>,
    /// `https://github.com/owner/repo` for this repo's origin, when the host is one
    /// the app is allowed to open. None for a self-hosted forge or no remote, and
    /// the UI then renders shas and branch names as plain text.
    pub remote_web_base: Option<String>,
    /// Tasks currently running for this repo. Not a single `dev_server`, because a
    /// UI library commonly has dev and storybook up at the same time.
    pub tasks: Vec<DevServer>,
    /// Set => the rest is best-effort. A scan never fails wholesale.
    pub error: Option<String>,
    pub scan_ms: u64,
}

/// What a Build button acts on.
///
/// Tagged rather than two Options, because "script or chore" is exactly the thing
/// the frontend must not infer: the two dispatch different actions, validated
/// against different closed sets.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum BuildTarget {
    /// A `build` script the repo declares. Validated against `available_scripts`.
    Script { name: String, label: String },
    /// An ecosystem build — `cargo build`, `./gradlew build`. Validated against
    /// `chores`.
    Chore { id: String, label: String },
}

impl RepoStatus {
    pub fn errored(repo: RepoRef, path: PathBuf, msg: impl Into<String>) -> Self {
        RepoStatus {
            repo,
            path,
            branch: None,
            head_sha: None,
            detached: false,
            dirty_count: 0,
            untracked_count: 0,
            conflict_count: 0,
            sync: SyncState::NoUpstream,
            stale: StaleState::Unknown,
            last_commit: None,
            tracked_dep: TrackedDep::default(),
            dev_port: None,
            shape: RepoShape::default(),
            available_tasks: Vec::new(),
            runnable: Vec::new(),
            primary_task: None,
            available_scripts: Vec::new(),
            chores: Vec::new(),
            primary_build: None,
            remote_web_base: None,
            tasks: Vec::new(),
            error: Some(msg.into()),
            scan_ms: 0,
        }
    }
}

/// One branch, local or remote-only.
///
/// Replaces the bare `String` the branch list used to return: that flattened
/// `origin/x` into `x`, merged duplicates, and dropped every date — so the UI could
/// only ever render a list of names.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Without any `origin/` prefix, so it is what you would type to check it out.
    pub name: String,
    /// False => it exists only on the remote, and checking it out creates it here.
    pub local: bool,
    /// The configured upstream of a local branch, e.g. `origin/main`.
    pub upstream: Option<String>,
    /// Relative to `upstream`. Both zero when there is none, or when it is `[gone]`.
    pub ahead: u32,
    pub behind: u32,
    pub last_commit_unix: Option<i64>,
    pub tip_sha: Option<String>,
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// `stash@{0}` — what you would pass to `git stash apply`.
    pub selector: String,
    pub message: String,
    pub unix: i64,
    pub relative: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    #[serde(rename = "ref")]
    pub repo: RepoRef,
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub unix: i64,
    pub relative: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub scan_id: String,
    pub started_unix: i64,
    pub finished_unix: Option<i64>,
    pub repos: Vec<RepoStatus>,
    pub commits: Vec<CommitEntry>,
    pub tracked_latest: Option<String>,
    pub tracked_latest_source: Option<String>,
    pub ok_count: u32,
    pub error_count: u32,
    pub duration_ms: u64,
}

// --- runs -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
    Meta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Cmd,
    Out,
    Ok,
    Warn,
    Err,
    Info,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Monotonic per run — makes replay gap-free and dedupable.
    pub seq: u64,
    pub stream: Stream,
    pub severity: Severity,
    pub text: String,
    pub unix: i64,
    /// Set on bulk runs so interleaved repos can be rendered grouped.
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunStatus {
    Running,
    Exited { code: i32 },
    Signaled { signal: i32 },
    Cancelled,
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub kind: String,
    pub title: String,
    #[serde(rename = "ref")]
    pub repo: Option<RepoRef>,
    /// Every repo this run touched. A bulk action leaves `repo` unset — its work
    /// spans the whole list — so this is what tells the frontend which rows went
    /// stale and need a rescan. Single-repo runs list just their own repo.
    pub targets: Vec<RepoRef>,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub started_unix: i64,
    pub ended_unix: Option<i64>,
    pub status: RunStatus,
    pub line_count: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogPage {
    pub lines: Vec<LogLine>,
    pub next_seq: u64,
    pub truncated: bool,
    pub status: RunStatus,
}

// --- dev servers ------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DevState {
    Starting,
    Up,
    Stopping,
    Crashed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PortSource {
    Env,
    ViteConfigDefault,
    ConfigOverride,
    DetectedFromOutput,
    /// The convention for this kind of task — Django's 8000, Storybook's 6006, the
    /// first published port in a compose file. Distinct from the vite/env answers
    /// because it is a property of the runner, not of anything the repo configured.
    TaskDefault,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServer {
    #[serde(rename = "ref")]
    pub repo: RepoRef,
    /// "dev" or "storybook". A repo can run both at once, so this is part of the
    /// process registry key rather than an attribute of the repo.
    pub task: String,
    pub run_id: String,
    pub pid: u32,
    pub command: Vec<String>,
    pub port: Option<u16>,
    pub port_source: Option<PortSource>,
    pub state: DevState,
    pub url: Option<String>,
    pub started_unix: i64,
}

// --- containers -------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPort {
    pub host: Option<u16>,
    pub container: u16,
    pub proto: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerService {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub uptime_seconds: Option<i64>,
    pub ports: Vec<ContainerPort>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerRuntime {
    Docker,
    Podman,
}

impl ContainerRuntime {
    pub fn tool(&self) -> &'static str {
        match self {
            ContainerRuntime::Docker => "docker",
            ContainerRuntime::Podman => "podman",
        }
    }
}

/// Absence is a state to render, never an error to throw.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DockerStatus {
    NotInstalled,
    #[serde(rename_all = "camelCase")]
    DaemonDown {
        runtime: ContainerRuntime,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    TimedOut { runtime: ContainerRuntime },
    #[serde(rename_all = "camelCase")]
    Ok {
        runtime: ContainerRuntime,
        services: Vec<DockerService>,
        fetched_unix: i64,
    },
}

// --- repo detail ------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub head_ref: String,
    pub base_ref: String,
    pub is_draft: bool,
    /// gh's reviewDecision: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / "".
    pub review_decision: String,
    pub url: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub updated_unix: i64,
    pub updated_relative: String,
    pub is_mine: bool,
    /// CI, rolled up: "passing" / "failing" / "pending", or "" when the repo has no
    /// checks configured — which is not the same as passing.
    pub checks: String,
    pub labels: Vec<String>,
    /// gh's mergeable: MERGEABLE / CONFLICTING / UNKNOWN, or "".
    pub mergeable: String,
}

/// `gh` is optional and often unauthenticated, so absence is modelled as data.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PullRequestsResult {
    GhMissing,
    #[serde(rename_all = "camelCase")]
    NotAuthenticated { message: String },
    #[serde(rename_all = "camelCase")]
    NoRemote,
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
    #[serde(rename_all = "camelCase")]
    Ok {
        slug: String,
        prs: Vec<PullRequest>,
        fetched_unix: i64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Two-letter porcelain code, e.g. " M", "??", "UU".
    pub code: String,
    pub staged: bool,
    pub untracked: bool,
    pub conflicted: bool,
    /// Lines added and removed, staged and unstaged summed. Both zero when the file
    /// is untracked (there is nothing to diff it against), binary, or when the diff
    /// could not be read — see the note in `git::changed_files`.
    pub added: u32,
    pub deleted: u32,
}

// --- repo shape -------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoKind {
    Frontend,
    Backend,
    Library,
    Mobile,
    Docs,
    Unknown,
}

impl RepoKind {
    /// Group name used when a workspace has no subfolders to group by.
    pub fn group_name(&self) -> &'static str {
        match self {
            RepoKind::Frontend => "frontend",
            RepoKind::Backend => "backend",
            RepoKind::Library => "libraries",
            RepoKind::Mobile => "mobile",
            RepoKind::Docs => "docs",
            RepoKind::Unknown => "other",
        }
    }
}

impl RepoShape {
    /// Folder name for a repo in a workspace with no subdirectories to group by.
    ///
    /// The kind when there is one, otherwise the language. Everything outside the
    /// JS ecosystem classifies as Unknown, so keying only on kind swept a folder of
    /// CMake and shell projects into one "other" — a name that says nothing about
    /// six repos. "other" is now what you get when neither answer exists.
    pub fn group_name(&self) -> String {
        if self.kind != RepoKind::Unknown {
            return self.kind.group_name().to_string();
        }
        self.language
            .as_deref()
            .map(str::to_lowercase)
            .unwrap_or_else(|| "other".to_string())
    }
}

/// What a repo appears to be, from its files. Detected, never configured.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoShape {
    pub kind: RepoKind,
    /// Display name of the language this repo is mostly written in — "TypeScript",
    /// "C++", "Rust". None when there is no code to judge by.
    pub language: Option<String>,
    /// Frameworks and languages found, e.g. ["vite", "react", "storybook"].
    pub stack: Vec<String>,
    pub has_dockerfile: bool,
    pub is_monorepo: bool,
}

impl Default for RepoShape {
    fn default() -> Self {
        RepoShape {
            kind: RepoKind::Unknown,
            language: None,
            stack: Vec::new(),
            has_dockerfile: false,
            is_monorepo: false,
        }
    }
}

// --- packages ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageOp {
    Install,
    Upgrade,
    Remove,
}

/// What a checkout would do to one repo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutPreview {
    #[serde(rename = "ref")]
    pub repo: RepoRef,
    pub current: Option<String>,
    /// The branch this repo would end up on. None means it cannot be determined
    /// (no origin/HEAD) or does not exist here, so the repo is left alone rather
    /// than guessed at.
    pub target: Option<String>,
    /// False when a named branch exists in neither refs/heads nor origin/.
    pub target_exists: bool,
    /// Modified + untracked. Non-zero is what the policy applies to.
    pub dirty_count: u32,
    /// True when it is already on the target and clean.
    pub already_there: bool,
}

/// What to do about a repo with local changes when switching branches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirtyPolicy {
    /// Leave it on its current branch, untouched.
    Skip,
    /// `git stash push -u`, so the work is recoverable with `git stash pop`.
    Stash,
    /// `git reset --hard` + `git clean -fd`. Unrecoverable.
    Discard,
}

/// One installable version, for the Install button's version menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageVersion {
    /// Passed back verbatim as `ActionSpec::Package { version }`.
    pub value: String,
    pub label: String,
    /// "LTS", "current", … — shown next to the label.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPackage {
    pub id: String,
    pub label: String,
    pub description: String,
    pub group: String,
    /// dnf / winget / nvm / bun / npm / rustup / cargo
    pub manager: String,
    /// True when the operation must run in a terminal for a password prompt.
    pub needs_root: bool,
    pub removable: bool,
    /// How privileges are acquired: "sudo", "uac" or "none".
    ///
    /// Separate from `needs_root` because winget needs neither a prefix nor a
    /// terminal, but does raise a consent dialog outside the app — so "root", and the
    /// tooltip about typing a password, would both be wrong there.
    pub elevation: String,
    /// Why this tool cannot be installed here, when there is something more useful to
    /// say than "not available through <manager>". `kcat` has no Windows build at all;
    /// `curl` is already in the OS.
    pub unavailable_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageStatus {
    pub package: ToolPackage,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// False when the managing tool itself is missing, so actions are impossible.
    pub manager_available: bool,
}

/// An upgrade a manager reports as available for an already-installed tool.
///
/// Kept separate from `PackageStatus` because the two have very different costs:
/// listing what is installed probes local binaries, while asking "is there a newer
/// one" talks to repositories and registries. The Toolbox renders the list first
/// and folds these in when they arrive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdate {
    /// Catalog id, matching `ToolPackage::id`.
    pub id: String,
    /// None when the manager says "outdated" without naming the new version.
    pub latest: Option<String>,
}

/// The result of one update check across every manager on this machine.
///
/// `checked` matters as much as `updates`: a manager that could not be asked — no
/// network, a registry timeout, or one that simply cannot answer the question —
/// must not make its tools look up to date. Only ids listed in `checked` have a
/// real answer; the rest keep an always-available Upgrade button.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    pub checked: Vec<String>,
    pub updates: Vec<PackageUpdate>,
}

/// What a runnable task would execute, for the run-command editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandPreview {
    /// `"fe/web#dev"` — how the override is keyed.
    pub task_key: String,
    pub label: String,
    /// What `runner` resolves from the repo's own files. Always the default, never
    /// the override, so "Reset" has something to reset to.
    pub default_argv: Vec<String>,
    pub override_argv: Option<Vec<String>>,
    pub cwd: PathBuf,
}

// --- repo dependencies ------------------------------------------------------

/// One line of a repo's package.json dependency table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDep {
    pub name: String,
    pub field: crate::pkg::DepField,
    /// Verbatim from package.json: `"^1.2.3"`, `"workspace:*"`, a git URL.
    pub range: String,
    /// From `node_modules/<name>/package.json`. None = not installed here.
    pub installed: Option<String>,
    /// A `workspace:`/`file:`/`link:`/`portal:`/git/http range. Not a registry
    /// install, so there is nothing this app can upgrade it to.
    pub linked: bool,
}

/// Everything the dependency table can know without touching the network.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPackages {
    pub has_manifest: bool,
    /// `pkg::package_manager` for this repo. None when there is no manifest.
    pub manager: Option<String>,
    /// Whether `node_modules` exists at all — the difference between "nothing is
    /// installed yet" and "this one dependency is missing".
    pub installed_tree: bool,
    pub deps: Vec<RepoDep>,
}

/// A newer published version of one dependency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepUpdate {
    pub name: String,
    /// What the registry considers newest. None when the manager reported the row
    /// without naming a version.
    pub latest: Option<String>,
    /// The newest version the declared range already allows — an in-range bump.
    pub wanted: Option<String>,
}

/// The result of asking one repo's package manager what is out of date.
///
/// `checked` carries the same weight it does in `UpdateReport`: a manager that
/// could not be asked — offline, a registry timeout, Yarn PnP, which cannot answer
/// at all — must never make a dependency look current. When it is false the panel
/// says so and keeps every Upgrade button, rather than rendering "up to date".
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepUpdateReport {
    pub checked: bool,
    /// Which tool answered: `npm`, `pnpm`, `yarn`. Empty when none did.
    pub source: String,
    /// Only the rows that are behind; a checked repo with none is up to date.
    pub updates: Vec<DepUpdate>,
    /// Why nothing could be checked, rendered as a note rather than an error.
    pub reason: Option<String>,
}

// --- bootstrap --------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPick {
    pub path: String,
    /// Non-hidden entries already in the folder, so the UI can warn before
    /// cloning into somewhere that is not empty.
    pub entry_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    /// Binary name, used as the action's editor id.
    pub id: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScriptMode {
    Headless,
    TerminalOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Danger {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptArg {
    pub name: String,
    pub kind: String,
    pub options: Option<Vec<String>>,
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDescriptor {
    pub id: String,
    pub file: String,
    pub title: String,
    pub description: String,
    pub mode: ScriptMode,
    pub danger: Danger,
    pub required_tools: Vec<String>,
    pub arg_schema: Vec<ScriptArg>,
    pub non_zero_exit_meaning: Option<String>,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    pub category: Category,
    /// Display name — the directory name, or the workspace's own name for the
    /// root group (whose category is the empty string).
    pub label: String,
    pub present: bool,
    /// Repos on disk with a .git.
    pub repo_count: u32,
    /// Repos declared in repos.json, when the workspace has one.
    pub declared_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub app_version: String,
    /// False while the toolchain probe is still running.
    pub tools_ready: bool,
    /// False when no workspace folder has been chosen yet, or the saved one is gone.
    pub has_workspace: bool,
    /// Recently opened workspaces, newest first.
    pub recent_roots: Vec<String>,
    pub workspace_root: PathBuf,
    pub categories: Vec<CategoryInfo>,
    pub repos: Vec<RepoRef>,
    pub config: crate::config::Config,
    pub tools: Vec<ToolInfo>,
    /// Editors found on this machine, for the "open in…" action.
    pub editors: Vec<EditorInfo>,
    pub scripts: Vec<ScriptDescriptor>,
    /// The shared package whose version drift is tracked, when this workspace has
    /// one. None hides the column entirely rather than showing an empty one.
    pub tracked_package: Option<String>,
    /// The user's home directory, so paths can be abbreviated to `~/…`. Sent
    /// rather than assumed: it is `/home/x` on Linux and `/Users/x` on macOS, and
    /// neither is guaranteed.
    pub home_dir: Option<PathBuf>,
    /// Which OS this is: "windows", "macos" or "linux".
    ///
    /// Carried on the payload the frontend already fetches on mount rather than
    /// through a command of its own, and rather than through `@tauri-apps/plugin-os`.
    /// Before this there was no way at all for the UI to branch on platform, which the
    /// window controls and the path abbreviation both need.
    pub os: String,
    pub warnings: Vec<String>,
    /// Whether this machine can actually do what the dashboard offers.
    ///
    /// Not the same as `tools_ready`, which only says the probe finished — see
    /// readiness.rs. A cached snapshot, refreshed by the probe rather than computed
    /// here: the honest answer would mean 44 sequential `--version` subprocesses on
    /// every bootstrap.
    pub readiness: crate::readiness::Readiness,
    /// First-run onboarding has been finished, or explicitly skipped. Both count.
    pub onboarding_completed: bool,
}

// --- first-run setup --------------------------------------------------------

/// One thing a setup step is responsible for. A package, or one half of the git
/// identity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupItem {
    pub id: String,
    pub label: String,
    pub installed: bool,
    /// False when this machine's package manager does not carry it, which is a
    /// permanent state no install can change.
    pub available: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStepStatus {
    pub id: String,
    pub title: String,
    pub summary: String,
    /// Why this step is here, and here rather than later.
    pub why: String,
    /// "system" | "npmGlobal" | "script" | "node" | "gitIdentity" — the frontend
    /// renders the identity step as a form and the rest as one button.
    pub kind: String,
    /// The manager this step will use, named so the user can see it is dnf rather
    /// than apt before anything runs.
    pub manager: String,
    pub needs_root: bool,
    pub optional: bool,
    pub items: Vec<SetupItem>,
    pub done: bool,
    /// What must happen first. None when the step can run now.
    pub blocked: Option<String>,
    /// The command this step would run. Empty when it cannot be planned yet.
    pub command_preview: Vec<String>,
    /// Something the command cannot do for you.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPlan {
    /// PRETTY_NAME from os-release — the name the user recognises.
    pub os_label: String,
    /// None when no system package manager was found at all.
    pub package_manager: Option<String>,
    pub steps: Vec<SetupStepStatus>,
    pub git_name: Option<String>,
    pub git_email: Option<String>,
}

// --- actions ----------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActionSpec {
    Pull {
        #[serde(rename = "ref")]
        repo: RepoRef,
    },
    PullMany {
        refs: Vec<RepoRef>,
    },
    FetchAll {
        #[serde(rename = "ref")]
        repo: Option<RepoRef>,
    },
    FetchMany {
        refs: Vec<RepoRef>,
    },
    DevStart {
        #[serde(rename = "ref")]
        repo: RepoRef,
        /// Defaults to "dev".
        #[serde(default)]
        task: Option<String>,
    },
    DevStop {
        #[serde(rename = "ref")]
        repo: RepoRef,
        #[serde(default)]
        task: Option<String>,
    },
    Script {
        script: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// One of a repo's own one-shot package.json scripts — build, lint, format.
    ///
    /// `script` is caller-supplied but checked against `pkg::available_scripts` for
    /// that repo before it runs, exactly as `DevStart` checks `task`, so it can
    /// only ever name a script the repo already declares.
    RunScript {
        #[serde(rename = "ref")]
        repo: RepoRef,
        script: String,
    },
    /// One of the one-shot commands this repo's *ecosystem* offers — `flutter pub
    /// get`, `cargo clippy`, `./gradlew clean`.
    ///
    /// `chore` is caller-supplied but looked up in `chores::chores` for that repo,
    /// exactly as `script` is looked up in `available_scripts`. The argv is built in
    /// Rust from that lookup, never from the id.
    RunChore {
        #[serde(rename = "ref")]
        repo: RepoRef,
        chore: String,
    },
    Push {
        #[serde(rename = "ref")]
        repo: RepoRef,
        /// Rewrite the remote branch with --force-with-lease.
        #[serde(default)]
        force: bool,
    },
    /// Commit whatever is staged in one repo.
    ///
    /// The message is caller-supplied — the one action whose argv carries free text.
    /// That is safe because argv is passed to the child directly, never through a
    /// shell, so a message containing quotes, newlines or `$(…)` is just a message.
    Commit {
        #[serde(rename = "ref")]
        repo: RepoRef,
        message: String,
        /// Replace the previous commit instead of adding one. Rewrites history.
        #[serde(default)]
        amend: bool,
    },
    Stash {
        #[serde(rename = "ref")]
        repo: RepoRef,
        #[serde(default)]
        include_untracked: bool,
    },
    /// Re-apply the newest stash entry and drop it.
    StashPop {
        #[serde(rename = "ref")]
        repo: RepoRef,
    },
    /// Throw away all uncommitted work in one repo. High danger, typed confirm.
    DiscardChanges {
        #[serde(rename = "ref")]
        repo: RepoRef,
    },
    OpenInTerminal {
        script: String,
        #[serde(rename = "ref")]
        repo: Option<RepoRef>,
        /// Force the system terminal emulator instead of the integrated one.
        #[serde(default)]
        external: bool,
        #[serde(default)]
        size: Option<TermSize>,
    },
    /// Switch repos to a branch, applying `dirty` where needed.
    Checkout {
        refs: Vec<RepoRef>,
        /// None => each repo's own default branch, from origin/HEAD.
        #[serde(default)]
        branch: Option<String>,
        dirty: DirtyPolicy,
    },
    /// Opens a shell in a repo, or at the workspace root — in the integrated
    /// terminal by default, in the system emulator when `external`.
    OpenShell {
        #[serde(rename = "ref")]
        repo: Option<RepoRef>,
        #[serde(default)]
        external: bool,
        #[serde(default)]
        size: Option<TermSize>,
    },
    /// One step of the first-run setup. The id is opaque and resolved against the
    /// step table, so the command is never caller-supplied.
    SetupStep {
        id: String,
    },
    /// `git config --global user.name/user.email`. The only setup step that takes
    /// values from the user; both are validated and quoted before they run.
    GitIdentity {
        name: String,
        email: String,
    },
    /// Install one of a repo's *declared* dependencies at a chosen version.
    ///
    /// `package` is caller-supplied but looked up with `pkg::declared_dep` for that
    /// repo before any argv exists, the same closed-set gate `RunScript` holds
    /// against `available_scripts`. The manager, the install flag and the field all
    /// come from that lookup — none of them from the caller.
    UpgradeDep {
        #[serde(rename = "ref")]
        repo: RepoRef,
        package: String,
        /// None means whatever the registry considers latest.
        #[serde(default)]
        version: Option<String>,
    },
    Package {
        id: String,
        op: PackageOp,
        /// None means "whatever the manager considers current".
        #[serde(default)]
        version: Option<String>,
    },
    OpenInEditor {
        #[serde(rename = "ref")]
        repo: RepoRef,
        /// Binary name from Bootstrap.editors.
        editor: String,
    },
    DockerPs,
    /// Clone a list of remotes into a folder, setting up a new workspace.
    ///
    /// `root` is caller-supplied — the folder does not exist as a workspace yet, so
    /// it cannot come from state. Every clone target is `root/<validated name>`.
    CloneUrls {
        root: String,
        urls: Vec<String>,
    },
    KillPort {
        port: u16,
        #[serde(rename = "ref")]
        repo: Option<RepoRef>,
    },
    Status {
        #[serde(rename = "ref")]
        repo: RepoRef,
    },
    BranchList {
        #[serde(rename = "ref")]
        repo: RepoRef,
    },
    StashList {
        #[serde(rename = "ref")]
        repo: RepoRef,
    },
    /// `git log` for one repo, as a graph. Read-only.
    LogGraph {
        #[serde(rename = "ref")]
        repo: RepoRef,
    },
    /// `git diff` of the working tree. Read-only.
    Diff {
        #[serde(rename = "ref")]
        repo: RepoRef,
        /// Show the staged diff instead of the unstaged one.
        #[serde(default)]
        staged: bool,
    },
    PrList,
}

/// Initial terminal geometry, measured by the pane that will host it.
///
/// The one caller-supplied field the terminal path adds. It is numeric and
/// clamped in Rust, so it can influence how wide a session is but never *what*
/// runs in it — which is the invariant the gate exists to hold.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionIntent {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    /// What will run. For a bulk action this is the per-repo command rather than
    /// the whole generated script — a 60-line script rendered raw is unreadable,
    /// and the honest summary is "this command, in each of these repos".
    pub argv_preview: Vec<String>,
    /// True when `argv_preview` runs once per target rather than once in total.
    pub per_target: bool,
    /// The literal script, for the dialog's "show full command" disclosure. Only
    /// set when it differs from `argv_preview`.
    pub full_argv: Option<Vec<String>>,
    pub cwd: PathBuf,
    pub danger: Danger,
    pub warnings: Vec<String>,
    pub requires_typed_confirm: Option<String>,
    pub expires_unix: i64,
    pub targets: Vec<RepoRef>,
    pub read_only: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    pub categories: Option<Vec<Category>>,
    pub include_commits: Option<bool>,
    pub commit_limit: Option<u32>,
    pub force: Option<bool>,
}
