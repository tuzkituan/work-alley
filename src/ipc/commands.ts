import { invoke } from '@tauri-apps/api/core'
import { normalizeError } from './errors'
import type {
  ActionIntent,
  ActionSpec,
  Bootstrap,
  ChangedFile,
  CheckoutPreview,
  CommitEntry,
  PackageStatus,
  PackageVersion,
  PullRequestsResult,
  Config,
  DevServer,
  DockerStatus,
  FolderPick,
  ParsedUrls,
  RepoRef,
  RepoStatus,
  RunLogPage,
  RunSummary,
  ScanOptions,
  SetupPlan,
  WorkspaceSnapshot,
} from '@/domain/types'

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    throw normalizeError(e)
  }
}

export const api = {
  getBootstrap: () => call<Bootstrap>('get_bootstrap'),
  /** Native folder picker. Resolves to null when cancelled. */
  pickWorkspace: () => call<Bootstrap | null>('pick_workspace'),
  setWorkspace: (path: string) => call<Bootstrap>('set_workspace', { path }),
  /** Returns to the first-run picker without forgetting the folder. */
  closeWorkspace: () => call<Bootstrap>('close_workspace'),
  /** Folder picker that does not require the folder to be a workspace yet. */
  pickFolder: () => call<FolderPick | null>('pick_folder'),
  /** Read-only URL validation, safe to call as the user types. */
  parseCloneUrls: (text: string) => call<ParsedUrls>('parse_clone_urls', { text }),
  getConfig: () => call<Config>('get_config'),
  setConfig: (patch: Partial<Config>) => call<Config>('set_config', { patch }),

  /** Returns a scanId immediately; results arrive as scan:* events. */
  startScan: (opts?: ScanOptions) => call<string>('start_scan', { opts: opts ?? null }),
  cancelScan: (scanId: string) => call<void>('cancel_scan', { scanId }),
  getLastScan: () => call<WorkspaceSnapshot | null>('get_last_scan'),
  rescanRepo: (repo: RepoRef) => call<RepoStatus>('rescan_repo', { repo }),

  recentCommits: (limit?: number) => call<CommitEntry[]>('recent_commits', { limit }),
  dockerStatus: () => call<DockerStatus>('docker_status'),
  listDevServers: () => call<DevServer[]>('list_dev_servers'),
  listBranches: (repo: RepoRef) => call<string[]>('list_branches', { repo }),
  listPackages: () => call<PackageStatus[]>('list_packages'),
  /** The first-run setup path: every step, in order, with what is already done. */
  listSetupPlan: () => call<SetupPlan>('list_setup_plan'),
  /** Read-only: what a checkout would do, per repo. `branch` null = each default. */
  previewCheckout: (refs: RepoRef[], branch: string | null) =>
    call<CheckoutPreview[]>('preview_checkout', { refs, branch }),

  /** Installable versions for one tool. Empty when the manager cannot list them. */
  listPackageVersions: (id: string) => call<PackageVersion[]>('list_package_versions', { id }),
  listPullRequests: (repo: RepoRef) => call<PullRequestsResult>('list_pull_requests', { repo }),
  listChangedFiles: (repo: RepoRef) => call<ChangedFile[]>('list_changed_files', { repo }),
  repoCommits: (repo: RepoRef, limit?: number) =>
    call<CommitEntry[]>('repo_commits', { repo, limit }),

  listRuns: () => call<RunSummary[]>('list_runs'),
  getRunLog: (runId: string, fromSeq?: number) =>
    call<RunLogPage>('get_run_log', { runId, fromSeq: fromSeq ?? 0 }),
  cancelRun: (runId: string) => call<void>('cancel_run', { runId }),
  dismissRun: (runId: string) => call<void>('dismiss_run', { runId }),

  /** Phase 1 of the confirmation gate. No side effects. */
  prepareAction: (spec: ActionSpec) => call<ActionIntent>('prepare_action', { spec }),
  /** Phase 2. Takes only the opaque intent id. */
  runAction: (intentId: string, typedConfirm?: string) =>
    call<string>('run_action', { intentId, typedConfirm: typedConfirm ?? null }),
  cancelAction: (intentId: string) => call<void>('cancel_action', { intentId }),
}
