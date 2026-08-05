import { create } from 'zustand'
import { repoId, type LogLine, type RunStatus, type RunSummary } from '@/domain/types'

/** Head-dropped past this. An unbounded array eventually OOMs the webview. */
const MAX_LINES = 20_000

/** The blank line between one finished command and the next. */
const SPACER: LogLine = {
  seq: -1,
  stream: 'meta',
  severity: 'out',
  text: '',
  unix: 0,
  repo: null,
}

/**
 * The busy-map key for anything not scoped to one repo.
 *
 * Exported because there are two conventions for "no repo" in play — `''` here and
 * `null` from `runScope`/`termScope` — and this is the single documented bridge
 * between them. Do not inline the empty string anywhere else.
 */
export const WORKSPACE_KEY = ''

export interface Run {
  runId: string
  /**
   * Identity of the *log*, as opposed to of the process.
   *
   * Not `runId`: a run that continues a finished one keeps its predecessor's lines
   * and is re-keyed to the new process id, so `runId` changes under an array that
   * did not. The virtualized log measures its rows and caches the heights by row
   * key, and a key built on `runId` invalidated every one of those heights for rows
   * that were already mounted — nothing re-measures a DOM node that did not change,
   * so wrapped lines fell back to the one-line estimate and the rows after them
   * were drawn on top of each other.
   *
   * So: a fresh id whenever the array is replaced (a new run, a hydrate, a clear),
   * carried across unchanged when a run merely continues.
   */
  logId: string
  summary: RunSummary
  lines: LogLine[]
  lastSeq: number
  droppedHead: number
  /** Tail mode. Disabled the moment the user scrolls away from the bottom. */
  follow: boolean
  scrollTop: number
  /**
   * Every busy-map key this run occupies, captured at start.
   *
   * Stored rather than recomputed so `exit` decrements exactly what `start`
   * incremented, even though `exit` replaces the summary.
   */
  scopeKeys: string[]
  /**
   * The log was explicitly cleared, as opposed to simply having no lines yet.
   *
   * Without this, Clear did nothing durable: the view refills an empty log from the
   * backend ring buffer on remount, so the lines came straight back.
   */
  cleared: boolean
  /**
   * A cancel has been asked for and the process has not exited yet.
   *
   * Its own flag rather than a `RunStatus` kind, because the status is the backend's
   * to report: cancelling is a *request*, and the run is still genuinely running —
   * it may still print, and it may still exit 0 if it finished before the signal
   * landed. Without this, Ctrl+C or the Cancel button looked like it did nothing for
   * however long the tree took to die.
   */
  cancelling: boolean
}

/**
 * Every scope a run makes busy: its own repo, plus every repo it touches.
 *
 * `targets` is the whole point. A bulk pull sets `ref: null` and lists 40 repos, so
 * keying on `ref` alone counted it once against the workspace and left all 40 repo
 * rows reporting nothing running — during a pull of those exact repos.
 */
export function runScopeKeys(summary: RunSummary): string[] {
  const keys = new Set<string>()
  keys.add(summary.ref ? repoId(summary.ref) : WORKSPACE_KEY)
  for (const t of summary.targets ?? []) keys.add(repoId(t))
  return [...keys]
}

export interface RunExitFields {
  status: RunStatus
  endedUnix: number
  lineCount?: number
  truncated?: boolean
}

interface RunState {
  runs: Map<string, Run>
  order: string[]
  activeRunId: string | null
  /**
   * scope key -> number of runs currently going, maintained incrementally.
   *
   * A row can subscribe to one number instead of deriving it from the whole run
   * map, so only the affected rows re-render. Keyed by repo id, or `WORKSPACE_KEY`.
   *
   * One run can occupy several keys — see `runScopeKeys`.
   */
  runningByScope: Record<string, number>

  start(summary: RunSummary): void
  /**
   * Loads a finished run that is not in this store, and makes it active.
   *
   * For the detail page's Runs tab: the backend keeps every run for the session, but
   * this store only holds what it saw live, so a dismissed run — or any run from
   * before a reload — could be listed and not opened. Unlike `start` it does not
   * touch `runningByScope`, because nothing is running.
   */
  hydrate(summary: RunSummary, lines: LogLine[]): void
  append(runId: string, lines: LogLine[]): void
  /**
   * `lineCount`/`truncated` come from the exit event and were previously discarded,
   * so a finished run's summary still claimed the count it had at start.
   * `durationMs` is deliberately not stored — `endedUnix - startedUnix` is the same
   * number, and two sources for one fact eventually disagree.
   */
  exit(runId: string, e: RunExitFields): void
  setActive(runId: string | null): void
  /**
   * The next run to start was asked for by name, so show it.
   *
   * The mirror of `useTerminalStore.requestFocus`, and for the same reason: whether
   * a run is *the request* is knowledge only the caller has. Pressing Run, or a
   * script, or Fetch is one — you pressed it to watch it, and having to hunt for its
   * scope tab afterwards is the bug this closes. A run that merely arrives — the
   * autofetch, a dev server restarting itself, a replay after reload — is not, and
   * must not move the pane out from under whatever you are reading.
   *
   * Set by `useActionStore` at the point it actually calls `run_action`, not from
   * the click: a dialog can still be cancelled, and a run that never starts must not
   * leave the flag armed for the next one.
   */
  requestFocus(): void
  /** Reads and clears the flag. Called once, by the `run:started` handler. */
  takeFocusRequest(): boolean
  /**
   * Marks a cancel as requested (or un-requests it, when the IPC call itself failed
   * and nothing is going to arrive to clear the flag).
   */
  setCancelling(runId: string, cancelling: boolean): void
  setFollow(runId: string, follow: boolean): void
  setScrollTop(runId: string, scrollTop: number): void
  clear(runId: string): void
  dismiss(runId: string): void
}

// Module scope, not store state: nothing renders from it, and a `set` here would
// re-render every subscriber to carry a boolean that lives for one round trip. Same
// shape as the terminal store's, deliberately.
let focusRequested = false

/** Backs `Run.logId`. A counter rather than the run id — see that field. */
let logSeq = 0
const nextLogId = () => `log${++logSeq}`

export const useRunStore = create<RunState>()((set) => ({
  runs: new Map(),
  order: [],
  activeRunId: null,
  runningByScope: {},

  start: (summary) =>
    set((s) => {
      const runs = new Map(s.runs)

      // Continue the log you are looking at, rather than starting a third chip.
      //
      // Only when it has *finished*: a live run keeps its own entry, because its
      // output is still arriving and merging a second process into it would make
      // one status, one cancel button and one exit code describe two things. Once
      // it is done, though, there is nothing left to keep separate — the next
      // command appends the way it would in a terminal, and each command still
      // announces itself with the `$ …` line Rust writes first.
      const prev = s.activeRunId ? s.runs.get(s.activeRunId) : undefined
      const sameScope =
        prev && prev.scopeKeys[0] === runScopeKeys(summary)[0]
      const continues =
        prev && sameScope && prev.summary.status.kind !== 'running' && !prev.cancelling

      if (prev && continues) {
        // Re-keyed to the new run rather than aliased: Cancel, Clear and the exit
        // event all address a run by id, and an entry keyed by a dead process
        // would point every one of them at the wrong place.
        runs.delete(prev.runId)
        runs.set(summary.runId, {
          // `logId` rides along in the spread on purpose: the lines below are the
          // same array with more appended, so every row measurement stays valid.
          ...prev,
          runId: summary.runId,
          summary,
          // A blank line so the next `$ …` reads as a new command rather than as
          // more output from the last one.
          lines: prev.lines.length > 0 ? [...prev.lines, SPACER] : prev.lines,
          // The new process numbers its lines from zero.
          lastSeq: -1,
          follow: true,
          cleared: false,
          cancelling: false,
          scopeKeys: runScopeKeys(summary),
        })

        const runningByScope = { ...s.runningByScope }
        for (const key of runScopeKeys(summary)) {
          runningByScope[key] = (runningByScope[key] ?? 0) + 1
        }
        return {
          runs,
          // In place, so the chip does not jump to the end of the strip.
          order: s.order.map((id) => (id === prev.runId ? summary.runId : id)),
          activeRunId: summary.runId,
          runningByScope,
        }
      }

      runs.set(summary.runId, {
        runId: summary.runId,
        logId: nextLogId(),
        summary,
        lines: [],
        lastSeq: -1,
        droppedHead: 0,
        follow: true,
        scrollTop: 0,
        scopeKeys: runScopeKeys(summary),
        cleared: false,
        cancelling: false,
      })
      const runningByScope = { ...s.runningByScope }
      for (const key of runScopeKeys(summary)) {
        runningByScope[key] = (runningByScope[key] ?? 0) + 1
      }
      return {
        runs,
        // Idempotent: a run must never appear twice, whether from a duplicated
        // listener or from replay overlapping a live event. Duplicate ids also
        // produce duplicate React keys, which renders two chips for one run.
        order: s.order.includes(summary.runId) ? s.order : [...s.order, summary.runId],
        activeRunId: summary.runId,
        runningByScope,
      }
    }),

  hydrate: (summary, lines) =>
    set((s) => {
      const runs = new Map(s.runs)
      runs.set(summary.runId, {
        runId: summary.runId,
        logId: nextLogId(),
        summary,
        lines,
        lastSeq: lines.length > 0 ? lines[lines.length - 1]!.seq : -1,
        droppedHead: 0,
        // Not following: this run has already finished, so there is nothing to tail,
        // and jumping to the bottom of a 5000-line log hides why it failed.
        follow: false,
        scrollTop: 0,
        // Nothing is running, so this run occupies no busy keys — see the note on
        // `hydrate` above.
        scopeKeys: [],
        cleared: false,
        cancelling: false,
      })
      return {
        runs,
        order: s.order.includes(summary.runId) ? s.order : [...s.order, summary.runId],
        activeRunId: summary.runId,
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

  exit: (runId, e) =>
    set((s) => {
      const run = s.runs.get(runId)
      if (!run) return s
      const runs = new Map(s.runs)
      runs.set(runId, {
        ...run,
        // The request is over either way — the process is gone, whether or not it
        // went because of the cancel.
        cancelling: false,
        summary: {
          ...run.summary,
          status: e.status,
          endedUnix: e.endedUnix,
          lineCount: e.lineCount ?? run.summary.lineCount,
          truncated: e.truncated ?? run.summary.truncated,
        },
      })

      // Only decrement if this run was still counted as running, so a duplicate
      // exit event cannot drive the count negative.
      if (run.summary.status.kind !== 'running') return { runs }
      // The keys captured at start, not recomputed: the summary above has already
      // been replaced, and a mismatch here would leak a count forever.
      const runningByScope = { ...s.runningByScope }
      for (const key of run.scopeKeys) {
        const next = Math.max(0, (runningByScope[key] ?? 0) - 1)
        // Deleted rather than stored as 0, so consumers must use `?? 0` anyway and
        // the map stays the size of what is actually busy.
        if (next === 0) delete runningByScope[key]
        else runningByScope[key] = next
      }

      return { runs, runningByScope }
    }),

  setActive: (activeRunId) => set({ activeRunId }),

  requestFocus: () => {
    focusRequested = true
  },
  takeFocusRequest: () => {
    const v = focusRequested
    focusRequested = false
    return v
  },

  setCancelling: (runId, cancelling) =>
    set((s) => {
      const run = s.runs.get(runId)
      if (!run || run.cancelling === cancelling) return s
      // Only a live run can be cancelling. A late click on a run that has just
      // exited would otherwise leave the flag set on a finished run forever, and
      // its footer would read "cancelling…" next to its exit code.
      if (cancelling && run.summary.status.kind !== 'running') return s
      const runs = new Map(s.runs)
      runs.set(runId, { ...run, cancelling })
      return { runs }
    }),

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
      // `lastSeq` is deliberately left alone: live lines still have to pass the
      // `seq > lastSeq` dedupe, so resetting it would let the backend replay
      // everything the user just cleared.
      // A new `logId`: index 0 is about to mean a different line, so the row
      // measurements from before the clear must not be reused.
      runs.set(runId, { ...run, logId: nextLogId(), lines: [], droppedHead: 0, cleared: true })
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

/**
 * Whether the log should be refilled from the backend's ring buffer.
 *
 * Only to close a gap left by a remount — never to undo a Clear. Exported as a
 * predicate so the rule is testable without rendering anything.
 */
export function shouldReplay(run: Run): boolean {
  return run.lines.length === 0 && !run.cleared
}

