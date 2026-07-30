import { ArrowLeft, ChevronDown, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { KindTag, MonoChip, StatePill, StatusDot } from '@/components/wa/primitives'
import { RepoMenu } from '@/features/repos/RepoMenu'
import { shortPackageName } from '@/hooks/use-tracked-package'
import { useRunAction } from '@/hooks/use-action'
import { useRescanRepo } from '@/hooks/use-rescan-repo'
import { busyLabel } from '@/hooks/use-busy'
import { useUiStore } from '@/stores/ui-store'
import type { StaleState } from '@/domain/types'
import { Field } from './StatGrid'
import { RepoActionBar } from './RepoActionBar'
import type { useDetailRepo } from './use-detail-repo'

/** `fresh 2h` / `stale 9d`, from the timestamp the scan already recorded. */
function fetchedLabel(stale: StaleState | undefined): string {
  if (!stale || stale.kind === 'unknown') return 'unknown'
  const hours = Math.floor((Date.now() / 1000 - stale.lastFetchUnix) / 3600)
  const age = hours < 1 ? 'just now' : hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
  return stale.kind === 'stale' ? `stale ${age}` : `fresh ${age}`
}

/**
 * The identity, the numbers and the actions — pinned above the tabs.
 *
 * `flex-none` and outside the tab scrollport on purpose: the whole card used to
 * live in one page-level scroller, so opening a repo with 40 changed files scrolled
 * the name, the branch and every button off the top of the panel.
 */
export function RepoHeader({ ctx }: { ctx: ReturnType<typeof useDetailRepo> }) {
  const closeDetail = useUiStore((s) => s.closeDetail)
  const collapsed = useUiStore((s) => s.detailHeaderCollapsed)
  const toggleHeader = useUiStore((s) => s.toggleDetailHeader)
  const run = useRunAction()
  const rescanRepo = useRescanRepo()
  const { id, repo, status, d, dev, ahead, behind, trackedPackage, trackedLatest, busy } = ctx
  const port = dev?.port ?? status?.devPort ?? null

  return (
    <div className="flex flex-none flex-col gap-2.5 rounded-lg border border-adaptive-200 bg-card p-3.5">
      <div className="flex items-center gap-2">
        <Button variant="waGhost" size="waIcon" onClick={closeDetail} title="Back to the list">
          <ArrowLeft className="size-4" />
        </Button>
        <StatusDot tone={d?.tone ?? 'idle'} size={9} />
        <h1 className="truncate text-base font-semibold tracking-[-0.01em]">{repo.name}</h1>
        {status && (
          <KindTag
            kind={status.shape.kind}
            language={status.shape.language}
            stack={status.shape.stack}
          />
        )}
        {repo.category && <MonoChip>{repo.category}</MonoChip>}
        {d && <StatePill tone={d.tone} label={d.stateLabel} />}
        <div className="flex-1" />
        {busy.total > 0 && (
          <span className="flex items-center gap-1.5 rounded-full border border-info-500/[0.38] bg-blue-500/[0.12] px-2 py-0.5 text-[11px] text-sev-info">
            <span
              className="size-1.5 rounded-full bg-sev-info"
              style={{ animation: 'wa-blink 1.4s step-end infinite' }}
            />
            {busyLabel(busy)}
          </span>
        )}
        <Button
          variant="waGhost"
          size="waIcon"
          onClick={toggleHeader}
          title={collapsed ? 'Show details and actions' : 'Collapse to the name only'}
          aria-expanded={!collapsed}
        >
          <ChevronDown className={cn('size-4 transition-transform', collapsed && '-rotate-90')} />
        </Button>
        <RepoMenu repo={repo} status={status} />
      </div>

      {/* Outside the collapse, unlike everything below it: the scan's own error is
          the one thing you must not be able to hide by accident.

          `derive` already turns this into a red dot and an "error" pill, but the text
          itself was rendered nowhere — so the one screen dedicated to this repo could
          say something was wrong and not what. */}
      {status?.error && (
        <div className="flex items-start gap-2 rounded-md border border-error-500/40 bg-red-500/[0.08] px-2.5 py-2">
          <TriangleAlert className="mt-px size-3.5 flex-none text-sev-err" />
          <div className="min-w-0 flex-1 font-mono text-[11px] break-words text-sev-err">
            {status.error}
          </div>
          <Button
            variant="waOutline"
            size="waXs"
            className="flex-none"
            onClick={() => void rescanRepo(repo)}
          >
            Rescan
          </Button>
        </div>
      )}

      {collapsed ? null : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-1 font-mono text-[11.5px] text-adaptive-500">
            <span title={status?.path ?? undefined} className="truncate">
              {status?.path ?? id}
            </span>
            {status?.shape.stack.map((t) => (
              <span key={t} className="rounded-sm border border-adaptive-200 px-1 text-[10px]">
                {t}
              </span>
            ))}
            {status?.shape.isMonorepo && (
              <span className="rounded-sm border border-adaptive-200 px-1 text-[10px]">
                monorepo
              </span>
            )}
            {status?.shape.hasDockerfile && (
              <span className="rounded-sm border border-adaptive-200 px-1 text-[10px]">docker</span>
            )}
          </div>

          <div className="wa-stat-grid border-t border-adaptive-200 pt-2.5">
            <Field
              label="Branch"
              value={status?.detached ? '(detached)' : (status?.branch ?? '—')}
              title={
                status?.sync.kind === 'noUpstream'
                  ? `${status.branch ?? 'HEAD'} — no upstream, so nothing to compare against`
                  : undefined
              }
            />
            {/* Clickable, because the label already implies the action: behind means
            pull, ahead means push. */}
            <Field
              label="Sync"
              value={d?.syncLabel ?? '—'}
              tone={d?.syncTone}
              title={
                behind > 0
                  ? `${behind} behind — click to pull`
                  : ahead > 0
                    ? `${ahead} ahead — click to push`
                    : undefined
              }
              onClick={
                behind > 0
                  ? () => run({ kind: 'pull', ref: repo })
                  : ahead > 0
                    ? () => run({ kind: 'push', ref: repo })
                    : undefined
              }
            />
            <Field
              label="Changes"
              value={d?.dirtyLabel ?? '—'}
              tone={d?.dirtyTone}
              title={
                status
                  ? `${status.dirtyCount} modified · ${status.untrackedCount} untracked · ${status.conflictCount} conflicted`
                  : undefined
              }
            />
            {/* HEAD and the last commit subject: the app already has both from the scan
            and showed neither, so the page could not answer "what is checked out
            here" without opening the Commits tab. */}
            <Field
              label="Head"
              value={
                status?.headSha
                  ? `${status.headSha.slice(0, 7)}${status.lastCommit ? `  ${status.lastCommit.subject}` : ''}`
                  : '—'
              }
              title={
                status?.lastCommit
                  ? `${status.lastCommit.subject}\n${status.lastCommit.author} · ${new Date(
                      status.lastCommit.unix * 1000,
                    ).toLocaleString()}`
                  : undefined
              }
            />
            {/* Fetched: `stale` was reduced to a pill label and its timestamp thrown
            away, so "is what I am looking at current?" had no answer. */}
            <Field
              label="Fetched"
              value={fetchedLabel(status?.stale)}
              tone={status?.stale.kind === 'stale' ? 'warn' : 'idle'}
              title={
                status && status.stale.kind !== 'unknown'
                  ? new Date(status.stale.lastFetchUnix * 1000).toLocaleString()
                  : 'No fetch recorded for this repo'
              }
            />
            {/* The statically resolved port, shown even when nothing is running — which
            is exactly when you want to know what a dev server *would* bind to. */}
            <Field
              label="Port"
              value={port === null ? '—' : `:${port}`}
              tone={dev?.port ? 'ok' : 'idle'}
              title={
                dev?.port
                  ? `${dev.task} is listening on :${dev.port} (${dev.portSource})`
                  : port !== null
                    ? `Resolved from the repo, nothing listening yet`
                    : undefined
              }
            />
            {trackedPackage && (
              <Field
                label={shortPackageName(trackedPackage)}
                value={status?.trackedDep.resolved ?? (status?.trackedDep.declared ? 'n/a' : '—')}
                tone={
                  status?.trackedDep.resolved &&
                  trackedLatest &&
                  status.trackedDep.resolved !== trackedLatest
                    ? 'warn'
                    : 'idle'
                }
                title={
                  status?.trackedDep.declared
                    ? `${status.trackedDep.declared} in ${status.trackedDep.field ?? 'dependencies'}${
                        trackedLatest ? ` · latest ${trackedLatest}` : ''
                      }`
                    : 'Not a dependency of this repo'
                }
              />
            )}
          </div>

          <RepoActionBar ctx={ctx} />
        </>
      )}
    </div>
  )
}
