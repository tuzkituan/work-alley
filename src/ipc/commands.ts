import { invoke } from '@tauri-apps/api/core'
import { normalizeError } from './errors'
import type {
  AccountsView,
  ActionIntent,
  ActionSpec,
  Bootstrap,
  BranchInfo,
  ChangedFile,
  CheckoutPreview,
  CommitEntry,
  ConfigPatch,
  DepUpdateReport,
  PackageStatus,
  PackageVersion,
  PullRequestsResult,
  Config,
  DevServer,
  DockerStatus,
  FolderPick,
  GitAccount,
  ParsedUrls,
  RepoPackages,
  RepoRef,
  RepoStatus,
  RunCommandPreview,
  RunLogPage,
  RunSummary,
  ScanOptions,
  SetupPlan,
  SshConfigPreview,
  ToolInfo,
  StashEntry,
  TermInfo,
  UpdateReport,
  WorkflowDispatchResult,
  WorkflowRunsResult,
  WorkflowsResult,
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
  setConfig: (patch: ConfigPatch) => call<Config>('set_config', { patch }),

  /** Returns a scanId immediately; results arrive as scan:* events. */
  startScan: (opts?: ScanOptions) => call<string>('start_scan', { opts: opts ?? null }),
  cancelScan: (scanId: string) => call<void>('cancel_scan', { scanId }),
  getLastScan: () => call<WorkspaceSnapshot | null>('get_last_scan'),
  rescanRepo: (repo: RepoRef) => call<RepoStatus>('rescan_repo', { repo }),

  recentCommits: (limit?: number) => call<CommitEntry[]>('recent_commits', { limit }),
  dockerStatus: () => call<DockerStatus>('docker_status'),
  listDevServers: () => call<DevServer[]>('list_dev_servers'),
  listBranches: (repo: RepoRef) => call<BranchInfo[]>('list_branches', { repo }),
  listStashes: (repo: RepoRef) => call<StashEntry[]>('list_stashes', { repo }),
  /**
   * The patch for one changed file. `path` must be one the repo currently reports as
   * changed — Rust rejects anything else, which is what keeps this from reading
   * arbitrary files.
   */
  fileDiff: (repo: RepoRef, path: string, staged: boolean) =>
    call<string>('file_diff', { repo, path, staged }),
  /**
   * Index-only, and so deliberately not an ActionSpec: staging changes neither the
   * working tree nor history, and a confirmation dialog per file click would make
   * the feature unusable. Both return the repo's fresh changed-file list, so the
   * panel updates from the authoritative answer instead of guessing.
   */
  stagePaths: (repo: RepoRef, paths: string[], all = false) =>
    call<ChangedFile[]>('stage_paths', { repo, paths, all }),
  unstagePaths: (repo: RepoRef, paths: string[], all = false) =>
    call<ChangedFile[]>('unstage_paths', { repo, paths, all }),
  listPackages: () => call<PackageStatus[]>('list_packages'),
  /**
   * Re-runs the toolchain probe.
   *
   * Call this after anything installs a tool. Without it the backend's resolved
   * paths are whatever they were at launch, so the setup page's next step keeps
   * refusing to run against a tool that is already on disk.
   */
  refreshToolchain: () => call<ToolInfo[]>('refresh_toolchain'),
  /** Records first-run onboarding as over. Skipping counts, deliberately. */
  completeOnboarding: () => call<Bootstrap>('complete_onboarding'),
  /** Stored git identities, plus what the machine's config and gh actually say. */
  listGitAccounts: () => call<AccountsView>('list_git_accounts'),
  /** Adds or updates one. Writes config.json only — applying it is an action. */
  saveGitAccount: (account: GitAccount) => call<AccountsView>('save_git_account', { account }),
  /** Forgets one. Leaves whatever it wrote to git config in place. */
  deleteGitAccount: (id: string) => call<AccountsView>('delete_git_account', { id }),
  /** Drops one folder from the recents list. Deletes nothing on disk. */
  forgetRecentRoot: (path: string) => call<Bootstrap>('forget_recent_root', { path }),
  /** What the app would write into ~/.ssh/config. Reads only. */
  previewSshConfig: () => call<SshConfigPreview>('preview_ssh_config'),
  /** Writes the managed block, keeping everything outside the markers. */
  applySshConfig: () => call<string>('apply_ssh_config'),
  /** The first-run setup path: every step, in order, with what is already done. */
  listSetupPlan: () => call<SetupPlan>('list_setup_plan'),
  /** Read-only: what a checkout would do, per repo. `branch` null = each default. */
  previewCheckout: (refs: RepoRef[], branch: string | null) =>
    call<CheckoutPreview[]>('preview_checkout', { refs, branch }),

  /** Installable versions for one tool. Empty when the manager cannot list them. */
  listPackageVersions: (id: string) => call<PackageVersion[]>('list_package_versions', { id }),
  /**
   * Which installed tools have a newer version. Slow — one bulk query per manager,
   * hitting mirrors and registries — so it is its own call rather than part of
   * listPackages.
   */
  checkPackageUpdates: () => call<UpdateReport>('check_package_updates'),

  /**
   * Clears a finished dev row. Refuses while a run is still live for it, so this
   * can never be a way to lose a running server — the button for that is Stop.
   * Omitting `task` clears every finished row for the repo.
   */
  forgetDev: (ref: RepoRef, task?: string) => call<void>('forget_dev', { repo: ref, task }),

  /**
   * What one task would run, and any override. Read-only — unlike prepareAction it
   * parks no intent, works while the task is up, and reports the *default* argv.
   */
  previewRunCommand: (repo: RepoRef, task: string) =>
    call<RunCommandPreview>('preview_run_command', { repo, task }),
  /** Sets or clears one task's command override. Null or empty clears it. */
  setRunCommand: (repo: RepoRef, task: string, argv: string[] | null) =>
    call<Config>('set_run_command', { repo, task, argv }),

  /** One repo's dependency table. Local only: manifest plus node_modules. */
  listRepoPackages: (repo: RepoRef) => call<RepoPackages>('list_repo_packages', { repo }),
  /**
   * Which of a repo's dependencies are behind. The slow half — it asks the repo's
   * package manager, which asks a registry — so it is its own call, and a manager
   * that could not answer comes back as `checked: false` rather than an error.
   */
  checkRepoPackageUpdates: (repo: RepoRef) =>
    call<DepUpdateReport>('check_repo_package_updates', { repo }),
  /** Published versions of one declared dependency. Empty when nobody could list them. */
  listDepVersions: (repo: RepoRef, pkg: string) =>
    call<PackageVersion[]>('list_dep_versions', { repo, package: pkg }),

  listPullRequests: (repo: RepoRef) => call<PullRequestsResult>('list_pull_requests', { repo }),
  /** Every workflow the repo defines, including disabled ones. Read-only. */
  listWorkflows: (repo: RepoRef) => call<WorkflowsResult>('list_workflows', { repo }),
  /**
   * The last 50 workflow runs, optionally for one workflow — by *path*, which is
   * what survives a rename.
   */
  listWorkflowRuns: (repo: RepoRef, workflow?: string) =>
    call<WorkflowRunsResult>('list_workflow_runs', { repo, workflow: workflow ?? null }),
  /**
   * Whether a workflow can be started by hand, and what it asks for. Reads the
   * workflow's YAML — the REST API does not expose dispatch inputs at all.
   */
  workflowDispatchInputs: (repo: RepoRef, workflow: string) =>
    call<WorkflowDispatchResult>('workflow_dispatch_inputs', { repo, workflow }),
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

  // Integrated terminal. Note what is missing: there is no `termOpen`. A session
  // can only be created by running an openShell/openInTerminal action through the
  // gate above, so the argv is always built in Rust. See src-tauri/src/pty.rs.
  /** Keystrokes. Plain string: xterm's onData is already valid UTF-8. */
  termWrite: (termId: string, data: string) => call<void>('term_write', { termId, data }),
  termResize: (termId: string, cols: number, rows: number) =>
    call<void>('term_resize', { termId, cols, rows }),
  termClose: (termId: string) => call<void>('term_close', { termId }),
  termList: () => call<TermInfo[]>('term_list'),
  /** Base64 of everything the session printed, for restoring after a reload. */
  termScrollback: (termId: string) => call<string>('term_scrollback', { termId }),
}
