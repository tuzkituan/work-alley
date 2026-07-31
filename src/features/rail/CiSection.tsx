import { useEffect, useRef } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { SectionLabel, StatusDot } from '@/components/wa/primitives'
import { repoId, type RepoRef, type WorkflowRun, type WorkflowRunState } from '@/domain/types'
import { api } from '@/ipc/commands'
import { cn } from '@/lib/utils'
import { keys } from '@/queries/keys'
import { useCiStore } from '@/stores/ci-store'
import { useUiStore } from '@/stores/ui-store'

import { finishedMessage, isActiveRun, justFinished, nextSeen } from './ci-notify'

/** Matches the Actions panel: the two states worth watching for. */
const isActive = (r: WorkflowRun) => isActiveRun(r)

const POLL_MS = 10_000

/**
 * Which of the repos you are watching have CI in flight.
 *
 * The queries live *here*, not in the Actions panel, and that is the point: the
 * panel unmounts the moment you switch tabs, taking its observer and its poll
 * with it. The rail is always mounted, so a run you kicked off keeps being
 * followed while you work somewhere else.
 *
 * Same query key as the panel's, so the two share one fetch rather than doubling
 * the `gh` calls.
 *
 * What this cannot do is tell you about a repo you have never opened. GitHub has
 * no cross-repo endpoint for workflow runs, so the alternative is one process per
 * repo per tick — 113 of them, to answer "nothing" almost every time. The empty
 * state says so rather than implying the workspace is quiet.
 */
export function CiSection() {
  const watched = useCiStore((s) => s.watched)
  const openDetail = useUiStore((s) => s.openDetail)
  const setDetailTab = useUiStore((s) => s.setDetailTab)

  const results = useQueries({
    queries: watched.map((ref) => ({
      queryKey: keys.ghRuns(repoId(ref), ''),
      queryFn: () => api.listWorkflowRuns(ref),
      // Higher than the panel's: the panel is what you are looking at, this is
      // background. Sharing the key means whichever is stricter wins anyway.
      staleTime: 30_000,
      refetchInterval: (query: { state: { data?: unknown } }) => {
        const d = query.state.data as Awaited<ReturnType<typeof api.listWorkflowRuns>> | undefined
        return d?.kind === 'ok' && d.runs.some(isActive) ? POLL_MS : false
      },
      refetchIntervalInBackground: false,
    })),
  })

  const rows = watched.flatMap((ref, i) => {
    const data = results[i]?.data
    if (data?.kind !== 'ok') return []
    return data.runs.filter(isActive).map((run) => ({ ref, run }))
  })

  // Every run this section has seen, and what it was doing. A ref, not state: it
  // exists to compare polls, and re-rendering the rail because a run's state was
  // recorded would be a render per tick per repo for something invisible.
  const seen = useRef(new Map<number, WorkflowRunState>())
  // Deliberately not in the deps array — see below.
  const allRuns = watched.map((ref, i) => {
    const data = results[i]?.data
    return { ref, runs: data?.kind === 'ok' ? data.runs : [] }
  })
  // The key changes only when some run's state does, which is what keeps this
  // effect from firing on every poll that returns the same answer.
  const stateKey = allRuns
    .flatMap(({ runs }) => runs.map((r) => `${r.id}:${r.state}`))
    .join(',')

  useEffect(() => {
    for (const { ref, runs } of allRuns) {
      for (const run of justFinished(seen.current, runs)) {
        const { tone, text, detail } = finishedMessage(run, ref.name)
        toast[tone](text, {
          description: detail,
          // Long enough to still be there when you look back at the window: the
          // whole point is that you were doing something else while it ran.
          duration: tone === 'error' ? 20_000 : 8_000,
          action: {
            label: 'Open',
            onClick: () => {
              openDetail(repoId(ref))
              setDetailTab('actions')
            },
          },
        })
      }
      seen.current = nextSeen(seen.current, runs)
    }
    // `allRuns` is rebuilt every render; `stateKey` is the same information as a
    // primitive, and the only thing that can make this effect worth running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey])

  if (watched.length === 0) return null

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1.5 pb-1">
        <SectionLabel>CI</SectionLabel>
        <span className="wa-num font-mono text-[11px] text-adaptive-400">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <div
          className="px-2 py-1.5 text-[11px] text-adaptive-400"
          title={`Watching ${watched.length} repo${watched.length === 1 ? '' : 's'} — the ones whose Actions tab you have opened. Other repos are not being asked about.`}
        >
          Nothing running in the {watched.length} repo
          {watched.length === 1 ? '' : 's'} you have opened.
        </div>
      ) : (
        rows.map(({ ref, run }) => (
          <CiRow
            key={`${repoId(ref)}:${run.id}`}
            repo={ref}
            run={run}
            onOpen={() => {
              openDetail(repoId(ref))
              setDetailTab('actions')
            }}
          />
        ))
      )}
    </div>
  )
}

function CiRow({
  repo,
  run,
  onOpen,
}: {
  repo: RepoRef
  run: WorkflowRun
  onOpen: () => void
}) {
  const queued = run.state === 'queued'
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${run.workflowName || 'workflow'} · ${run.branch} — open the Actions tab`}
      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-adaptive-200"
    >
      {queued ? (
        <StatusDot tone="idle" size={6} />
      ) : (
        <Loader2 className="size-3 flex-none animate-spin text-sev-info" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-adaptive-800">{repo.name}</span>
        {/* The workflow and branch, because two repos can be building the same
            branch and the name alone does not say which run this is. */}
        <span className="truncate font-mono text-[9.5px] text-adaptive-400">
          {[run.workflowName, run.branch].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className={cn('wa-num flex-none font-mono text-[10px] text-adaptive-400')}>
        {queued ? 'queued' : run.updatedRelative}
      </span>
    </button>
  )
}
