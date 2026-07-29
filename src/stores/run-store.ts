import { create } from 'zustand'
import { repoId, type LogLine, type RunStatus, type RunSummary } from '@/domain/types'

/** Head-dropped past this. An unbounded array eventually OOMs the webview. */
const MAX_LINES = 20_000

export interface Run {
  runId: string
  summary: RunSummary
  lines: LogLine[]
  lastSeq: number
  droppedHead: number
  /** Tail mode. Disabled the moment the user scrolls away from the bottom. */
  follow: boolean
  scrollTop: number
}

interface RunState {
  runs: Map<string, Run>
  order: string[]
  activeRunId: string | null
  /**
   * scope key -> number of runs currently going, maintained incrementally.
   *
   * A row can subscribe to one number instead of deriving it from the whole run
   * map, so only the affected rows re-render. Keyed by repo id, or "" for
   * workspace-level runs.
   */
  runningByScope: Record<string, number>

  start(summary: RunSummary): void
  append(runId: string, lines: LogLine[]): void
  exit(runId: string, status: RunStatus, endedUnix: number): void
  setActive(runId: string | null): void
  setFollow(runId: string, follow: boolean): void
  setScrollTop(runId: string, scrollTop: number): void
  clear(runId: string): void
  dismiss(runId: string): void
}

export const useRunStore = create<RunState>()((set) => ({
  runs: new Map(),
  order: [],
  activeRunId: null,
  runningByScope: {},

  start: (summary) =>
    set((s) => {
      const runs = new Map(s.runs)
      runs.set(summary.runId, {
        runId: summary.runId,
        summary,
        lines: [],
        lastSeq: -1,
        droppedHead: 0,
        follow: true,
        scrollTop: 0,
      })
      const key = summary.ref ? repoId(summary.ref) : ''
      return {
        runs,
        // Idempotent: a run must never appear twice, whether from a duplicated
        // listener or from replay overlapping a live event. Duplicate ids also
        // produce duplicate React keys, which renders two chips for one run.
        order: s.order.includes(summary.runId) ? s.order : [...s.order, summary.runId],
        activeRunId: summary.runId,
        runningByScope: {
          ...s.runningByScope,
          [key]: (s.runningByScope[key] ?? 0) + 1,
        },
      }
    }),

  append: (runId, incoming) =>
    set((s) => {
      const run = s.runs.get(runId)
      if (!run) return s

      // Dedupe by seq — replay after a remount can overlap with live events.
      const fresh = incoming.filter((l) => l.seq > run.lastSeq)
      if (fresh.length === 0) return s

      let lines = run.lines.concat(fresh)
      let droppedHead = run.droppedHead
      if (lines.length > MAX_LINES) {
        const excess = lines.length - MAX_LINES
        lines = lines.slice(excess)
        droppedHead += excess
      }

      const runs = new Map(s.runs)
      runs.set(runId, {
        ...run,
        lines,
        droppedHead,
        lastSeq: fresh[fresh.length - 1]!.seq,
      })
      return { runs }
    }),

  exit: (runId, status, endedUnix) =>
    set((s) => {
      const run = s.runs.get(runId)
      if (!run) return s
      const runs = new Map(s.runs)
      runs.set(runId, {
        ...run,
        summary: { ...run.summary, status, endedUnix },
      })

      // Only decrement if this run was still counted as running, so a duplicate
      // exit event cannot drive the count negative.
      if (run.summary.status.kind !== 'running') return { runs }
      const key = run.summary.ref ? repoId(run.summary.ref) : ''
      const next = Math.max(0, (s.runningByScope[key] ?? 0) - 1)
      const runningByScope = { ...s.runningByScope }
      if (next === 0) delete runningByScope[key]
      else runningByScope[key] = next

      return { runs, runningByScope }
    }),

  setActive: (activeRunId) => set({ activeRunId }),

  setFollow: (runId, follow) =>
    set((s) => {
      const run = s.runs.get(runId)
      if (!run || run.follow === follow) return s
      const runs = new Map(s.runs)
      runs.set(runId, { ...run, follow })
      return { runs }
    }),

  setScrollTop: (runId, scrollTop) =>
    set((s) => {
      const run = s.runs.get(runId)
      if (!run) return s
      const runs = new Map(s.runs)
      runs.set(runId, { ...run, scrollTop })
      return { runs }
    }),

  clear: (runId) =>
    set((s) => {
      const run = s.runs.get(runId)
      if (!run) return s
      const runs = new Map(s.runs)
      runs.set(runId, { ...run, lines: [], droppedHead: 0 })
      return { runs }
    }),

  dismiss: (runId) =>
    set((s) => {
      const runs = new Map(s.runs)
      runs.delete(runId)
      const order = s.order.filter((id) => id !== runId)
      return {
        runs,
        order,
        activeRunId: s.activeRunId === runId ? (order[order.length - 1] ?? null) : s.activeRunId,
      }
    }),
}))

export const selectRun = (runId: string | null) => (s: RunState) =>
  runId ? s.runs.get(runId) : undefined

/**
 * The scope a run belongs to: a repo key, or `null` for workspace-level runs
 * (scripts, bulk pull/fetch, gh pr list, docker ps).
 */
export function runScope(run: Run): string | null {
  return run.summary.ref ? repoId(run.summary.ref) : null
}

