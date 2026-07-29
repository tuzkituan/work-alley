import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ensureBridge, on } from './events'
import { api } from './commands'
import { createFrameQueue } from '@/lib/frame-queue'
import { useScanStore } from '@/stores/scan-store'
import { useRunStore } from '@/stores/run-store'
import { useUiStore } from '@/stores/ui-store'
import { keys } from '@/queries/keys'
import { repoId, type LogLine, type RepoStatus } from '@/domain/types'

let wired = false

/**
 * Routes streamed events into the stores, once.
 *
 * Must be awaited *before* any command that streams: `start_scan` returns
 * immediately, so a scan:started emitted before the listener attaches would be
 * lost and `total` would never be set.
 */
export async function connectBridge(qc: QueryClient) {
  await ensureBridge()
  if (wired) return
  wired = true

  const scan = useScanStore.getState()

  // 63 repos arrive in a burst; commit them ~1 frame at a time.
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
      uiLatest: snapshot.uiLatest,
      uiLatestSource: snapshot.uiLatestSource,
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
    // Point the output pane at the repo this run belongs to, so launching an
    // action shows that repo's terminal rather than whatever was open.
    if (run.ref) useUiStore.getState().setActiveRepo(repoId(run.ref))
  })
  on('run:output', ({ runId, lines }) => queueFor(runId).pushAll(lines))
  on('run:exit', ({ runId, status, endedUnix }) => {
    queueFor(runId).flushNow()
    logQueues.delete(runId)

    const run = useRunStore.getState().runs.get(runId)
    useRunStore.getState().exit(runId, status, endedUnix)
    const title = run?.summary.title ?? 'Command'

    if (status.kind === 'exited' && status.code === 0) {
      toast.success(`${title} finished`)
    } else if (status.kind === 'cancelled') {
      toast.info(`${title} cancelled`)
    } else if (status.kind === 'exited') {
      // Some scripts use a non-zero exit to *report* something (verify-repos.sh
      // exits 1 for "drift detected"), so this is deliberately not an error toast.
      toast.warning(`${title} exited with code ${status.code}`)
    } else if (status.kind === 'failed') {
      toast.error(`${title} failed`, { description: status.message })
    } else if (status.kind === 'signaled') {
      toast.info(`${title} stopped`)
    }

    // Rescan only the repo this run touched, not all 63.
    const ref = run?.summary.ref
    if (ref && status.kind !== 'cancelled') {
      api
        .rescanRepo(ref)
        .then((updated) => useScanStore.getState().upsertMany([updated]))
        .catch(() => {})
    }
  })

  // Patch, never invalidate: invalidating means an IPC round trip and a flicker
  // through a loading state on every container or dev-server event.
  on('dev:changed', ({ servers }) => {
    qc.setQueryData(keys.devServers, servers)
    // The cards read devServer off their scan row, so that has to be patched too
    // — otherwise a started server would not appear until the next rescan.
    useScanStore.getState().setDevServers(servers)
  })
  on('docker:changed', ({ status }) => qc.setQueryData(keys.docker, status))

  // The probe can take seconds (it runs an interactive shell to pick up nvm), so
  // bootstrap is re-read once it lands and the tool versions fill in.
  on('tools:ready', () => {
    void qc.invalidateQueries({ queryKey: keys.bootstrap })
    // Package detection resolves paths through the toolchain too.
    void qc.invalidateQueries({ queryKey: keys.packages })
  })

  // A different folder means every cached repo, commit and scan belongs to a
  // workspace that is no longer open.
  on('workspace:changed', () => {
    useScanStore.getState().reset()
    useUiStore.getState().setCategory(null)
    useUiStore.getState().closeDetail()
    void qc.invalidateQueries()
  })

  on('app:toast', ({ level, message }) => {
    if (level === 'err') toast.error(message)
    else if (level === 'warn') toast.warning(message)
    else toast(message)
  })
}
