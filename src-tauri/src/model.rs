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
    /// Tasks this repo declares in package.json — "dev", "storybook".
    pub available_tasks: Vec<String>,
    /// Tasks currently running for this repo. Not a single `dev_server`, because a
    /// UI library commonly has dev and storybook up at the same time.
    pub tasks: Vec<DevServer>,
    /// Set => the rest is best-effort. A scan never fails wholesale.
    pub error: Option<String>,
    pub scan_ms: u64,
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
            tasks: Vec::new(),
            error: Some(msg.into()),
            scan_ms: 0,
        }
    }
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

/// What a repo appears to be, from its files. Detected, never configured.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoShape {
    pub kind: RepoKind,
    /// Frameworks and languages found, e.g. ["vite", "react", "storybook"].
    pub stack: Vec<String>,
    pub has_dockerfile: bool,
    pub is_monorepo: bool,
}

impl Default for RepoShape {
    fn default() -> Self {
        RepoShape {
            kind: RepoKind::Unknown,
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
    /// dnf / nvm / bun / npm / rustup / cargo
    pub manager: String,
    /// True when the operation must run in a terminal for a password prompt.
    pub needs_root: bool,
    pub removable: bool,
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
    pub warnings: Vec<String>,
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
