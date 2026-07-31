import { memo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, Code, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { KindTag, StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import {
  crashedRunId,
  derive,
  lastFetched,
  runState,
  runTarget,
  TONE_TEXT,
} from '@/domain/severity'
import { repoId, type RepoRef } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useRunStore } from '@/stores/run-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'
import { keys } from '@/queries/keys'
import { busyLabel, useBusy } from '@/hooks/use-busy'
import { shortPackageName, useTrackedPackage } from '@/hooks/use-tracked-package'
import { BuildMenu } from './BuildMenu'
import { RepoMenu } from './RepoMenu'
import { CheckoutRepoDialog } from '@/features/actions/CheckoutRepoDialog'

/** One row, so 43 repos fit on screen instead of four cards. */
export const ROW_HEIGHT = 40

/**
 * Columns live in CSS (`.wa-cols` in wa-bridge.css) rather than an inline style,
 * because a container query has to be able to change them — an inline template
 * cannot be overridden responsively.
 */
export function RepoListHeader() {
  const trackedPackage = useTrackedPackage()
  return (
    <div
      className={cn(
        'wa-cols sticky top-0 z-10 border-b border-adaptive-200 bg-adaptive-100 px-3 text-[10px] font-semibold tracking-[0.05em] text-adaptive-500 uppercase',
        !trackedPackage && 'wa-no-tracked'
      )}
      style={{ height: 30 }}
    >
      <span />
      <span>Repo</span>
      <span className="wa-col-narrow">Branch</span>
      <span className="wa-col-narrow">Changes</span>
      <span className="wa-col-optional">Sync</span>
      <span className="wa-col-optional">Fetched</span>
      {trackedPackage && (
        <span className="wa-col-optional truncate" title={trackedPackage}>
          {shortPackageName(trackedPackage)}
        </span>
      )}
      <span className="wa-col-dev wa-col-narrow">Dev</span>
      <span className="text-right">Actions</span>
    </div>
  )
}

export const RepoListRow = memo(function RepoListRow({ repo }: { repo: RepoRef }) {
  const id = repoId(repo)
  const status = useScanStore((s) => s.repos.get(id))
  const trackedLatest = useScanStore((s) => s.trackedLatest)
  const trackedPackage = useTrackedPackage()
  const active = useUiStore((s) => s.activeRepoId === id)
  const setActiveRepo = useUiStore((s) => s.setActiveRepo)
  const openDetail = useUiStore((s) => s.openDetail)
  const busy = useBusy(id)
  const run = useRunAction()
  const selectRun = useRunStore((s) => s.setActive)
  // From the bootstrap cache, so this costs nothing per row — the same trick
  // RepoMenu uses for the same list.
  const { data: boot } = useQuery({ queryKey: keys.bootstrap, enabled: false })
  const editors = (boot as { editors?: { id: string; label: string }[] } | undefined)?.editors ?? []

  const d = status ? derive(status, trackedLatest) : null
  // This repo's own way of running — `dev` for one, `cargo run` or `runserver`
  // for the next. Every row used to send the literal 'dev'.
  const target = runTarget(status)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const fetched = lastFetched(status)
  const state = runState(status)
  const running = status?.tasks ?? []
  const driftedFromLatest =
    !!status?.trackedDep.resolved && !!trackedLatest && status.trackedDep.resolved !== trackedLatest

  return (
    <div
      onClick={() => setActiveRepo(id)}
      className={cn(
        'wa-cols border-b border-adaptive-200 px-3',
        !trackedPackage && 'wa-no-tracked',
        // Run state colours the whole row. On 43 rows the Dev column is not where
        // you look to find the one server that died, and a crash is exactly the
        // thing that should be findable without reading a column.
        state === 'crashed' && 'bg-sev-err/15 hover:bg-sev-err/25',
        state === 'up' && 'bg-sev-ok/10 hover:bg-sev-ok/15',
        (state === 'starting' || state === 'stopping') &&
          'bg-sev-warn/10 hover:bg-sev-warn/20',
        !state && (active ? 'bg-adaptive-100' : 'hover:bg-adaptive-100/60'),
        // Selection has to stay visible on a tinted row, and the tint already owns
        // the background — so it becomes a left edge instead.
        active && state && 'shadow-[inset_2px_0_0_0_var(--color-primary-600)]'
      )}
      style={{ height: ROW_HEIGHT }}
    >
      {d ? (
        <StatusDot tone={d.tone} size={7} />
      ) : (
        <span className="size-[7px] flex-none rounded-full bg-adaptive-300" />
      )}

      <div className="flex min-w-0 items-center gap-2">
        {/* Anything happening in this repo, visible without opening a menu.
            The label used to say "terminals" while counting runs, and counted no
            bulk run at all — so a pull of this very repo left the dot dark. */}
        {busy.total > 0 && (
          <span
            className="size-1.5 flex-none rounded-full bg-sev-info"
            title={`${busyLabel(busy)} here`}
            style={{ animation: 'wa-blink 1.4s step-end infinite' }}
          />
        )}
        {/* Native title, not a Radix Tooltip: 43 Popper instances on screen at
            once is a measurable cost for a hover hint. */}
        <button
          type="button"
          className="truncate text-left text-[13px] font-medium hover:text-primary-600 hover:underline"
          title={`${repo.name} — open details`}
          onClick={(e) => {
            e.stopPropagation()
            openDetail(id)
          }}
        >
          {repo.name}
        </button>
        {status && (
          <KindTag
            kind={status.shape.kind}
            language={status.shape.language}
            stack={status.shape.stack}
          />
        )}
      </div>

      {/* The branch name is the switch control. It was inert text next to a menu
          three clicks deep, which is a long way to go to change the one thing the
          cell is about. */}
      {status ? (
        <button
          type="button"
          className="wa-col-narrow truncate text-left font-mono text-[11.5px] text-adaptive-700 hover:text-primary-600 hover:underline"
          title={`${status.branch ?? 'HEAD'} — switch branch`}
          onClick={(e) => {
            e.stopPropagation()
            setCheckoutOpen(true)
          }}
        >
          {status.detached ? '(detached)' : (status.branch ?? '—')}
        </button>
      ) : (
        <Skeleton className="wa-col-narrow h-3 w-28" />
      )}

      {d ? (
        <span
          className={cn('wa-col-narrow wa-num font-mono text-[11.5px]', TONE_TEXT[d.dirtyTone])}
        >
          {d.dirtyLabel}
        </span>
      ) : (
        <Skeleton className="wa-col-narrow h-3 w-16" />
      )}

      {d ? (
        <span
          className={cn('wa-col-optional wa-num font-mono text-[11.5px]', TONE_TEXT[d.syncTone])}
        >
          {d.syncLabel}
        </span>
      ) : (
        <Skeleton className="wa-col-optional h-3 w-12" />
      )}

      {/* How old the sync numbers are. They are computed from local refs, so a
          repo that has not fetched in nine days is not reporting "in sync" — it is
          reporting what was true nine days ago. */}
      {status ? (
        <span
          className={cn(
            'wa-col-optional wa-num truncate font-mono text-[11.5px]',
            fetched.stale ? 'text-sev-warn' : 'text-adaptive-500'
          )}
          title={fetched.title}
        >
          {fetched.age ?? '—'}
        </span>
      ) : (
        <Skeleton className="wa-col-optional h-3 w-8" />
      )}

      {trackedPackage &&
        (status ? (
          <span
            className={cn(
              'wa-col-optional wa-num truncate font-mono text-[11.5px]',
              driftedFromLatest ? 'text-sev-warn' : 'text-adaptive-500'
            )}
            title={`${trackedPackage} ${status.trackedDep.resolved ?? 'n/a'}`}
          >
            {status.trackedDep.resolved ?? (status.trackedDep.declared ? 'n/a' : '—')}
          </span>
        ) : (
          <Skeleton className="wa-col-optional h-3 w-12" />
        ))}

      {/* A button whenever there is something to look at, so a crashed server's
          output is one click from the row that is red because of it. Selecting the
          repo is what scopes the output pane; picking the run puts the failing one
          on screen rather than whichever happens to be newest. */}
      <button
        type="button"
        disabled={running.length === 0}
        className={cn(
          'wa-col-dev wa-col-narrow wa-num truncate text-left font-mono text-[11.5px]',
          state === 'crashed'
            ? 'text-sev-err'
            : state
              ? 'text-sev-ok'
              : 'text-adaptive-400',
          running.length > 0 && 'hover:underline'
        )}
        title={
          running.length === 0
            ? 'Nothing running here'
            : `${running
                .map(
                  (t) =>
                    `${t.task} — ${t.state}${t.port ? ` on :${t.port}` : ''}`
                )
                .join('\n')}\n\nClick to view the output`
        }
        onClick={(e) => {
          e.stopPropagation()
          setActiveRepo(id)
          const focus = crashedRunId(status) ?? running[0]?.runId
          if (focus) selectRun(focus)
        }}
      >
        {running.length === 0
          ? 'stopped'
          : running.map((t) => (t.port ? `:${t.port}` : t.state)).join(' ')}
      </button>

      {/* Icons, not labels: "Pull Status Dev" needed ~200px and the Actions track
          is 124px, so the group used to spill left over the Dev column. Every one
          carries a native `title` — see the note on the repo name above for why
          these are not Radix tooltips. */}
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="waOutline"
          size="waIcon"
          className="shrink-0"
          title="Pull (rebase onto upstream)"
          aria-label="Pull"
          onClick={(e) => {
            e.stopPropagation()
            run({ kind: 'pull', ref: repo })
          }}
        >
          <ArrowDownToLine className="size-3.5" />
        </Button>
        {/* Opening the repo in an editor, in the slot "Show git status" used to
            hold. Status is one of five read-only inspections and already sits in
            the menu under Inspect, whereas this is the action you reach for on a
            row and it had no place on one. First editor only — choosing between
            several stays behind the menu's "Open in". */}
        {editors[0] && (
          <Button
            variant="waOutline"
            size="waIcon"
            className="shrink-0"
            title={`Open in ${editors[0].label}`}
            aria-label={`Open in ${editors[0].label}`}
            onClick={(e) => {
              e.stopPropagation()
              run({ kind: 'openInEditor', ref: repo, editor: editors[0]!.id })
            }}
          >
            <Code className="size-3.5" />
          </Button>
        )}
        {/* Disabled rather than hidden when nothing here runs: a library and a docs
            repo legitimately have no dev server, and a button that vanishes per row
            is harder to read down a list than one that greys out.

            Icon only. A row of 113 repeats the same two words 226 times, and the
            title carries what the label would have said. */}
        <Button
          variant={target.up ? 'waDanger' : 'waOutline'}
          size="waIcon"
          className="shrink-0"
          disabled={!target.id || target.busy}
          title={
            !target.id
              ? 'Nothing to run in this repo'
              : target.busy
                ? `Stopping ${target.label}…`
                : target.up
                  ? `Stop ${target.label}`
                  : target.crashed
                    ? `Restart ${target.label}`
                    : `Start ${target.label}`
          }
          aria-label={target.up ? `Stop ${target.label}` : `Run ${target.label}`}
          onClick={(e) => {
            e.stopPropagation()
            if (!target.id || target.busy) return
            run({ kind: target.up ? 'devStop' : 'devStart', ref: repo, task: target.id })
          }}
        >
          {target.up ? <Square className="size-3" /> : <Play className="size-3.5" />}
        </Button>
        <BuildMenu repo={repo} status={status} iconOnly />
        <RepoMenu repo={repo} status={status} />
      </div>

      <CheckoutRepoDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        repo={repo}
        current={status?.branch ?? null}
      />
    </div>
  )
})
