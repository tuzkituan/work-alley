import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, GitPullRequest } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { TONE_TEXT, type Tone } from '@/domain/severity'
import type { PullRequest, RepoId, RepoRef } from '@/domain/types'
import { BranchCheckout } from './BranchCheckout'
import { PanelEmpty, PanelError, PanelSkeleton, TabPanel } from './panel-parts'

const REVIEW_META: Record<string, { label: string; tone: Tone }> = {
  APPROVED: { label: 'approved', tone: 'ok' },
  CHANGES_REQUESTED: { label: 'changes requested', tone: 'err' },
  REVIEW_REQUIRED: { label: 'review required', tone: 'warn' },
}

/** CI, from gh's rolled-up check state. `''` means no checks — never rendered green. */
const CHECK_META: Record<string, { label: string; tone: Tone }> = {
  passing: { label: '✓ ci', tone: 'ok' },
  failing: { label: '✕ ci', tone: 'err' },
  pending: { label: '• ci', tone: 'warn' },
}

export function PullRequestsPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const [mineOnly, setMineOnly] = useState(false)
  const [hideDrafts, setHideDrafts] = useState(false)

  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: keys.prs(id),
    queryFn: () => api.listPullRequests(repo),
    // gh hits the network; don't hammer it while clicking around.
    staleTime: 60_000,
  })

  const all = data?.kind === 'ok' ? data.prs : []
  const slug = data?.kind === 'ok' ? data.slug : ''
  const prs = all.filter((p) => (!mineOnly || p.isMine) && (!hideDrafts || !p.isDraft))

  // Each failure mode is a state to render, not an exception — and each is a *body*
  // under the shared header rather than an early return that hid the Refresh button.
  const body = () => {
    if (isPending) return <PanelSkeleton n={3} height="h-10" />
    if (error) return <PanelError what="pull requests" message={error.message} />

    switch (data?.kind) {
      case 'ghMissing':
        return (
          <PanelEmpty>
            The GitHub CLI is not installed, so pull requests cannot be listed. Install{' '}
            <code className="font-mono">gh</code>, then Refresh.
          </PanelEmpty>
        )
      case 'notAuthenticated':
        return (
          <PanelEmpty>
            <code className="font-mono">gh</code> is not logged in. Run{' '}
            <code className="font-mono">gh auth login</code> in a terminal, then Refresh.
            <div className="mt-1 font-mono text-[11px] text-adaptive-400">{data.message}</div>
          </PanelEmpty>
        )
      case 'noRemote':
        return (
          <PanelEmpty>
            This repo has no <code className="font-mono">origin</code> remote, so there is nothing
            to list pull requests against.
          </PanelEmpty>
        )
      case 'failed':
        return <PanelError what="pull requests" message={data.message} />
      default:
        if (all.length === 0) return <PanelEmpty>No open pull requests.</PanelEmpty>
        if (prs.length === 0) {
          return <PanelEmpty>No pull requests match the current filters.</PanelEmpty>
        }
        return (
          <>
            {prs.map((pr) => (
              <PrRow key={pr.number} pr={pr} repo={repo} />
            ))}
          </>
        )
    }
  }

  return (
    <TabPanel
      icon={<GitPullRequest className="size-3.5 text-adaptive-400" />}
      title={data?.kind === 'ok' ? `${prs.length} open` : 'Pull requests'}
      right={
        // The slug is already in hand whenever gh worked, so an "open the repo on
        // GitHub" link costs nothing — no extra call, no new backend field.
        slug ? (
          <button
            type="button"
            onClick={() => void openUrl(`https://github.com/${slug}`).catch(() => {})}
            className="truncate font-mono text-[11px] text-adaptive-400 hover:text-primary-600 hover:underline"
            title={`Open github.com/${slug}`}
          >
            {slug}
          </button>
        ) : undefined
      }
      isFetching={isFetching}
      onRefresh={() => void refetch()}
      actions={
        // Only offered once there is something to filter — two dead toggles above an
        // empty list is noise.
        all.length > 0 ? (
          <>
            <FilterChip
              label={`Mine${mineOnly ? '' : ` (${all.filter((p) => p.isMine).length})`}`}
              active={mineOnly}
              onClick={() => setMineOnly((v) => !v)}
              title="Only pull requests you opened"
            />
            <FilterChip
              label="Hide drafts"
              active={hideDrafts}
              onClick={() => setHideDrafts((v) => !v)}
              title="Hide draft pull requests"
            />
          </>
        ) : undefined
      }
    >
      {body()}
    </TabPanel>
  )
}

function FilterChip({
  label,
  active,
  onClick,
  title,
}: {
  label: string
  active: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[11px]',
        active
          ? 'border-primary-600 bg-primary-600/10 text-primary-600'
          : 'border-adaptive-300 text-adaptive-500 hover:bg-adaptive-100'
      )}
    >
      {label}
    </button>
  )
}

function PrRow({ pr, repo }: { pr: PullRequest; repo: RepoRef }) {
  const review = REVIEW_META[pr.reviewDecision]
  const check = CHECK_META[pr.checks]

  return (
    <div className="wa-pr-cols w-full border-b border-adaptive-200 px-3 py-2.5 last:border-b-0 hover:bg-adaptive-100/60">
      <span className="wa-num font-mono text-[11px] text-primary-600">#{pr.number}</span>

      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void openUrl(pr.url).catch(() => {})}
            className="truncate text-left text-[13px] font-medium hover:text-primary-600 hover:underline"
            title={`${pr.title} — open on GitHub`}
          >
            {pr.title}
          </button>
          {/* CI first: on a list of ten PRs it is the field that decides which one
              you open. Absent when the repo has no checks — silence, not a green. */}
          {check && (
            <span className={cn('flex-none font-mono text-[10px]', TONE_TEXT[check.tone])}>
              {check.label}
            </span>
          )}
          {pr.mergeable === 'CONFLICTING' && (
            <span className="flex-none rounded-sm border border-error-500/40 px-1 text-[10px] text-sev-err">
              conflicts
            </span>
          )}
          {pr.isDraft && (
            <span className="flex-none rounded-sm border border-adaptive-300 px-1 text-[10px] text-adaptive-500">
              draft
            </span>
          )}
          {pr.isMine && (
            <span className="flex-none rounded-sm border border-primary-600 px-1 text-[10px] text-primary-600">
              mine
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-adaptive-500">
          {/* The head branch is a checkout target, so it is the click surface: the
              usual next step after reading a PR is looking at it locally. */}
          <BranchCheckout repo={repo} branch={pr.headRef}>
            <button
              type="button"
              className="truncate hover:text-primary-600 hover:underline"
              title={`Check out ${pr.headRef}`}
            >
              {pr.headRef}
            </button>
          </BranchCheckout>
          <span className="text-adaptive-300">→</span>
          <span className="flex-none">{pr.baseRef}</span>
          <span className="text-adaptive-300">·</span>
          <span className="flex-none">{pr.author}</span>
          {pr.labels.slice(0, 2).map((l) => (
            <span
              key={l}
              className="wa-d-optional flex-none truncate rounded-sm border border-adaptive-200 px-1 text-[10px]"
            >
              {l}
            </span>
          ))}
        </div>
      </div>

      <span className="wa-d-optional wa-num font-mono text-[11px]">
        <span className="text-sev-ok">+{pr.additions}</span>{' '}
        <span className="text-sev-err">−{pr.deletions}</span>{' '}
        <span className="text-adaptive-400">
          {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
        </span>
      </span>

      <span
        className={cn(
          'wa-d-narrow truncate text-right text-[11px]',
          review ? TONE_TEXT[review.tone] : 'text-adaptive-400'
        )}
      >
        {review?.label ?? ''}
      </span>

      <span
        className="wa-num text-right font-mono text-[11px] text-adaptive-400"
        title={new Date(pr.updatedUnix * 1000).toLocaleString()}
      >
        {pr.updatedRelative}
      </span>

      <button
        type="button"
        onClick={() => void openUrl(pr.url).catch(() => {})}
        title="Open on GitHub"
        className="text-adaptive-400 hover:text-primary-600"
      >
        <ExternalLink className="size-3" />
      </button>
    </div>
  )
}
