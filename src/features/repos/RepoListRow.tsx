import { memo } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { KindTag, StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import { derive, taskOf, TONE_TEXT } from '@/domain/severity'
import { repoId, type RepoRef } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'
import { useRunStore } from '@/stores/run-store'
import { shortPackageName, useTrackedPackage } from '@/hooks/use-tracked-package'
import { RepoMenu } from './RepoMenu'

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
      <span>Branch</span>
      <span>Changes</span>
      <span className="wa-col-optional">Sync</span>
      {trackedPackage && (
        <span className="wa-col-optional truncate" title={trackedPackage}>
          {shortPackageName(trackedPackage)}
        </span>
      )}
      <span>Dev</span>
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
  const running = useRunStore((s) => s.runningByScope[id] ?? 0)
  const run = useRunAction()

  const d = status ? derive(status, trackedLatest) : null
  const dev = taskOf(status, 'dev')
  const sb = taskOf(status, 'storybook')
  const devUp = dev?.state === 'up' || dev?.state === 'starting'
  const driftedFromLatest =
    !!status?.trackedDep.resolved && !!trackedLatest && status.trackedDep.resolved !== trackedLatest

  return (
    <div
      onClick={() => setActiveRepo(id)}
      className={cn(
        'wa-cols border-b border-adaptive-200 px-3',
        !trackedPackage && 'wa-no-tracked',
        active ? 'bg-adaptive-100' : 'hover:bg-adaptive-100/60'
      )}
      style={{ height: ROW_HEIGHT }}
    >
      {d ? (
        <StatusDot tone={d.tone} size={7} />
      ) : (
        <span className="size-[7px] flex-none rounded-full bg-adaptive-300" />
      )}

      <div className="flex min-w-0 items-center gap-2">
        {/* A live terminal for this repo, visible without opening any menu. */}
        {running > 0 && (
          <span
            className="size-1.5 flex-none rounded-full bg-sev-info"
            title={`${running} terminal${running === 1 ? '' : 's'} running here`}
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
        {status && <KindTag kind={status.shape.kind} stack={status.shape.stack} />}
      </div>

      {status ? (
        <span
          className="truncate font-mono text-[11.5px] text-adaptive-700"
          title={status.branch ?? undefined}
        >
          {status.detached ? '(detached)' : (status.branch ?? '—')}
        </span>
      ) : (
        <Skeleton className="h-3 w-28" />
      )}

      {d ? (
        <span className={cn('wa-num font-mono text-[11.5px]', TONE_TEXT[d.dirtyTone])}>
          {d.dirtyLabel}
        </span>
      ) : (
        <Skeleton className="h-3 w-16" />
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

      <span
        className={cn(
          'wa-num truncate font-mono text-[11.5px]',
          dev?.state === 'crashed' || sb?.state === 'crashed'
            ? 'text-sev-err'
            : dev || sb
              ? 'text-sev-ok'
              : 'text-adaptive-400'
        )}
        title={sb ? `storybook on :${sb.port ?? '?'}` : undefined}
      >
        {[dev ? (dev.port ? `:${dev.port}` : dev.state) : null, sb ? 'sb' : null]
          .filter(Boolean)
          .join(' ') || 'stopped'}
      </span>

      <div className="flex items-center justify-end gap-1">
        <Button
          variant="waOutline"
          size="waXs"
          className="shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            run({ kind: 'pull', ref: repo })
          }}
        >
          Pull
        </Button>
        <Button
          variant="waOutline"
          size="waXs"
          className="shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            run({ kind: 'status', ref: repo })
          }}
        >
          Status
        </Button>
        <Button
          variant={devUp ? 'waDanger' : 'waOutline'}
          size="waXs"
          className="shrink-0"
          title={devUp ? 'Stop the dev server' : 'Start the dev server'}
          onClick={(e) => {
            e.stopPropagation()
            run({ kind: devUp ? 'devStop' : 'devStart', ref: repo, task: 'dev' })
          }}
        >
          {devUp ? 'Stop' : 'Dev'}
        </Button>
        <RepoMenu repo={repo} status={status} />
      </div>
    </div>
  )
})
