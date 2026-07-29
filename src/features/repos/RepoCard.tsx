import { memo } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { KindTag, MonoChip, StatePill, StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import { derive, taskOf, TONE_TEXT, type Tone } from '@/domain/severity'
import { repoId, type RepoRef } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'
import { shortPackageName, useTrackedPackage } from '@/hooks/use-tracked-package'
import { RepoMenu } from './RepoMenu'

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

  if (!status) return <RepoCardSkeleton repo={repo} />

  const d = derive(status, trackedLatest)
  const dev = taskOf(status, 'dev')
  const sb = taskOf(status, 'storybook')
  const devUp = dev?.state === 'up' || dev?.state === 'starting'

  return (
    <div
      onClick={() => setActiveRepo(id)}
      // Inline, not a Tailwind arbitrary value: a template-literal class name is
      // invisible to Tailwind's build-time scan and would emit nothing.
      style={{ minHeight: CARD_HEIGHT }}
      className={cn(
        'flex h-full cursor-default flex-col gap-2.5 rounded-lg border bg-card p-3 transition-opacity duration-[120ms]',
        active ? 'border-primary-600' : 'border-adaptive-200'
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
            <KindTag kind={status.shape.kind} stack={status.shape.stack} />
            <MonoChip>{repo.category}</MonoChip>
          </div>

          {/* One line only. Long branch names (fix/lewis.nguyen/breadcrumb-sync)
              truncate rather than wrapping, so every card stays the same height
              and the grid reads as a table. */}
          <div className="flex items-center gap-2 overflow-hidden font-mono text-[11px] whitespace-nowrap text-adaptive-500">
            <span className="min-w-0 truncate" title={status.branch ?? undefined}>
              {status.detached ? '(detached)' : (status.branch ?? '—')}
            </span>
            <span className="flex-none text-adaptive-300">·</span>
            <span className={cn('wa-num flex-none', TONE_TEXT[d.syncTone])}>{d.syncLabel}</span>
            {status.lastCommit && (
              <>
                <span className="flex-none text-adaptive-300">·</span>
                <span className="wa-num flex-none">{status.lastCommit.relative} ago</span>
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
        <Stat
          label={sb ? 'Dev · SB' : 'Dev'}
          value={
            [
              dev ? (dev.port ? `:${dev.port}` : dev.state) : null,
              sb ? (sb.port ? `sb:${sb.port}` : 'sb') : null,
            ]
              .filter(Boolean)
              .join(' ') || 'stopped'
          }
          tone={
            dev?.state === 'crashed' || sb?.state === 'crashed'
              ? 'err'
              : dev || sb
                ? 'ok'
                : 'idle'
          }
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
        <Button
          variant={devUp ? 'waDanger' : 'waOutline'}
          size="waSm"
          className="shrink-0"
          onClick={() => run({ kind: devUp ? 'devStop' : 'devStart', ref: repo, task: 'dev' })}
        >
          {devUp ? 'Stop dev' : 'Start dev'}
        </Button>

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
