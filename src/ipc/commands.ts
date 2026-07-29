import { invoke } from '@tauri-apps/api/core'
import { normalizeError } from './errors'
import type {
  ActionIntent,
  ActionSpec,
  Bootstrap,
  ChangedFile,
  CommitEntry,
  PackageStatus,
  PullRequestsResult,
  Config,
  DevServer,
  DockerStatus,
  RepoRef,
  RepoStatus,
  RunLogPage,
  RunSummary,
  ScanOptions,
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
