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
  /** Tasks this repo declares — "dev", "storybook". */
  availableTasks: string[]
  /** Tasks currently running. A UI library often has dev and storybook both up. */
  tasks: DevServer[]
  /** Set => the rest is best-effort. A scan never fails wholesale. */
  error: string | null
  scanMs: number
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

export interface DevServer {
  ref: RepoRef
  /** "dev" or "storybook". */
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
  /** Editors found on this machine, for the "open in…" action. */
  editors: EditorInfo[]
  scripts: ScriptDescriptor[]
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
}

/** gh is optional and often unauthenticated, so absence is data, not an error. */
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

export type ActionSpec =
  | { kind: 'pull'; ref: RepoRef }
  | { kind: 'pullMany'; refs: RepoRef[] }
  | { kind: 'fetchAll'; ref: RepoRef | null }
  | { kind: 'fetchMany'; refs: RepoRef[] }
  | { kind: 'devStart'; ref: RepoRef; task?: string }
  | { kind: 'devStop'; ref: RepoRef; task?: string }
  | { kind: 'script'; script: string; args: string[] }
  | { kind: 'openInTerminal'; script: string; ref: RepoRef | null }
  /** Opens the system terminal emulator. Read-only: skips the confirm dialog. */
  | { kind: 'openShell'; ref: RepoRef | null }
  /** `branch` omitted means each repo's own default, from origin/HEAD. */
  | { kind: 'checkout'; refs: RepoRef[]; branch?: string; dirty: DirtyPolicy }
  | { kind: 'openInEditor'; ref: RepoRef; editor: string }
  | { kind: 'package'; id: string; op: PackageOp; version?: string }
  | { kind: 'dockerPs' }
  | { kind: 'cloneUrls'; root: string; urls: string[] }
  | { kind: 'killPort'; port: number; ref: RepoRef | null }
  /** Read-only inspections. These skip the confirmation dialog. */
  | { kind: 'status'; ref: RepoRef }
  | { kind: 'branchList'; ref: RepoRef }
  | { kind: 'prList' }

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
