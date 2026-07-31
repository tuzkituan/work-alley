import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ensureBridge, on } from './events'
import { api } from './commands'
import { createFrameQueue } from '@/lib/frame-queue'
import { b64ToBytes } from '@/lib/b64'
import { writeToTerm } from '@/features/terminal/xterm-instance'
import { useScanStore } from '@/stores/scan-store'
import { useRunStore } from '@/stores/run-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useCiStore } from '@/stores/ci-store'
import { useManagerStore } from '@/stores/manager-store'
import { useUiStore } from '@/stores/ui-store'
import { keys } from '@/queries/keys'
import { staleKeysFor } from '@/queries/invalidate'
import { repoId, type LogLine, type RepoStatus } from '@/domain/types'

let wiring: Promise<void> | null = null

/**
 * Routes streamed events into the stores, once.
 *
 * Must be awaited *before* any command that streams: `start_scan` returns
 * immediately, so a scan:started emitted before the listener attaches would be
 * lost and `total` would never be set.
 *
 * Memoised on the promise, exactly like `ensureBridge`. An earlier version did
 * `await ensureBridge(); if (wired) return; wired = true` — a check *after* an
 * await, so two concurrent callers both got past it and every handler was
 * registered twice. React StrictMode calls this twice on mount, so it happened
 * every single time in development: each run appeared twice in the output pane's
 * chip strip. (Log lines looked fine only because `append` dedupes by seq.)
 *
 * Assigning `wiring` before the async body reaches its first await is what closes
 * the window; there is no point at which a second caller can see it unset.
 */
export function connectBridge(qc: QueryClient): Promise<void> {
  if (wiring) return wiring
  wiring = wire(qc)
  return wiring
}

async function wire(qc: QueryClient) {
  await ensureBridge()

  const scan = useScanStore.getState()

  // Repos arrive in a burst; commit them ~1 frame at a time.
  const repoQueue = createFrameQueue<RepoStatus>((rows) => {
    useScanStore.getState().upsertMany(rows)
  })

  on('scan:started', ({ scanId, total, categories }) => {
    scan.begin(scanId, total)
    if (categories.length === 1) useScanStore.getState().beginCategory(categories[0]!)
  })
  on('scan:repo', ({ repo }) => repoQueue.push(repo))
  on('scan:commits', ({ commits }) => {
    repoQueue.flushNow()
    useScanStore.getState().setCommits(commits)
    qc.setQueryData(keys.commits, commits)
  })
  on('scan:finished', ({ snapshot }) => {
    repoQueue.flushNow()
    const st = useScanStore.getState()
    st.finish({
      trackedLatest: snapshot.trackedLatest,
      trackedLatestSource: snapshot.trackedLatestSource,
      errorCount: snapshot.errorCount,
      durationMs: snapshot.durationMs,
    })
    // Mark exactly the folders this scan covered, so the UI never reports an
    // unscanned folder as clean. The in-flight folder is marked too — be/ has no
    // repos on disk, so it would otherwise never be considered scanned and the
    // hook would retry forever.
    const covered = new Set(snapshot.repos.map((r) => r.ref.category))
    if (st.scanning) covered.add(st.scanning)
    for (const c of covered) st.markScanned(c)
  })
  on('scan:error', ({ message }) => {
    useScanStore.getState().fail(message)
    toast.error('Scan failed', { description: message })
  })

  // Output arrives already batched from Rust; coalesce again per run for React.
  const logQueues = new Map<string, ReturnType<typeof createFrameQueue<LogLine>>>()
  const queueFor = (runId: string) => {
    let q = logQueues.get(runId)
    if (!q) {
      q = createFrameQueue<LogLine>((lines) => useRunStore.getState().append(runId, lines))
      logQueues.set(runId, q)
    }
    return q
  }

  on('run:started', ({ run }) => {
    useRunStore.getState().start(run)
    // Show what just started.
    //
    // Both halves are needed. The scope, because a run in another repo — or a bulk
    // run, which belongs to the workspace — is filtered out of the pane you are
    // looking at, so starting it appeared to do nothing. And clearing the active
    // terminal, because a shell outranks a run in the view resolution: you started a
    // command to watch it, not to keep looking at a prompt.
    const ui = useUiStore.getState()
    if (run.ref) ui.setActiveRepo(repoId(run.ref))
    else ui.setOutputScope(null)
    useTerminalStore.getState().setActive(null)
  })
  on('run:output', ({ runId, lines }) => queueFor(runId).pushAll(lines))
  on('run:exit', ({ runId, status, endedUnix, lineCount, truncated }) => {
    queueFor(runId).flushNow()
    logQueues.delete(runId)

    const run = useRunStore.getState().runs.get(runId)
    // The event has carried lineCount and truncated all along; the store used to
    // drop them, so a finished run still reported the count it had at start.
    useRunStore.getState().exit(runId, { status, endedUnix, lineCount, truncated })
    const title = run?.summary.title ?? 'Command'

    if (status.kind === 'exited' && status.code === 0) {
      toast.success(`${title} finished`)
    } else if (status.kind === 'cancelled') {
      toast.info(`${title} cancelled`)
    } else if (status.kind === 'exited') {
      // Some scripts use a non-zero exit to *report* something (a drift check
      // exits 1 for "drift detected"), so this is deliberately not an error toast.
      toast.warning(`${title} exited with code ${status.code}`)
    } else if (status.kind === 'failed') {
      toast.error(`${title} failed`, { description: status.message })
    } else if (status.kind === 'signaled') {
      toast.info(`${title} stopped`)
    }

    // An install changed what is on this machine, so both machine-scoped pages are
    // now stale. Invalidated rather than patched: the answer comes from probing the
    // filesystem, and there is nothing to patch it with from here.
    const kind = run?.summary.kind
    if (kind === 'package' || kind === 'gitIdentity') {
      void refreshMachineState(qc)
    }

    // Rescan only the repos this run touched, not the whole folder. `ref` is null
    // on bulk runs (fetch all, pull many, bulk checkout) — those carry their repos
    // in `targets`, and without this their ahead/behind counts stay stale until a
    // manual rescan.
    const touched = run?.summary.targets?.length
      ? run.summary.targets
      : run?.summary.ref
        ? [run.summary.ref]
        : []
    if (touched.length && status.kind !== 'cancelled') {
      void Promise.all(
        touched.map((ref) => api.rescanRepo(ref).catch(() => null)),
      ).then((updated) => {
        const ok = updated.filter((s): s is RepoStatus => s !== null)
        if (ok.length) useScanStore.getState().upsertMany(ok)
      })

      // The rescan above only refreshes the scan store, which is what the repo
      // rows read. The detail page's tabs are react-query and were never told, so
      // after a pull its header updated while Changes, Commits and Branches went on
      // showing pre-pull data until their staleTime expired. `staleKeysFor` decides
      // what actually moved — see the note there about not refetching PRs for free.
      for (const ref of touched) {
        for (const key of staleKeysFor(kind ?? '', repoId(ref))) {
          void qc.invalidateQueries({ queryKey: key })
        }
      }
    }
  })

  on('term:opened', ({ term }) => {
    const store = useTerminalStore.getState()
    store.open(term)
    store.setActive(term.termId)
    // Same as run:started: a session opened at workspace level is invisible from a
    // repo-scoped pane, so the scope has to follow it or the new tab never shows.
    const ui = useUiStore.getState()
    if (term.repo) ui.setActiveRepo(repoId(term.repo))
    else ui.setOutputScope(null)
  })
  // Deliberately NOT through createFrameQueue, unlike run:output right above.
  // That helper exists to collapse store writes and React renders; terminal
  // bytes must never touch React state at all. They go straight into the xterm
  // instance, whose own write buffer already flushes on its own schedule and is
  // a far better coalescer than anything written here would be.
  on('term:output', ({ termId, data }) => writeToTerm(termId, b64ToBytes(data)))
  on('term:exit', ({ termId, code }) => {
    const store = useTerminalStore.getState()
    const tab = store.tabs.get(termId)
    store.exit(termId, code)

    // Toolbox and setup-page operations run in a terminal tab rather than as a
    // streamed run, so this is where an install finishing is noticed — `run:exit`
    // above never fires for them. Same three queries, same reason: what is on this
    // machine just changed.
    if (tab?.kind === 'package') {
      void refreshMachineState(qc)
      const title = tab.title
      if (code === 0) toast.success(`${title} finished`)
      // Not an error toast: a package manager exits non-zero for "nothing to do"
      // and for a declined sudo prompt as readily as for a real failure, and the
      // terminal tab is right there with the actual output.
      else toast.warning(`${title} exited with code ${code}`)
    }
  })

  // Patched, never invalidated: invalidating means an IPC round trip and a flicker
  // through a loading state on every dev-server event.
  //
  // The rows read devServer off their scan row, so that is what has to be patched —
  // otherwise a started server would not appear until the next rescan. The
  // `keys.devServers` cache this also used to fill had one reader, the Local services
  // panel, and went with it.
  on('dev:changed', ({ servers }) => {
    useScanStore.getState().setDevServers(servers)
  })
  // `docker:changed` is deliberately unhandled. Rust still emits it, and a future
  // container view can listen again — but nothing reads container state today, so a
  // handler filling a cache with no reader is just code that looks alive.

  // The probe can take seconds (it runs an interactive shell to pick up nvm), so
  // bootstrap is re-read once it lands and the tool versions fill in.
  on('tools:ready', () => {
    void qc.invalidateQueries({ queryKey: keys.bootstrap })
    // Package detection resolves paths through the toolchain too.
    void qc.invalidateQueries({ queryKey: keys.packages })
    void qc.invalidateQueries({ queryKey: keys.setupPlan })
  })

  // A different folder means every cached repo, commit and scan belongs to a
  // workspace that is no longer open.
  on('workspace:changed', () => {
    useScanStore.getState().reset()
    // Re-seed immediately: `dev:changed` only fires when a server *changes*, so
    // without this anything still running is invisible until it next starts or dies.
    void api
      .listDevServers()
      .then((servers) => useScanStore.getState().setDevServers(servers))
      .catch(() => {})
    useUiStore.getState().setCategory(null)
    useUiStore.getState().closeDetail()
    // The CI watch list is a set of repos in the folder being left.
    useCiStore.getState().reset()
    useManagerStore.getState().reset()
    void qc.invalidateQueries()
  })

  on('app:toast', ({ level, message }) => {
    if (level === 'err') toast.error(message)
    else if (level === 'warn') toast.warning(message)
    else toast(message)
  })

  // Recover sessions that outlived the webview.
  //
  // Rust's pty registry is the only record of a live shell, and nothing read it — so
  // a reload lost every terminal tab while the shells themselves kept running,
  // unreachable. Deliberately after the listeners are attached, per the note at the
  // top of this file: `open` is idempotent, so racing a live `term:opened` is
  // harmless, whereas registering late would drop one.
  //
  // Nothing to restore for the contents — TerminalView replays the scrollback
  // whenever it attaches to an empty buffer.
  try {
    // `restored: true` is what tells TerminalView to replay this session's
    // scrollback. A live `term:opened` must never set it — see TermTab.restored.
    for (const t of await api.termList()) {
      useTerminalStore.getState().open(t, { restored: true })
    }
  } catch {
    // A pty-less platform or a backend that has not finished booting. The strip is
    // simply empty, which is what it did before this existed.
  }

  // Same recovery, for dev servers. Rust persists its dev registry across a webview
  // reload, but `dev:changed` only fires when something *changes* — so a server
  // that was already up when this connected was invisible until it next started or
  // died, and the Running list would have reported nothing running.
  try {
    useScanStore.getState().setDevServers(await api.listDevServers())
  } catch {
    // Nothing running, or a backend still booting.
  }
}

/**
 * Re-reads everything about this machine after something installed a tool.
 *
 * The probe comes **first**, and that ordering is the whole point. `setupPlan` is
 * built from the backend's resolved tool paths, so invalidating it against a
 * toolchain resolved at launch just refetched the same stale answer — which is why
 * the setup page's next step kept refusing to run after Node was installed, and why
 * "Re-check" appeared to do nothing.
 *
 * Deliberately not awaited by callers: a probe is two login shells and takes a
 * moment, and nothing else in the exit handler depends on it.
 */
async function refreshMachineState(qc: QueryClient): Promise<void> {
  try {
    await api.refreshToolchain()
  } catch {
    // A failed probe leaves the previous one in place, which is strictly better than
    // nothing; the invalidations below are still worth doing.
  }
  // `bootstrap` too, because the tool list and the readiness it implies live there.
  for (const key of [keys.bootstrap, keys.packages, keys.setupPlan, keys.packageUpdates]) {
    void qc.invalidateQueries({ queryKey: key })
  }
}
