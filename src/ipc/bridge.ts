import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ensureBridge, on } from './events'
import { api } from './commands'
import { createFrameQueue } from '@/lib/frame-queue'
import { b64ToBytes } from '@/lib/b64'
import { writeToTerm } from '@/features/terminal/xterm-instance'
import { useScanStore } from '@/stores/scan-store'
import { runScopeKeys, useRunStore, WORKSPACE_KEY } from '@/stores/run-store'
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
    // Show what just started — but only inside the scope the pane is already on.
    //
    // The scope used to follow the run: starting anything moved the pane to that
    // repo, or to the workspace for a bulk run. It made a run in another repo
    // visible, at the cost of yanking the view out from under whatever you were
    // reading, and there was no way to say no. The scope is the user's now. The
    // tabs still advertise activity elsewhere — each one carries a blinking dot and
    // a count — so nothing started in another scope is silently lost, it just does
    // not steal the pane.
    //
    // Clearing the active terminal is still right *within* the scope: a shell
    // outranks a run in the view resolution, and you started a command to watch it,
    // not to keep looking at a prompt.
    //
    // A tab for wherever it landed, so a run in another repo is one click away
    // rather than invisible. Additive and idempotent — and an *event*, not a
    // derived value, which is what lets a tab you closed by hand come back when
    // something new starts there rather than the instant a log line arrives.
    //
    // The run's *own* scope only, not `runScopeKeys` — a bulk run lists every repo
    // it touches in `targets`, so fetch --all opened a tab per repo in the
    // workspace and buried the strip. A bulk run has no `ref`, which means the
    // workspace tab, which is exactly where its log shows up. Membership is still
    // per-target (`inScope` below, and the pane's own filter): a repo tab blinks
    // for a bulk run touching it, it just is not conjured into existence by one.
    rememberScopes([run.ref ? repoId(run.ref) : WORKSPACE_KEY])

    // Asked for by name — you pressed Run, or a script, or Fetch — so show it, scope
    // and all. That is the exception to the paragraph above, not a reversal of it:
    // what must not move the pane is a run that merely *arrives*, and this flag is
    // set only where a user actually confirmed an action. See `armFocus`.
    if (useRunStore.getState().takeFocusRequest()) {
      useUiStore.getState().setOutputScope(run.ref ? repoId(run.ref) : null)
      // `start` above already made it the active run; only the terminal has to be
      // stood down, since a live shell outranks a run in the view resolution.
      useTerminalStore.getState().setActive(null)
      return
    }
    if (inScope(runScopeKeys(run))) useTerminalStore.getState().setActive(null)
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
    // Same rule as run:started: select the new tab, but do not move the pane to
    // find it. A shell opened for another repo waits in that repo's scope tab,
    // which shows its count — the pane you are reading stays where you put it.
    const key = term.repo ? repoId(term.repo) : WORKSPACE_KEY
    rememberScopes([key])

    // Asked for by name — the terminal button, the pane's +, "Open terminal" in a
    // repo menu — so show it, scope and all. A shell nobody asked for (one restored
    // on reload, one a chore spawned elsewhere) still does not move the pane: that
    // is the difference the flag exists to carry.
    if (store.takeFocusRequest()) {
      useUiStore.getState().setOutputScope(term.repo ? repoId(term.repo) : null)
      store.setActive(term.termId)
    } else if (inScope([key])) {
      store.setActive(term.termId)
    }
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
/**
 * Whether something that belongs to `scopeKeys` is in the pane's current scope.
 *
 * Keys, plural, because a bulk run belongs to the workspace *and* to every repo it
 * touches — the same rule `runInScope` applies in the pane's own filter.
 */
/** Opens a tab per scope, skipping the workspace — it always has one. */
function rememberScopes(scopeKeys: string[]): void {
  const repos = scopeKeys.filter((k) => k !== WORKSPACE_KEY)
  if (repos.length) useUiStore.getState().rememberScopes(repos)
}

function inScope(scopeKeys: string[]): boolean {
  const current = useUiStore.getState().outputScope ?? WORKSPACE_KEY
  return scopeKeys.includes(current)
}

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
