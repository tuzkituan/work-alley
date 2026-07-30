import { useQuery } from '@tanstack/react-query'
import { Terminal } from 'lucide-react'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/wa/primitives'
import { formatDuration, relativeFromUnix } from '@/lib/time'
import { repoId, type RepoId, type RunStatus, type RunSummary } from '@/domain/types'
import { useRunStore } from '@/stores/run-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { Tone } from '@/domain/severity'
import { PanelEmpty, PanelError, PanelSkeleton, TabPanel } from './panel-parts'

/**
 * Every command this app has run against this repo.
 *
 * Built on `list_runs` and `get_run_log`, two IPC wrappers that existed with no
 * caller anywhere: the backend keeps each run for the session, but the frontend only
 * ever knew about runs it watched start. So a pull from ten minutes ago, or anything
 * from before a reload, was unreachable — the log was there and nothing asked for it.
 *
 * Bulk runs are included via `summary.targets`. `ref` is null on those, which is
 * exactly the field `targets` was added to complement.
 */
export function RunsPanel({ id }: { id: RepoId }) {
  const liveRuns = useRunStore((s) => s.runs)
  const setActive = useRunStore((s) => s.setActive)
  const setActiveTerm = useTerminalStore((s) => s.setActive)

  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: keys.runs,
    queryFn: () => api.listRuns(),
    // Invalidated on every run:exit by the bridge, so it never needs to poll.
    staleTime: 5_000,
  })

  const runs = (data ?? [])
    .filter(
      (r) =>
        (r.ref && repoId(r.ref) === id) || (r.targets ?? []).some((t) => repoId(t) === id)
    )
    // Newest first: the run you want is almost always the last one.
    .reverse()

  async function open(summary: RunSummary) {
    // Point the pane at the log rather than a shell, the same way run:started does.
    setActiveTerm(null)
    if (liveRuns.has(summary.runId)) {
      setActive(summary.runId)
      return
    }
    // Dismissed, or from before a reload — fetch it and put it back in the store, so
    // there stays exactly one log viewer in the app.
    try {
      const page = await api.getRunLog(summary.runId)
      useRunStore.getState().hydrate({ ...summary, status: page.status }, page.lines)
    } catch {
      // The backend drops runs when the workspace changes; nothing to show.
    }
  }

  return (
    <TabPanel
      icon={<Terminal className="size-3.5 text-adaptive-400" />}
      title={error ? 'Runs' : `${runs.length} runs`}
      right={
        <span className="font-mono text-[11px] text-adaptive-400">this session</span>
      }
      isFetching={isFetching}
      onRefresh={() => void refetch()}
    >
      {isPending ? (
        <PanelSkeleton n={4} />
      ) : error ? (
        <PanelError what="the run history" message={error.message} />
      ) : runs.length === 0 ? (
        <PanelEmpty>Nothing has been run against this repo yet.</PanelEmpty>
      ) : (
        runs.map((r) => (
          <button
            key={r.runId}
            type="button"
            onClick={() => void open(r)}
            className="wa-run-cols w-full border-b border-adaptive-200 px-3 py-2 text-left last:border-b-0 hover:bg-adaptive-100/60"
            // The argv, because "Pull fe/web" does not say --rebase --autostash.
            title={`${r.argv.join(' ')}\nin ${r.cwd}`}
          >
            <StatusDot tone={statusTone(r.status)} size={7} />
            <span className="truncate text-xs text-adaptive-800">
              {r.title}
              {/* Bulk runs are listed here because they touched this repo, so say so
                  rather than looking like a run of this repo alone. */}
              {!r.ref && (r.targets?.length ?? 0) > 1 && (
                <span className="ml-1.5 text-[10px] text-adaptive-400">
                  ({r.targets.length} repos)
                </span>
              )}
            </span>
            <span className="wa-num text-right font-mono text-[11px] text-adaptive-400">
              {relativeFromUnix(r.startedUnix)}
            </span>
            <span className="wa-num text-right font-mono text-[11px] text-adaptive-400">
              {r.endedUnix ? formatDuration(r.endedUnix - r.startedUnix) : 'running'}
            </span>
            <span
              className={cn(
                'wa-num text-right font-mono text-[10px]',
                r.truncated ? 'text-sev-warn' : 'text-adaptive-400'
              )}
              title={r.truncated ? 'The log was truncated' : undefined}
            >
              {r.lineCount}
              {r.truncated && '+'}
            </span>
          </button>
        ))
      )}
    </TabPanel>
  )
}

function statusTone(status: RunStatus): Tone {
  switch (status.kind) {
    case 'running':
      return 'info'
    case 'exited':
      // A non-zero exit is not always a failure — a drift check exits 1 to *report*
      // drift — which is why this is warn rather than err, matching the toast.
      return status.code === 0 ? 'ok' : 'warn'
    case 'failed':
      return 'err'
    default:
      return 'idle'
  }
}
