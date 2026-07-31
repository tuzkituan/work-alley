/**
 * The IPC contract, mirrored from src-tauri/src/model/*.rs.
 *
 * Rust serializes with `#[serde(rename_all = "camelCase")]` on every struct and
 * `#[serde(tag = "kind", rename_all = "camelCase")]` on every enum, so these
 * shapes are 1:1. Keep the two sides in lockstep — a rename on either side must
 * be made on both.
 */

/**
 * A group of repos, discovered rather than enumerated.
 *
 * A repo inside a subfolder takes that subfolder's name; a repo directly in the
 * workspace takes its detected kind ("frontend", "backend", …). Always read the
 * list from `Bootstrap.categories` — never hardcode it.
 */
export type Category = string

export interface RepoRef {
  category: Category
  name: string
}

/** `"frontend/my-app"` — the stable key used for maps and React keys. */
export type RepoId = string
export const repoId = (r: RepoRef): RepoId => `${r.category}/${r.name}`

/**
 * The inverse, splitting on the *first* slash.
 *
 * Lossy, and only a fallback: a repo name can contain a slash (a bare clone in a
 * nested folder), so this cannot always reconstruct what `repoId` was given.
 * Prefer `RepoStatus.ref`, which is the ref the backend actually resolved; reach
 * for this only before anything has been scanned.
 */
export const repoRefOf = (id: RepoId): RepoRef => {
  const at = id.indexOf('/')
  return at === -1
    ? { category: '', name: id }
    : { category: id.slice(0, at), name: id.slice(at + 1) }
}

export type SyncState =
  | { kind: 'noUpstream' }
  | { kind: 'inSync' }
  | { kind: 'diverged'; ahead: number; behind: number }

export type StaleState =
  | { kind: 'unknown' }
  | { kind: 'fresh'; lastFetchUnix: number }
  | { kind: 'stale'; lastFetchUnix: number; days: number }

export interface TrackedDep {
  declared: string | null
  resolved: string | null
  field: 'dependencies' | 'devDependencies' | 'peerDependencies' | null
}

export interface LastCommit {
  sha: string
  subject: string
  author: string
  unix: number
  relative: string
}

export type RepoKind = 'frontend' | 'backend' | 'library' | 'mobile' | 'docs' | 'unknown'

/** What a repo appears to be, from its files. Detected, never configured. */
export interface RepoShape {
  kind: RepoKind
  /**
   * Display name of the language this repo is mostly written in — "TypeScript",
   * "C++", "Rust". Null when there is no code to judge by. Also the axis the list
   * groups on when a folder holds more than one.
   */
  language: string | null
  /** Frameworks and languages found, e.g. ["vite", "react", "storybook"]. */
  stack: string[]
  hasDockerfile: boolean
  isMonorepo: boolean
}

export interface RepoStatus {
  ref: RepoRef
  path: string
  branch: string | null
  headSha: string | null
  detached: boolean
  dirtyCount: number
  untrackedCount: number
  conflictCount: number
  sync: SyncState
  stale: StaleState
  lastCommit: LastCommit | null
  trackedDep: TrackedDep
  /** Resolved from .env / vite.config, present whether or not a server runs. */
  devPort: number | null
  /** What this repo appears to be. */
  shape: RepoShape
  /** Long-running scripts this repo declares — "dev", "storybook". */
  availableTasks: string[]
  /** Every way this repo can be run, best first. Empty => nothing here runs. */
  runnable: RunnableTask[]
  /** `runnable`'s first entry — what a Run button starts. Null disables it. */
  primaryTask: string | null
  /** One-shot scripts this repo declares — "build", "lint", "format". */
  availableScripts: string[]
  /**
   * Run would fail: this repo runs a declared script and has no `node_modules`.
   * Only ever true for repos whose primary task goes through a package manager.
   */
  needsInstall: boolean
  /**
   * The manager this repo's own files imply — `packageManager`, then the
   * lockfile, then the machine's preference. Null when there is no package.json.
   */
  packageManager: string | null
  /**
   * One-shot commands this repo's *ecosystems* offer — `flutter pub get`,
   * `cargo clippy`, `./gradlew clean`. The non-JS counterpart of availableScripts.
   */
  chores: ChoreInfo[]
  /** What a Build button runs here. Null for a repo with no build step. */
  primaryBuild: BuildTarget | null
  /**
   * `https://github.com/owner/repo` for this repo's origin, when the host is one
   * the app is allowed to open. Null for a self-hosted forge or no remote — and
   * then shas and branch names render as plain text rather than dead links.
   */
  remoteWebBase: string | null
  /** Tasks currently running. A UI library often has dev and storybook both up. */
  tasks: DevServer[]
  /** Set => the rest is best-effort. A scan never fails wholesale. */
  error: string | null
  scanMs: number
}

/**
 * What a Build button acts on.
 *
 * Tagged, because the two dispatch different actions against different validated
 * sets — a script goes through `runScript`, a chore through `runChore`.
 */
export type BuildTarget =
  | { kind: 'script'; name: string; label: string }
  | { kind: 'chore'; id: string; label: string }

/** What one runnable task would execute, and whatever overrides it. */
export interface RunCommandPreview {
  /** "fe/web#dev" — how the override is keyed. */
  taskKey: string
  label: string
  /** Resolved from the repo's own files. Always the default, never the override. */
  defaultArgv: string[]
  overrideArgv: string[] | null
  cwd: string
}

export interface CommitEntry {
  ref: RepoRef
  sha: string
  subject: string
  author: string
  unix: number
  relative: string
}

export interface WorkspaceSnapshot {
  scanId: string
  startedUnix: number
  finishedUnix: number | null
  repos: RepoStatus[]
  commits: CommitEntry[]
  trackedLatest: string | null
  trackedLatestSource: 'published' | 'declared' | null
  okCount: number
  errorCount: number
  durationMs: number
}

export type Stream = 'stdout' | 'stderr' | 'meta'
export type Severity = 'cmd' | 'out' | 'ok' | 'warn' | 'err' | 'info'

export interface LogLine {
  /** Monotonic per run. Makes replay via get_run_log gap-free and dedupable. */
  seq: number
  stream: Stream
  severity: Severity
  text: string
  unix: number
  /** Set on bulk runs so interleaved repos can be rendered grouped. */
  repo: RepoId | null
}

export type RunStatus =
  | { kind: 'running' }
  | { kind: 'exited'; code: number }
  | { kind: 'signaled'; signal: number }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }

export interface RunSummary {
  runId: string
  kind: string
  title: string
  ref: RepoRef | null
  // Every repo this run touched. Bulk runs leave `ref` null, so this is what
  // says which rows went stale.
  targets: RepoRef[]
  argv: string[]
  cwd: string
  startedUnix: number
  endedUnix: number | null
  status: RunStatus
  lineCount: number
  truncated: boolean
}

export interface RunLogPage {
  lines: LogLine[]
  nextSeq: number
  truncated: boolean
  status: RunStatus
}

export type PortSource =
  | 'env'
  | 'viteConfigDefault'
  | 'configOverride'
  | 'detectedFromOutput'
  /** The convention for this kind of task — Django's 8000, Storybook's 6006. */
  | 'taskDefault'

/** One one-shot command a repo's ecosystem offers. */
export interface ChoreInfo {
  /** What a `runChore` action passes back. */
  id: string
  /** The command as you would type it — "flutter pub get", "./gradlew clean". */
  label: string
  /** Submenu heading: "Flutter", "Gradle", "Django". */
  group: string
  /** Deletes build output or rewrites files, so it is confirmed first. */
  destructive: boolean
}

export interface RunnableTask {
  /** What a `devStart` action passes back as `task`. */
  id: string
  /** Goes after "Start" / "Stop": "dev", "cargo run", "runserver". */
  label: string
  port: number | null
}

export interface DevServer {
  ref: RepoRef
  /** A `RunnableTask.id` — "dev", "storybook", "cargo", "django". */
  task: string
  runId: string
  pid: number
  command: string[]
  port: number | null
  portSource: PortSource | null
  state: 'starting' | 'up' | 'stopping' | 'crashed'
  url: string | null
  startedUnix: number
}

export interface ContainerPort {
  host: number | null
  container: number
  proto: string
}

export interface DockerService {
  id: string
  name: string
  image: string
  state: string
  status: string
  uptimeSeconds: number | null
  ports: ContainerPort[]
}

export type ContainerRuntime = 'docker' | 'podman'

export type DockerStatus =
  | { kind: 'notInstalled' }
  | { kind: 'daemonDown'; runtime: ContainerRuntime; message: string }
  | { kind: 'timedOut'; runtime: ContainerRuntime }
  | { kind: 'ok'; runtime: ContainerRuntime; services: DockerService[]; fetchedUnix: number }

export interface EditorInfo {
  /** Binary name, used as the action's editor id. */
  id: string
  label: string
  path: string
}

export interface ToolInfo {
  name: string
  path: string | null
  version: string | null
}

export interface ScriptArg {
  name: string
  kind: 'enum' | 'text'
  options: string[] | null
  default: string | null
}

export interface ScriptDescriptor {
  id: string
  file: string
  title: string
  description: string
  /** `terminalOnly` scripts prompt interactively and cannot be driven headless. */
  mode: 'headless' | 'terminalOnly'
  danger: Danger
  requiredTools: string[]
  argSchema: ScriptArg[]
  /** e.g. a script that exits 1 for "drift detected" — not a failure. */
  nonZeroExitMeaning: string | null
  /** Short mono hint shown in the rail, e.g. "gh" / "npm" / "git". */
  hint: string
}

export interface CategoryInfo {
  category: Category
  /** Display name — the folder name, or the workspace name for the root group. */
  label: string
  present: boolean
  /** Repos on disk with a .git. */
  repoCount: number
  /** Repos declared in repos.json, when the workspace has one. */
  declaredCount: number
}

export interface Config {
  workspaceRoot: string
  staleDays: number
  scanConcurrency: number
  recentCommitLimit: number
  /** Pins the shared package to track; null means "detect it". */
  trackedPackage: string | null
  devCommandOverrides: Record<string, string[]>
  portOverrides: Record<string, number>
  maxLogLinesPerRun: number
  /**
   * Minutes between background fetches; 0 turns it off.
   *
   * Every sync number is computed from local refs, so without this a workspace left
   * open reports "in sync" with growing confidence and shrinking accuracy.
   */
  autoFetchMinutes: number
  /** Open the folder that was open when the app last quit, instead of the picker. */
  reopenLastWorkspace: boolean
  /** Chosen languages/frameworks. Empty means no opinion — everything is shown. */
  stacks: string[]
  /**
   * Which package manager to use when a repo does not say. Null = whichever is
   * installed. A repo with a lockfile or a `packageManager` field is unaffected.
   */
  preferredPackageManager: string | null
}

/**
 * The writable subset of Config.
 *
 * Mirrors the Rust `ConfigPatch` field for field, deliberately narrower than
 * `Partial<Config>`: `workspaceRoot`, `trackedPackage` and the rest are not
 * patchable, and typing them as writable promised saves the backend silently
 * drops. Every numeric field is clamped in Rust — the returned Config is the
 * authority on what was actually stored.
 */
export interface ConfigPatch {
  staleDays?: number
  scanConcurrency?: number
  recentCommitLimit?: number
  maxLogLinesPerRun?: number
  /** 0 turns background fetching off. */
  autoFetchMinutes?: number
  reopenLastWorkspace?: boolean
  /** `null` clears the choice, i.e. back to auto. */
  preferredPackageManager?: string | null
  devCommandOverrides?: Record<string, string[]>
  portOverrides?: Record<string, number>
  /** Replaces the list. `[]` is a real value: show everything again. */
  stacks?: string[]
}

/**
 * Whether this machine can do what the dashboard offers.
 *
 * Distinct from `toolsReady`, which only says the probe finished — it is true on a
 * machine with nothing installed, which is why every button used to be live where
 * every button failed. See src-tauri/src/readiness.rs.
 */
export interface Readiness {
  toolsReady: boolean
  /** Tool ids the app cannot work without. Empty means it can. */
  missingRequired: string[]
  gitIdentity: boolean
  /**
   * An ssh key in an agent, or a signed-in gh. Reported but deliberately *not* part
   * of `ready`: cloning over HTTPS with a credential helper is a valid setup.
   */
  credentials: boolean
  ready: boolean
}

export interface Bootstrap {
  appVersion: string
  /** False while the toolchain probe is still running. */
  toolsReady: boolean
  /** False when no workspace has been chosen yet, or the saved one is gone. */
  hasWorkspace: boolean
  /** Recently opened workspaces, newest first. */
  recentRoots: string[]
  workspaceRoot: string
  categories: CategoryInfo[]
  /** Every repo on disk, so the whole chrome can paint before any git runs. */
  repos: RepoRef[]
  config: Config
  tools: ToolInfo[]
  /**
   * The package manager a repo that states none will actually get — the Settings
   * choice when installed, else the fastest that is. Resolved by the backend so
   * the UI and the runner cannot disagree about what is being run.
   */
  packageManager: string | null
  /** Editors found on this machine, for the "open in…" action. */
  editors: EditorInfo[]
  /** Terminal coding agents — claude, codex, opencode. Opened in a pty. */
  agents: EditorInfo[]
  scripts: ScriptDescriptor[]
  readiness: Readiness
  /** First-run onboarding was finished, or explicitly skipped. Both count. */
  onboardingCompleted: boolean
  /**
   * The shared package whose version drift is tracked, detected from what the
   * repos depend on. Null in a workspace with no shared package — the column is
   * hidden rather than shown empty.
   */
  trackedPackage: string | null
  /**
   * The user's home directory, for abbreviating paths to `~/…`. Sent rather than
   * assumed: it is `/home/x` on Linux and `/Users/x` on macOS.
   */
  homeDir: string | null
  /**
   * Which OS this is. Sent rather than sniffed from the user agent, which under a
   * webview says more about the renderer than about the machine.
   *
   * `'windows' | 'macos' | 'linux'` in practice, but typed as a string because it is
   * Rust's `std::env::consts::OS` and that list is longer than the three we handle.
   */
  os: string
  warnings: string[]
}

export interface PullRequest {
  number: number
  title: string
  author: string
  headRef: string
  baseRef: string
  isDraft: boolean
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / '' */
  reviewDecision: string
  url: string
  additions: number
  deletions: number
  changedFiles: number
  updatedUnix: number
  updatedRelative: string
  isMine: boolean
  /**
   * CI rolled up to one word. `''` means the repo has no checks configured, which is
   * not the same as passing and must not render as green.
   */
  checks: '' | 'passing' | 'failing' | 'pending'
  labels: string[]
  /** gh's mergeable: MERGEABLE / CONFLICTING / UNKNOWN, or ''. */
  mergeable: string
}

/** gh is optional and often unauthenticated, so absence is data, not an error. */
// --- github actions ---------------------------------------------------------

/**
 * What a workflow run is doing, from gh's (status, conclusion) pair.
 *
 * Named `WorkflowRunState`, not `RunState`: `RunStatus` in this file is already
 * the state of *this app's* own processes, and the Actions tab sits next to a
 * Runs tab that means that other thing.
 */
export type WorkflowRunState =
  | 'queued'
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'
  /** skipped / neutral / stale — "did not apply", not "went wrong". */
  | 'skipped'
  /** A deployment waiting on approval. The only state that wants a click. */
  | 'actionRequired'
  | 'unknown'

export interface WorkflowRun {
  /** gh's databaseId — what every `gh run` subcommand takes. */
  id: number
  /** Per-workflow run number: the #5356 github.com shows. */
  number: number
  attempt: number
  /** The commit subject, or the dispatch title. */
  title: string
  /** Empty for runs created by an org ruleset. The row still renders. */
  workflowName: string
  workflowId: number
  event: string
  branch: string
  headSha: string
  /** Raw gh values, for the row's tooltip. */
  status: string
  conclusion: string
  state: WorkflowRunState
  url: string
  createdUnix: number
  startedUnix: number
  updatedUnix: number
  /** Zero while queued and when a timestamp did not parse. Never negative. */
  durationSecs: number
  updatedRelative: string
}

export interface Workflow {
  id: number
  name: string
  /** `.github/workflows/ci.yml`. What the runs query filters on. */
  path: string
  /** active / disabled_manually / disabled_inactivity, verbatim. */
  state: string
}

/**
 * The Node package managers this app knows how to drive.
 *
 * Mirrors `pkg::MANAGERS` in Rust, which is what actually validates a choice —
 * this is only the order they are offered in.
 */
export const MANAGERS = ['bun', 'pnpm', 'yarn', 'npm'] as const

/** One `workflow_dispatch` input, as the form needs it. */
export interface WorkflowInput {
  name: string
  description: string
  required: boolean
  /** string / boolean / choice / number / environment. Anything else is a text field. */
  kind: string
  default: string
  /** Only for `type: choice`. */
  options: string[]
}

export type WorkflowDispatchResult =
  | { kind: 'ghMissing' }
  | { kind: 'notAuthenticated'; message: string }
  | { kind: 'noRemote' }
  | { kind: 'failed'; message: string }
  /** No `workflow_dispatch:` trigger — GitHub offers no way to start it by hand. */
  | { kind: 'notDispatchable' }
  /** Dispatchable. An empty `inputs` is common and is not `notDispatchable`. */
  | { kind: 'ok'; inputs: WorkflowInput[] }

export type WorkflowsResult =
  | { kind: 'ghMissing' }
  | { kind: 'notAuthenticated'; message: string }
  | { kind: 'noRemote' }
  | { kind: 'failed'; message: string }
  /** An empty list means the repo has no workflows — a state to render. */
  | { kind: 'ok'; slug: string; workflows: Workflow[] }

export type WorkflowRunsResult =
  | { kind: 'ghMissing' }
  | { kind: 'notAuthenticated'; message: string }
  | { kind: 'noRemote' }
  | { kind: 'failed'; message: string }
  | { kind: 'ok'; slug: string; runs: WorkflowRun[]; fetchedUnix: number }

export type PullRequestsResult =
  | { kind: 'ghMissing' }
  | { kind: 'notAuthenticated'; message: string }
  | { kind: 'noRemote' }
  | { kind: 'failed'; message: string }
  | { kind: 'ok'; slug: string; prs: PullRequest[]; fetchedUnix: number }

export interface ChangedFile {
  path: string
  code: string
  staged: boolean
  untracked: boolean
  conflicted: boolean
  /**
   * Lines added and removed, staged and unstaged summed. Both zero for an untracked
   * file (nothing to diff against), a binary file, or when the diff could not be
   * read — so zero means "no count", not "no change".
   */
  added: number
  deleted: number
}

/** One branch, local or remote-only. */
export interface BranchInfo {
  /** Without any `origin/` prefix — what you would type to check it out. */
  name: string
  /** False => it exists only on the remote, and checking it out creates it here. */
  local: boolean
  upstream: string | null
  /** Relative to `upstream`. Both zero when there is none, or it is `[gone]`. */
  ahead: number
  behind: number
  lastCommitUnix: number | null
  tipSha: string | null
  subject: string | null
}

export interface StashEntry {
  /** `stash@{0}` — what you would pass to `git stash apply`. */
  selector: string
  message: string
  unix: number
  relative: string
}

export type PackageOp = 'install' | 'upgrade' | 'remove'

export interface ToolPackage {
  id: string
  label: string
  description: string
  group: string
  /** dnf / nvm / bun / npm / rustup / cargo */
  manager: string
  /** True when the operation opens a terminal for a password prompt. */
  needsRoot: boolean
  removable: boolean
}

export interface PackageStatus {
  package: ToolPackage
  installed: boolean
  path: string | null
  version: string | null
  /** False when the managing tool itself is missing, so actions are impossible. */
  managerAvailable: boolean
}

/** An upgrade a manager reports as available for an installed tool. */
export interface PackageUpdate {
  /** Catalog id, matching ToolPackage.id. */
  id: string
  /** Null when the manager says "outdated" without naming the new version. */
  latest: string | null
}

/**
 * One update check across every manager on this machine.
 *
 * `checked` matters as much as `updates`: only ids listed there have a real
 * answer, so a manager that could not be reached — or cannot answer at all, like
 * `bun upgrade` — keeps its Upgrade button rather than looking up to date.
 */
export interface UpdateReport {
  checked: string[]
  updates: PackageUpdate[]
}

// --- repo dependencies ------------------------------------------------------

/** Which block of package.json declares a dependency. Decides the install flag. */
export type DepField = 'dependencies' | 'devDependencies' | 'peerDependencies'

/** One line of a repo's dependency table. */
export interface RepoDep {
  name: string
  field: DepField
  /** Verbatim from package.json: "^1.2.3", "workspace:*", a git URL. */
  range: string
  /** From node_modules/<name>/package.json. Null when it is not installed here. */
  installed: string | null
  /** A location range — workspace:/file:/link:/git/http. Not upgradable from here. */
  linked: boolean
}

export interface RepoPackages {
  hasManifest: boolean
  /**
   * Which file the table came from — `package.json`, `pubspec.yaml`.
   *
   * The copy on this panel used to name package.json unconditionally, which told a
   * Flutter developer with 30 dependencies that their repo had none.
   */
  manifest: string | null
  /** npm / pnpm / yarn / bun / flutter pub. Null when the repo has no manifest. */
  manager: string | null
  /** Whether node_modules exists — "nothing installed" vs "this one is missing". */
  installedTree: boolean
  deps: RepoDep[]
}

export interface DepUpdate {
  name: string
  /** Null when the manager reported the row without naming a version. */
  latest: string | null
  /** The newest version the declared range already allows. */
  wanted: string | null
}

/**
 * What one repo's package manager says is out of date.
 *
 * `checked` carries the same weight as UpdateReport's: false means nobody could be
 * asked — offline, a timeout, Yarn PnP — and the panel must say so rather than
 * render every dependency as current.
 */
export interface DepUpdateReport {
  checked: boolean
  /** Which tool answered: npm / pnpm / yarn. Empty when none did. */
  source: string
  updates: DepUpdate[]
  /** Why nothing could be checked, shown as a note rather than an error. */
  reason: string | null
}

// --- first-run setup --------------------------------------------------------

/** One thing a setup step is responsible for: a package, or half of the identity. */
export interface SetupItem {
  id: string
  label: string
  installed: boolean
  /** False when this machine's package manager does not carry it at all. */
  available: boolean
  version: string | null
}

/**
 * How the step runs. `gitIdentity` is the only one rendered as a form; the rest
 * are one button.
 */
export type SetupStepKind =
  | 'system'
  | 'npmGlobal'
  | 'script'
  | 'node'
  | 'gitIdentity'
  /** Two routes to one outcome, so this step has no command of its own. */
  | 'credentials'

export interface SetupStepStatus {
  id: string
  title: string
  summary: string
  /** Why this step is here, and here rather than later. */
  why: string
  kind: SetupStepKind
  /** The manager it will use — dnf, apt-get, npm, nvm, curl, git. */
  manager: string
  needsRoot: boolean
  optional: boolean
  items: SetupItem[]
  done: boolean
  /** What has to happen first. Null when the step can run now. */
  blocked: string | null
  /** The command it would run. Empty when it cannot be planned yet. */
  commandPreview: string[]
  /** Something the command cannot do for you. */
  note: string | null
}

export interface SetupPlan {
  osLabel: string
  packageManager: string | null
  steps: SetupStepStatus[]
  gitName: string | null
  gitEmail: string | null
}

export type Danger = 'low' | 'medium' | 'high'

export interface FolderPick {
  path: string
  /** Non-hidden entries already there, so the UI can warn before cloning into it. */
  entryCount: number
}

/** What "checkout to the default branch" would do to one repo. */
export interface CheckoutPreview {
  ref: RepoRef
  current: string | null
  /**
   * The branch this repo would end up on. Null means unknown (no origin/HEAD) or
   * absent here, so the repo is skipped rather than guessed at.
   */
  target: string | null
  /** False when a named branch exists neither locally nor on origin. */
  targetExists: boolean
  dirtyCount: number
  alreadyThere: boolean
}

/** What to do about repos with local changes when switching branches. */
export type DirtyPolicy = 'skip' | 'stash' | 'discard'

export interface PackageVersion {
  /** Passed back as ActionSpec.version. */
  value: string
  label: string
  /** "LTS", "latest", "recommended" — shown beside the label. */
  note: string | null
}

export interface ParsedRepoUrl {
  url: string
  name: string
  host: string
}

export interface RejectedUrlLine {
  /** 1-based, matching the textarea. */
  line: number
  text: string
  reason: string
}

export interface ParsedUrls {
  repos: ParsedRepoUrl[]
  rejected: RejectedUrlLine[]
}

/** Initial terminal geometry, measured by the pane that will host the session. */
export interface TermSize {
  cols: number
  rows: number
}

/** One integrated terminal session, as Rust reports it. */
export interface TermInfo {
  termId: string
  /**
   * What the session is for: 'shell', 'script' or 'package'. Package sessions are
   * the Toolbox's and the setup page's installs, which is how those full-window
   * pages know which tabs are theirs to show.
   */
  kind: string
  title: string
  argv: string[]
  cwd: string
  repo: RepoRef | null
  startedUnix: number
  pid: number
  alive: boolean
  cols: number
  rows: number
}

export interface TermOutput {
  termId: string
  /** Base64 of the raw pty bytes. Decoded straight into xterm, never into state. */
  data: string
}

export interface TermExit {
  termId: string
  code: number
  endedUnix: number
}

export type ActionSpec =
  | { kind: 'pull'; ref: RepoRef }
  | { kind: 'pullMany'; refs: RepoRef[] }
  | { kind: 'fetchAll'; ref: RepoRef | null }
  | { kind: 'fetchMany'; refs: RepoRef[] }
  | { kind: 'devStart'; ref: RepoRef; task?: string; manager?: string }
  | { kind: 'devStop'; ref: RepoRef; task?: string }
  | { kind: 'script'; script: string; args: string[] }
  /**
   * One of the repo's own package.json scripts. Validated against
   * availableScripts; `manager` overrides the detected one for this run only.
   */
  | { kind: 'runScript'; ref: RepoRef; script: string; manager?: string }
  /** One of the repo's ecosystem commands. Validated against chores. */
  | { kind: 'runChore'; ref: RepoRef; chore: string; manager?: string }
  | { kind: 'push'; ref: RepoRef; force?: boolean }
  /**
   * The one action carrying free text. Safe because Rust passes argv straight to
   * the child — never through a shell — so quotes and newlines in a message are
   * just a message.
   */
  | { kind: 'commit'; ref: RepoRef; message: string; amend?: boolean }
  | { kind: 'stash'; ref: RepoRef; includeUntracked?: boolean }
  | { kind: 'stashPop'; ref: RepoRef }
  | { kind: 'discardChanges'; ref: RepoRef }
  | {
      kind: 'openInTerminal'
      script: string
      ref: RepoRef | null
      /** Force the system terminal emulator instead of an integrated tab. */
      external?: boolean
      size?: TermSize
    }
  /** Opens a shell. Read-only: skips the confirm dialog. */
  | { kind: 'openShell'; ref: RepoRef | null; external?: boolean; size?: TermSize }
  /** `branch` omitted means each repo's own default, from origin/HEAD. */
  | { kind: 'checkout'; refs: RepoRef[]; branch?: string; dirty: DirtyPolicy }
  | { kind: 'openInEditor'; ref: RepoRef; editor: string }
  /** A coding agent on a repo, in the integrated terminal — they are TUIs. */
  | { kind: 'openAgent'; ref: RepoRef; agent: string; external?: boolean; size?: TermSize }
  | { kind: 'package'; id: string; op: PackageOp; version?: string }
  /**
   * Install one of a repo's declared dependencies. `version` omitted = latest.
   *
   * Validated against that repo's package.json in Rust, which also picks the
   * manager and the --save-dev/--save-peer flag from the field it is declared in.
   */
  | { kind: 'upgradeDep'; ref: RepoRef; package: string; version?: string }
  /** One step of the first-run setup. The id is resolved against the step table. */
  | { kind: 'setupStep'; id: string }
  | { kind: 'gitIdentity'; name: string; email: string }
  /**
   * Switch to a stored git account. `ref` omitted = globally, which is also the
   * only scope that moves `gh` — it has one active account per machine.
   *
   * The id is resolved against the stored list in Rust, so nothing on the command
   * line comes from here.
   */
  | { kind: 'useGitAccount'; id: string; ref?: RepoRef }
  | { kind: 'dockerPs' }
  | { kind: 'cloneUrls'; root: string; urls: string[] }
  | { kind: 'killPort'; port: number; ref: RepoRef | null }
  /** Read-only inspections. These skip the confirmation dialog. */
  | { kind: 'status'; ref: RepoRef }
  | { kind: 'branchList'; ref: RepoRef }
  | { kind: 'stashList'; ref: RepoRef }
  | { kind: 'logGraph'; ref: RepoRef }
  | { kind: 'diff'; ref: RepoRef; staged?: boolean }
  | { kind: 'prList' }
  /** One workflow run's log, into the output pane. Read-only. */
  | { kind: 'ghRunLog'; ref: RepoRef; runId: number; failedOnly?: boolean }
  | { kind: 'ghRunRerun'; ref: RepoRef; runId: number; failedOnly?: boolean }
  | { kind: 'ghRunCancel'; ref: RepoRef; runId: number }
  /** `workflow_dispatch`. Values are free text; keys are checked in Rust. */
  | {
      kind: 'ghWorkflowRun'
      ref: RepoRef
      workflow: string
      gitRef: string
      inputs: [string, string][]
    }

export interface ActionIntent {
  id: string
  kind: string
  title: string
  description: string
  /** For bulk actions this is the per-repo command, not the whole script. */
  argvPreview: string[]
  /** True when argvPreview runs once per target rather than once in total. */
  perTarget: boolean
  /** The literal script, revealed behind a disclosure. Only set when it differs. */
  fullArgv: string[] | null
  cwd: string
  danger: Danger
  warnings: string[]
  requiresTypedConfirm: string | null
  expiresUnix: number
  /** Repos this action touches — rendered as a review list for bulk actions. */
  targets: RepoRef[]
  /** True for read-only inspections, which the UI runs without a dialog. */
  readOnly: boolean
}

export interface ScanOptions {
  categories?: Category[]
  includeCommits?: boolean
  commitLimit?: number
  force?: boolean
}

// --- events -----------------------------------------------------------------

export interface ScanStarted {
  scanId: string
  total: number
  categories: Category[]
}
export interface ScanRepo {
  scanId: string
  repo: RepoStatus
}
export interface ScanCommits {
  scanId: string
  commits: CommitEntry[]
}
export interface ScanFinished {
  scanId: string
  snapshot: WorkspaceSnapshot
}
export interface RunOutput {
  runId: string
  lines: LogLine[]
}
export interface RunExit {
  runId: string
  status: RunStatus
  endedUnix: number
  durationMs: number
  lineCount: number
  truncated: boolean
}

// --- derived UI vocabulary --------------------------------------------------

export type NeedsYouKind =
  | 'uncommitted'
  | 'behind'
  | 'stale'
  | 'error'
  | 'packageDrift'
  | 'detached'

/** One row of the stack picker — a language or framework the app knows. */
export interface StackInfo {
  id: string
  label: string
  hint: string
  /** 'web' | 'mobile' | 'backend' | 'systems' | 'infra' — the picker's headings. */
  family: string
  familyLabel: string
  /** Explicitly chosen. All false means "no opinion", which shows everything. */
  chosen: boolean
  /** Repos in this workspace that look like it. 0 before the first scan. */
  repos: number
  toolsInstalled: number
  toolsTotal: number
}

/**
 * One git identity this machine can switch to.
 *
 * Holds no secrets — a *path* to a key and the *name* of a gh login. The key stays
 * in ~/.ssh and the token stays in gh's keyring; see `accounts.rs`.
 */
export interface GitAccount {
  /** Stable across renames. Generated from the label when a new one is saved. */
  id: string
  label: string
  name: string
  email: string
  /** Written as `core.sshCommand`, with IdentitiesOnly so the agent cannot win. */
  sshKey: string | null
  /** `user.signingkey`. Does not turn on `commit.gpgsign`. */
  signingKey: string | null
  /** A gh login to make active. Global scope only. */
  ghUser: string | null
  /**
   * An ssh host alias — `github.com-work` — written into ~/.ssh/config.
   *
   * The per-*remote* half of the same idea as `sshKey`: a URL written as
   * `git@github.com-work:owner/repo.git` picks the key, which survives a fresh
   * clone and a submodule in a way `core.sshCommand` does not.
   */
  sshHost: string | null
  /** What the alias points at. Defaults to github.com. */
  sshHostname: string | null
}

/** One `Host` block already in ~/.ssh/config. */
export interface SshHostEntry {
  host: string
  /** Any further patterns on the same `Host` line. */
  aliases: string[]
  hostname: string | null
  user: string | null
  identityFile: string | null
  identitiesOnly: boolean
  /** The `# comment` directly above it — usually the human name for it. */
  comment: string | null
  /** Inside the app's markers, so it is already ours. */
  managed: boolean
}

/** What the app would write into ~/.ssh/config, and whether it differs. */
export interface SshConfigPreview {
  path: string
  exists: boolean
  /** Empty means applying *removes* the managed block. */
  managed: string
  changed: boolean
  /** A managed block that cannot be replaced safely. Blocks the write. */
  error: string | null
  /** Every Host block in the file. Unmanaged ones can be imported as accounts. */
  entries: SshHostEntry[]
}

/** A login `gh` is signed in as on this machine. */
export interface GhAccount {
  login: string
  host: string
  active: boolean
}

export interface AccountsView {
  accounts: GitAccount[]
  /** What ~/.gitconfig holds right now — read every time, never assumed. */
  globalName: string | null
  globalEmail: string | null
  /** Which stored account the global identity matches. Matched on email. */
  activeId: string | null
  ghAccounts: GhAccount[]
  ghPresent: boolean
}
