import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock,
  ExternalLink,
  Loader2,
  MinusCircle,
  Play,
  PlayCircle,
  RotateCcw,
  ScrollText,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusDot } from '@/components/wa/primitives'
import { TONE_TEXT, type Tone } from '@/domain/severity'
import {
  repoId,
  type RepoId,
  type RepoRef,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunState,
} from '@/domain/types'
import { useActionStore, useRunAction } from '@/hooks/use-action'
import { api } from '@/ipc/commands'
import { openUrl } from '@/lib/open-url'
import { formatDuration } from '@/lib/time'
import { cn } from '@/lib/utils'
import { keys } from '@/queries/keys'
import { useCiStore } from '@/stores/ci-store'
import { useScanStore } from '@/stores/scan-store'
import { RunWorkflowDialog } from '../RunWorkflowDialog'
import { PanelEmpty, PanelError, PanelSkeleton, TabPanel } from './panel-parts'

/** How often to re-ask GitHub while something is actually moving. */
const POLL_MS = 10_000

/**
 * How long to keep polling after a re-run or a cancel.
 *
 * `gh run rerun` returns before the API surfaces the new run, so the refetch
 * fired when the action finishes lands on the old answer — and with nothing
 * active by then, the interval would return `false` and never ask again.
 */
const NUDGE_MS = 45_000

const STATE_META: Record<WorkflowRunState, { tone: Tone; icon: typeof Clock; label: string }> = {
  queued: { tone: 'idle', icon: Clock, label: 'queued' },
  running: { tone: 'info', icon: Loader2, label: 'in progress' },
  success: { tone: 'ok', icon: CheckCircle2, label: 'success' },
  failure: { tone: 'err', icon: XCircle, label: 'failure' },
  cancelled: { tone: 'idle', icon: Ban, label: 'cancelled' },
  skipped: { tone: 'idle', icon: MinusCircle, label: 'skipped' },
  actionRequired: { tone: 'warn', icon: AlertCircle, label: 'waiting for approval' },
  unknown: { tone: 'idle', icon: CircleHelp, label: 'unknown' },
}

const isActive = (r: WorkflowRun) => r.state === 'queued' || r.state === 'running'

/**
 * GitHub Actions for one repo, so checking CI does not mean leaving the app.
 *
 * The same shape as the Pull requests panel — one `gh` call per question,
 * failure modes rendered as data rather than thrown — with two things that panel
 * does not need: a workflow rail, and a poll.
 *
 * The poll is the app's first, and deliberately its narrowest: `refetchInterval`
 * returns `false` unless a run is queued or in progress, which is the resting
 * state and also what every failure variant reduces to. Everything that stops it
 * is structural — the interval callback, the focus manager, and Radix rendering
 * only the active tab so switching away unmounts the observer.
 */
export function GhActionsPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const run = useRunAction()
  // The branch this repo is on, as the dispatch dialog's default ref.
  const currentBranch = useScanStore((s) => s.repos.get(id)?.branch)

  // Opening this tab is what puts a repo on the rail's CI watch list — and the
  // only thing that does, since asking GitHub about every repo in the workspace
  // would be one process each for an answer that is usually "nothing".
  const watch = useCiStore((s) => s.watch)
  useEffect(() => {
    watch(repo)
    // Keyed on the id: `repo` is a fresh object whenever the scan row changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  /** A workflow *path*, or null for all of them. */
  const [selected, setSelected] = useState<string | null>(null)
  /** Set to a server-filtered fetch when the client-side filter comes up empty. */
  const [fetchPath, setFetchPath] = useState<string | null>(null)
  /** The workflow whose dispatch form is open, if any. */
  const [dispatching, setDispatching] = useState<Workflow | null>(null)

  const workflows = useQuery({
    queryKey: keys.ghWorkflows(id),
    queryFn: () => api.listWorkflows(repo),
    // Workflows change when someone edits .github/workflows, i.e. monthly.
    staleTime: 10 * 60_000,
  })

  const nudgeUntil = useRef(0)
  const runs = useQuery({
    queryKey: keys.ghRuns(id, fetchPath ?? ''),
    queryFn: () => api.listWorkflowRuns(repo, fetchPath ?? undefined),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const d = query.state.data
      const live = d?.kind === 'ok' && d.runs.some(isActive)
      return live || Date.now() < nudgeUntil.current ? POLL_MS : false
    },
    // Left false: an unfocused window must not keep spawning gh.
    refetchIntervalInBackground: false,
  })

  // `lastRan` is set when a gated action is actually confirmed, which is exactly
  // the moment the nudge window should open.
  const lastRan = useActionStore((s) => s.lastRan)
  useEffect(() => {
    if (lastRan?.kind !== 'ghRunRerun' && lastRan?.kind !== 'ghRunCancel') return
    if (repoId(lastRan.ref) !== id) return
    nudgeUntil.current = Date.now() + NUDGE_MS
    void runs.refetch()
    // `runs` is a fresh object each render; keying on the action is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastRan, id])

  // Memoised on the query data, not derived inline: a fresh array each render
  // makes every `useMemo` below it a no-op that recomputes anyway.
  const allRuns = useMemo(
    () => (runs.data?.kind === 'ok' ? runs.data.runs : []),
    [runs.data]
  )
  const wfList = useMemo(
    () => (workflows.data?.kind === 'ok' ? workflows.data.workflows : []),
    [workflows.data]
  )
  const byId = useMemo(() => new Map(wfList.map((w) => [w.id, w])), [wfList])

  // Client-side: selecting a workflow must not cost a gh spawn. The escape hatch
  // below covers the case where the answer is genuinely not in the fetched 50.
  const visible = useMemo(() => {
    if (!selected) return allRuns
    const wf = wfList.find((w) => w.path === selected)
    return allRuns.filter((r) => (wf ? r.workflowId === wf.id : false))
  }, [allRuns, selected, wfList])

  const slug = runs.data?.kind === 'ok' ? runs.data.slug : null
  const selectedWf = selected ? (wfList.find((w) => w.path === selected) ?? null) : null
  const selectedName = selectedWf?.name ?? selected

  function body() {
    if (runs.isPending) return <PanelSkeleton n={5} height="h-10" />
    if (runs.error) return <PanelError what="workflow runs" message={runs.error.message} />

    switch (runs.data?.kind) {
      case 'ghMissing':
        return (
          <PanelEmpty>
            The GitHub CLI is not installed, so this app cannot ask about workflow runs.
            Install <span className="font-mono">gh</span> from the Toolbox.
          </PanelEmpty>
        )
      case 'notAuthenticated':
        return (
          <PanelEmpty>
            <div>
              Not signed in to GitHub. Run <span className="font-mono">gh auth login</span> in
              a terminal.
            </div>
            <div className="mt-1 font-mono text-[11px] text-adaptive-400">
              {runs.data.message}
            </div>
          </PanelEmpty>
        )
      case 'noRemote':
        return <PanelEmpty>This repo has no origin remote on a supported host.</PanelEmpty>
      case 'failed':
        return <PanelError what="workflow runs" message={runs.data.message} />
    }

    // A repo with no workflows at all is a different sentence from one whose
    // workflows have never run — and it is the state most repos are in.
    if (workflows.data?.kind === 'ok' && wfList.length === 0 && allRuns.length === 0) {
      return <PanelEmpty>This repo has no GitHub Actions workflows.</PanelEmpty>
    }
    if (allRuns.length === 0) return <PanelEmpty>No runs yet.</PanelEmpty>

    if (visible.length === 0) {
      return (
        <PanelEmpty>
          <div>No runs for {selectedName} in the last 50.</div>
          {/* One server-filtered fetch, only once the free answer came up empty. */}
          <Button
            variant="waOutline"
            size="waXs"
            className="mt-2"
            onClick={() => setFetchPath(selected)}
          >
            Fetch its runs
          </Button>
        </PanelEmpty>
      )
    }

    return visible.map((r) => (
      <RunRow
        key={r.id}
        run={r}
        repo={repo}
        // The workflow name is on every row when one is selected — the heading
        // already said it.
        showWorkflow={!selected}
        onAction={run}
      />
    ))
  }

  return (
    <TabPanel
      icon={<PlayCircle className="size-3.5 text-adaptive-400" />}
      title={
        runs.data?.kind === 'ok'
          ? selected
            ? `${visible.length} of ${allRuns.length}`
            : `${allRuns.length} runs`
          : 'Actions'
      }
      right={
        slug ? (
          <Button
            variant="waGhost"
            size="waXs"
            className="font-mono text-[11px]"
            title={`Open ${slug} on github.com`}
            onClick={() => openUrl(`https://github.com/${slug}/actions`)}
          >
            {slug}
          </Button>
        ) : undefined
      }
      isFetching={runs.isFetching || workflows.isFetching}
      onRefresh={() => {
        void runs.refetch()
        void workflows.refetch()
      }}
      // Beside Refresh, not down in the filter row: it is the tab's one action,
      // and that row is otherwise all narrowing.
      //
      // Only with a workflow selected — "run a workflow" has to know which one,
      // and GitHub dispatches one at a time. Whether it *can* be dispatched is
      // the dialog's first question, because that answer lives in the file and
      // asking for every workflow up front would be a `gh` call each per visit.
      trailing={
        selectedWf ? (
          <Button
            variant="waOutline"
            size="waXs"
            title={`Start ${selectedWf.name} by hand`}
            onClick={() => setDispatching(selectedWf)}
          >
            <Play className="size-3" />
            Run workflow
          </Button>
        ) : undefined
      }
      // No `actions` row. The picker used to live there, but it is
      // `display: none` above 560px — so the row rendered as a second divider
      // over twelve pixels of nothing. It sits at the top of the body instead,
      // where being hidden costs no border and no space.
    >
      {dispatching && (
        <RunWorkflowDialog
          open
          onOpenChange={(o) => !o && setDispatching(null)}
          repo={repo}
          id={id}
          workflow={dispatching.path}
          workflowName={dispatching.name}
          currentBranch={currentBranch ?? null}
        />
      )}

      {/* The rail's stand-in below 560px. Hidden above it, and then it occupies
          nothing at all. */}
      {wfList.length > 0 && (
        <div className="wa-wf-picker border-b border-adaptive-200 px-3 py-1.5">
          <WorkflowPicker
            workflows={wfList}
            selected={selected}
            onSelect={setSelected}
            total={allRuns.length}
          />
        </div>
      )}

      {wfList.length > 0 ? (
        <div className="wa-wf-split">
          <div className="wa-wf-side">
            <WorkflowRail
              workflows={wfList}
              runs={allRuns}
              byId={byId}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
          <div className="min-w-0">{body()}</div>
        </div>
      ) : (
        body()
      )}
    </TabPanel>
  )
}

/** The rail. Newest-first, so the workflow you just pushed to is at the top. */
function WorkflowRail({
  workflows,
  runs,
  byId,
  selected,
  onSelect,
}: {
  workflows: Workflow[]
  runs: WorkflowRun[]
  byId: Map<number, Workflow>
  selected: string | null
  onSelect: (path: string | null) => void
}) {
  const rows = useMemo(() => {
    const counts = new Map<number, { n: number; newest: WorkflowRun }>()
    let orphans = 0
    for (const r of runs) {
      if (!byId.has(r.workflowId)) {
        orphans += 1
        continue
      }
      const prev = counts.get(r.workflowId)
      if (prev) prev.n += 1
      else counts.set(r.workflowId, { n: 1, newest: r })
    }
    const list = workflows
      .map((w) => ({ wf: w, ...(counts.get(w.id) ?? { n: 0, newest: undefined }) }))
      .sort((a, b) => (b.newest?.updatedUnix ?? 0) - (a.newest?.updatedUnix ?? 0))
    return { list, orphans }
  }, [workflows, runs, byId])

  return (
    <div className="flex flex-col py-1">
      <RailRow
        label="All workflows"
        count={runs.length}
        active={selected === null}
        onClick={() => onSelect(null)}
      />
      {rows.list.map(({ wf, n, newest }) => (
        <RailRow
          key={wf.id}
          label={wf.name}
          count={n}
          tone={newest ? STATE_META[newest.state].tone : undefined}
          // The payoff for asking gh for disabled workflows too: github.com greys
          // them rather than hiding them, and one disabled by sixty days of
          // inactivity is exactly what you came here to notice.
          disabled={wf.state !== 'active'}
          title={wf.state !== 'active' ? `${wf.name} — ${wf.state.replace(/_/g, ' ')}` : wf.name}
          active={selected === wf.path}
          onClick={() => onSelect(wf.path)}
        />
      ))}
      {/* Runs whose workflow is gone, or that an org ruleset created. Kept so the
          counts sum to the "All workflows" number. */}
      {rows.orphans > 0 && <RailRow label="Other" count={rows.orphans} active={false} />}
    </div>
  )
}

function RailRow({
  label,
  count,
  tone,
  active,
  disabled,
  title,
  onClick,
}: {
  label: string
  count: number
  tone?: Tone
  active: boolean
  disabled?: boolean
  title?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={title ?? label}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 text-left text-[11.5px]',
        active ? 'bg-adaptive-100 font-semibold text-adaptive-900' : 'hover:bg-adaptive-100/60',
        disabled && !active && 'text-adaptive-400'
      )}
    >
      {tone ? <StatusDot tone={tone} size={6} /> : <span className="size-[6px] flex-none" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="wa-num flex-none font-mono text-[10px] text-adaptive-400">{count}</span>
    </button>
  )
}

/** The rail's stand-in below 560px, where it and a readable title cannot coexist. */
function WorkflowPicker({
  workflows,
  selected,
  onSelect,
  total,
}: {
  workflows: Workflow[]
  selected: string | null
  onSelect: (path: string | null) => void
  total: number
}) {
  const current = selected ? workflows.find((w) => w.path === selected)?.name : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="waOutline" size="waXs" className="w-[15rem] justify-between">
          <span className="truncate">{current ?? `All workflows (${total})`}</span>
          <ChevronDown className="size-3 flex-none" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuItem onClick={() => onSelect(null)}>All workflows</DropdownMenuItem>
        {workflows.map((w) => (
          <DropdownMenuItem key={w.id} onClick={() => onSelect(w.path)}>
            <span className="truncate">{w.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RunRow({
  run,
  repo,
  showWorkflow,
  onAction,
}: {
  run: WorkflowRun
  repo: RepoRef
  showWorkflow: boolean
  onAction: ReturnType<typeof useRunAction>
}) {
  const meta = STATE_META[run.state]
  const Icon = meta.icon
  const active = isActive(run)

  return (
    <div className="wa-wf-cols group relative border-b border-adaptive-200 px-3 py-2 last:border-b-0 hover:bg-adaptive-100/60">
      <Icon
        className={cn('size-3.5', TONE_TEXT[meta.tone], run.state === 'running' && 'animate-spin')}
        aria-label={meta.label}
        // The raw pair, for when the mapping and reality disagree.
        {...{ title: `${meta.label} (${run.status}${run.conclusion ? `/${run.conclusion}` : ''})` }}
      />

      <div className="flex min-w-0 flex-col">
        <button
          type="button"
          className="truncate text-left text-xs text-adaptive-800 hover:text-primary-600 hover:underline"
          title={run.title}
          onClick={() => openUrl(run.url)}
        >
          {run.title || '(no title)'}
        </button>
        <span className="truncate font-mono text-[11px] text-adaptive-500">
          {[showWorkflow ? run.workflowName : null, run.event, run.branch]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>

      <span className="wa-d-optional wa-num truncate text-right font-mono text-[11px] text-adaptive-400">
        #{run.number}
        {run.attempt > 1 && <span title={`attempt ${run.attempt}`}>·a{run.attempt}</span>}
      </span>

      <span className="wa-d-narrow wa-num truncate text-right font-mono text-[11px] text-adaptive-500">
        {run.durationSecs > 0 ? formatDuration(run.durationSecs) : '—'}
      </span>

      <span
        className="wa-num truncate text-right font-mono text-[11px] text-adaptive-400"
        title={run.updatedUnix > 0 ? new Date(run.updatedUnix * 1000).toLocaleString() : undefined}
      >
        {run.updatedRelative}
      </span>

      <button
        type="button"
        className="text-adaptive-400 hover:text-primary-600"
        title={`Open run #${run.number} on github.com`}
        aria-label="Open on GitHub"
        onClick={() => openUrl(run.url)}
      >
        <ExternalLink className="size-3" />
      </button>

      {/* On hover, over the timestamp — the row has no track to spare, and these
          are the two things you reach for once you have found the run.

          A finished run gets its log; a live one gets Cancel, because
          `gh run view --log` refuses until a run completes and offering it would
          be offering an error. */}
      <div className="absolute top-1/2 right-8 hidden -translate-y-1/2 items-center gap-1 bg-adaptive-100 pl-2 group-hover:flex">
        {active ? (
          <Button
            variant="waGhost"
            size="waIcon"
            title={`Cancel run #${run.number}`}
            aria-label="Cancel run"
            onClick={() => onAction({ kind: 'ghRunCancel', ref: repo, runId: run.id })}
          >
            <Ban className="size-3" />
          </Button>
        ) : (
          <>
            <Button
              variant="waGhost"
              size="waIcon"
              title={`Log for run #${run.number}`}
              aria-label="View log"
              onClick={() =>
                onAction({
                  kind: 'ghRunLog',
                  ref: repo,
                  runId: run.id,
                  // A failed run's interesting output is the failing step; asking
                  // for the whole matrix by default is asking for 200k lines.
                  failedOnly: run.state === 'failure',
                })
              }
            >
              <ScrollText className="size-3" />
            </Button>
            <Button
              variant="waGhost"
              size="waIcon"
              title={
                run.state === 'failure'
                  ? `Re-run the failed jobs of #${run.number}`
                  : `Re-run #${run.number}`
              }
              aria-label="Re-run"
              onClick={() =>
                onAction({
                  kind: 'ghRunRerun',
                  ref: repo,
                  runId: run.id,
                  failedOnly: run.state === 'failure',
                })
              }
            >
              <RotateCcw className="size-3" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
