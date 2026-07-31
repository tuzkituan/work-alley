import { memo, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { KindTag, MonoChip, StatePill, StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import {
  derive,
  installTarget,
  lastFetched,
  runState,
  runTarget,
  TONE_TEXT,
  type Tone,
} from '@/domain/severity'
import { repoId, type RepoRef } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'
import { shortPackageName, useTrackedPackage } from '@/hooks/use-tracked-package'
import { BuildMenu } from './BuildMenu'
import { RepoMenu } from './RepoMenu'
import { CheckoutRepoDialog } from '@/features/actions/CheckoutRepoDialog'

/**
 * Estimated card height, used only to seed the virtualizer.
 *
 * The real height is measured — a hard-coded height clipped the action row
 * whenever the content grew (a wider window, a larger font, a long branch name).
 * Cards are structurally identical, so the measured height is uniform in practice
 * and the list still does not jump as results stream in. The skeleton uses the
 * same minimum so the scroll height is right from the first frame.
 */
export const CARD_HEIGHT = 168

export const RepoCard = memo(function RepoCard({ repo }: { repo: RepoRef }) {
  const id = repoId(repo)
  // Subscribes to exactly this row, so card N re-renders only when repo N changes.
  const status = useScanStore((s) => s.repos.get(id))
  const trackedLatest = useScanStore((s) => s.trackedLatest)
  const trackedPackage = useTrackedPackage()
  const active = useUiStore((s) => s.activeRepoId === id)
  const setActiveRepo = useUiStore((s) => s.setActiveRepo)
  const openDetail = useUiStore((s) => s.openDetail)
  const run = useRunAction()
  // Above the early return: a hook after it would run in one render and not the
  // next, which React refuses.
  const [checkoutOpen, setCheckoutOpen] = useState(false)

  if (!status) return <RepoCardSkeleton repo={repo} />

  const d = derive(status, trackedLatest)
  // This repo's own way of running, not a hardcoded `dev` script.
  const target = runTarget(status)
  // Run cannot work before an install, so the button offers the thing that can.
  const install = installTarget(status)
  const fetched = lastFetched(status)
  const state = runState(status)
  const running = status.tasks

  return (
    <div
      onClick={() => setActiveRepo(id)}
      // Inline, not a Tailwind arbitrary value: a template-literal class name is
      // invisible to Tailwind's build-time scan and would emit nothing.
      style={{ minHeight: CARD_HEIGHT }}
      className={cn(
        'flex h-full cursor-default flex-col gap-2.5 rounded-lg border bg-card p-3 transition-opacity duration-[120ms]',
        active ? 'border-primary-600' : 'border-adaptive-200',
        // Same run-state tint the list rows carry, so switching view does not
        // change which cards read as needing attention.
        state === 'crashed' && 'bg-sev-err/15',
        state === 'up' && 'bg-sev-ok/10',
        (state === 'starting' || state === 'stopping') && 'bg-sev-warn/10'
      )}
    >
      <div className="flex items-start gap-2">
        <StatusDot tone={d.tone} size={8} className="mt-[5px]" />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-[7px]">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="truncate text-left text-sm font-semibold tracking-[-0.01em] hover:text-primary-600 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation()
                    openDetail(id)
                  }}
                >
                  {repo.name}
                </button>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-[11px]">
                {repo.name} — open details
              </TooltipContent>
            </Tooltip>
            <KindTag
              kind={status.shape.kind}
              language={status.shape.language}
              stack={status.shape.stack}
            />
            <MonoChip>{repo.category}</MonoChip>
          </div>

          {/* One line only. Long branch names (fix/lewis.nguyen/breadcrumb-sync)
              truncate rather than wrapping, so every card stays the same height
              and the grid reads as a table. */}
          <div className="flex items-center gap-2 overflow-hidden font-mono text-[11px] whitespace-nowrap text-adaptive-500">
            <button
              type="button"
              className="min-w-0 truncate text-left hover:text-primary-600 hover:underline"
              title={`${status.branch ?? 'HEAD'} — switch branch`}
              onClick={(e) => {
                e.stopPropagation()
                setCheckoutOpen(true)
              }}
            >
              {status.detached ? '(detached)' : (status.branch ?? '—')}
            </button>
            <span className="flex-none text-adaptive-300">·</span>
            <span className={cn('wa-num flex-none', TONE_TEXT[d.syncTone])}>{d.syncLabel}</span>
            {status.lastCommit && (
              <>
                <span className="flex-none text-adaptive-300">·</span>
                <span className="wa-num flex-none">{status.lastCommit.relative} ago</span>
              </>
            )}
            {/* Spelled out rather than shown as a bare age: it sits next to the
                commit age above, and two unlabelled durations side by side are two
                durations nobody can tell apart. */}
            {fetched.age && (
              <>
                <span className="flex-none text-adaptive-300">·</span>
                <span
                  className={cn('wa-num flex-none', fetched.stale && 'text-sev-warn')}
                  title={fetched.title}
                >
                  fetched {fetched.age}
                </span>
              </>
            )}
          </div>
        </div>

        <StatePill tone={d.tone} label={d.stateLabel} />
      </div>

      {/* Three stats, or four when this workspace has a shared package to track. */}
      <div
        className={cn(
          'grid gap-2 border-y border-adaptive-200 py-[9px]',
          trackedPackage ? 'grid-cols-4' : 'grid-cols-3'
        )}
      >
        <Stat label="Changes" value={d.dirtyLabel} tone={d.dirtyTone} />
        <Stat
          label="Conflicts"
          value={status.conflictCount > 0 ? String(status.conflictCount) : 'none'}
          tone={status.conflictCount > 0 ? 'err' : 'ok'}
        />
        {trackedPackage && (
          <Stat
            label={shortPackageName(trackedPackage)}
            value={status.trackedDep.resolved ?? (status.trackedDep.declared ? 'n/a' : '—')}
            tone={
              status.trackedDep.resolved &&
              trackedLatest &&
              status.trackedDep.resolved !== trackedLatest
                ? 'warn'
                : 'idle'
            }
          />
        )}
        {/* Labelled by what is actually up: a repo can be running `cargo` or a
            compose stack, and "Dev" was only ever right for a node script. */}
        <Stat
          label={running.length > 1 ? 'Running' : (running[0]?.task ?? 'Run')}
          value={
            running.map((t) => (t.port ? `:${t.port}` : t.state)).join(' ') ||
            'stopped'
          }
          tone={state === 'crashed' ? 'err' : state ? 'ok' : 'idle'}
        />
      </div>

      {/* Deliberately no flex-wrap — the status text shrinks instead, so the row
          stays one line at any card width. */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="waOutline"
          size="waSm"
          className="shrink-0"
          onClick={() => run({ kind: 'pull', ref: repo })}
        >
          Pull
        </Button>
        <Button
          variant="waOutline"
          size="waSm"
          className="shrink-0"
          onClick={() => run({ kind: 'status', ref: repo })}
        >
          Status
        </Button>
        <Button
          variant="waOutline"
          size="waSm"
          className="shrink-0"
          onClick={() => run({ kind: 'branchList', ref: repo })}
        >
          Branch…
        </Button>
        {/* "Run", not "Start cargo run": the task name is already the label of the
            stat directly above, and repeating it here cost the width Build now
            uses. The full name stays in the tooltip. */}
        {install ? (
          <Button
            variant="waOutline"
            size="waSm"
            className="shrink-0 text-sev-warn"
            title="Dependencies are not installed — install them"
            onClick={() => run(install.spec(repo))}
          >
            Install
          </Button>
        ) : (
        <Button
          variant={target.up ? 'waDanger' : 'waOutline'}
          size="waSm"
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
          onClick={() => {
            if (!target.id || target.busy) return
            run({ kind: target.up ? 'devStop' : 'devStart', ref: repo, task: target.id })
          }}
        >
          {target.up ? 'Stop' : 'Run'}
        </Button>
        )}
        <BuildMenu repo={repo} status={status} size="waSm" />

        <span
          className={cn(
            'wa-num min-w-0 flex-1 truncate text-right font-mono text-[11px]',
            status.error ? 'text-error-500' : 'text-adaptive-400'
          )}
          title={status.error ?? undefined}
        >
          {status.error ?? `${status.scanMs}ms`}
        </span>

        <RepoMenu repo={repo} status={status} />
      </div>

      <CheckoutRepoDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        repo={repo}
        current={status.branch}
      />
    </div>
  )
})

function Stat({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-semibold tracking-[0.05em] text-adaptive-400 uppercase">
        {label}
      </span>
      <span className={cn('wa-num truncate font-mono text-[13px] font-medium', TONE_TEXT[tone])}>
        {value}
      </span>
    </div>
  )
}

/** Shares the real card's minimum height, so the scroll height starts correct. */
export function RepoCardSkeleton({ repo }: { repo: RepoRef }) {
  const statCount = useTrackedPackage() ? 4 : 3
  return (
    <div
      style={{ minHeight: CARD_HEIGHT }}
      className="flex h-full flex-col gap-2.5 rounded-lg border border-adaptive-200 bg-card p-3"
    >
      <div className="flex items-start gap-2">
        <span className="mt-[5px] size-2 flex-none rounded-full bg-adaptive-300" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-[7px]">
            <span className="truncate text-sm font-semibold text-adaptive-500">{repo.name}</span>
            <MonoChip>{repo.category}</MonoChip>
          </div>
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-4 w-14 rounded-full" />
      </div>
      {/* Must match the real card's column count so the height is right from
          the first frame and the list never jumps as results stream in. */}
      <div
        className={cn(
          'grid gap-2 border-y border-adaptive-200 py-[9px]',
          statCount === 4 ? 'grid-cols-4' : 'grid-cols-3'
        )}
      >
        {Array.from({ length: statCount }, (_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-2 w-12" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <Skeleton className="h-7 w-14" />
        <Skeleton className="h-7 w-16" />
        <Skeleton className="h-7 w-20" />
      </div>
    </div>
  )
}
