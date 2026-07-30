import { create } from 'zustand'
import {
  repoId,
  type Category,
  type CommitEntry,
  type DevServer,
  type RepoId,
  type RepoStatus,
} from '@/domain/types'

export type ScanPhase = 'idle' | 'scanning' | 'done' | 'error'

interface ScanState {
  phase: ScanPhase
  scanId: string | null
  total: number
  received: number
  /** Keyed so a single card can subscribe to exactly its own row. */
  repos: Map<RepoId, RepoStatus>
  /**
   * Folders whose repos have actually been scanned. Everything else has no status
   * at all, which the UI must show as "unknown" rather than as "clean".
   */
  scanned: Set<Category>
  scanning: Category | null
  commits: CommitEntry[]
  trackedLatest: string | null
  trackedLatestSource: 'published' | 'declared' | null
  errorCount: number
  durationMs: number
  message: string | null

  beginCategory(category: Category): void
  markScanned(category: Category): void
  /**
   * Every dev server in the workspace, whether or not its repo has been scanned.
   *
   * Kept alongside the per-row patching below because that patching can only reach
   * rows that already exist — i.e. folders that have been scanned. A server in a
   * folder nobody has opened was simply dropped, which made "what is running
   * anywhere?" unanswerable without opening every folder in turn.
   */
  devServers: DevServer[]

  /**
   * Patches the dev-server field on every affected row.
   *
   * RepoStatus.devServer is otherwise only filled in during a scan, so without
   * this a started dev server would not show on its card until the next rescan.
   * The payload is the full list, so this also clears rows whose server has gone.
   */
  setDevServers(servers: DevServer[]): void
  begin(scanId: string, total: number): void
  upsertMany(rows: RepoStatus[]): void
  setCommits(commits: CommitEntry[]): void
  finish(p: {
    trackedLatest: string | null
    trackedLatestSource: 'published' | 'declared' | null
    errorCount: number
    durationMs: number
  }): void
  fail(message: string): void
  reset(): void
}

export const useScanStore = create<ScanState>()((set) => ({
  phase: 'idle',
  scanId: null,
  total: 0,
  received: 0,
  repos: new Map(),
  scanned: new Set(),
  scanning: null,
  devServers: [],
  commits: [],
  trackedLatest: null,
  trackedLatestSource: null,
  errorCount: 0,
  durationMs: 0,
  message: null,

  beginCategory: (category) => set({ scanning: category, phase: 'scanning', received: 0, total: 0 }),

  markScanned: (category) =>
    set((s) => {
      const scanned = new Set(s.scanned)
      scanned.add(category)
      return { scanned, scanning: null }
    }),

  setDevServers: (servers) =>
    set((s) => {
      const byRepo = new Map<RepoId, DevServer[]>()
      for (const d of servers) {
        const id = repoId(d.ref)
        const list = byRepo.get(id)
        if (list) list.push(d)
        else byRepo.set(id, [d])
      }

      let changed = false
      const repos = new Map(s.repos)

      for (const [id, row] of repos) {
        const next = byRepo.get(id) ?? []
        // Compare only what the UI renders, so an identical re-emit does not churn
        // every row.
        const same =
          row.tasks.length === next.length &&
          row.tasks.every((a, i) => {
            const b = next[i]!
            return a.runId === b.runId && a.state === b.state && a.port === b.port
          })
        if (same) continue
        repos.set(id, { ...row, tasks: next })
        changed = true
      }

      // `devServers` is always replaced, even when no row changed: it is the whole
      // point of holding the raw list, and a workspace-wide view of what is running
      // must not go stale because every affected row happened to be unscanned.
      return changed ? { repos, devServers: servers } : { devServers: servers }
    }),

  begin: (scanId, total) =>
    set({
      phase: 'scanning',
      scanId,
      total,
      received: 0,
      message: null,
      // Rows are kept from the previous scan so values update in place rather
      // than blanking the whole grid.
    }),

  upsertMany: (rows) =>
    set((s) => {
      const repos = new Map(s.repos)
      for (const r of rows) repos.set(repoId(r.ref), r)
      return { repos, received: s.received + rows.length }
    }),

  setCommits: (commits) => set({ commits }),

  finish: ({ trackedLatest, trackedLatestSource, errorCount, durationMs }) =>
    set({ phase: 'done', trackedLatest, trackedLatestSource, errorCount, durationMs }),

  fail: (message) => set({ phase: 'error', message }),

  reset: () =>
    set({
      phase: 'idle',
      scanId: null,
      total: 0,
      received: 0,
      repos: new Map(),
      scanned: new Set(),
      scanning: null,
      // Cleared with the rest: reset runs on `workspace:changed`, and a server in
      // the folder that is no longer open would otherwise sit in the Running list
      // pointing at a repo this workspace cannot address. The bridge re-seeds from
      // `list_dev_servers` right after, so anything still up reappears at once.
      devServers: [],
      commits: [],
      errorCount: 0,
      message: null,
    }),
}))

/** Selector a single RepoCard subscribes with, so it re-renders alone. */
export const selectRepo = (id: RepoId) => (s: ScanState) => s.repos.get(id)
