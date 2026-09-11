import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  MoreHorizontal,
  Plus,
} from 'lucide-react'
import { openUrl } from '@/lib/open-url'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { TONE_TEXT, type Tone } from '@/domain/severity'
import { repoId, type PrStateFilter, type PullRequest, type RepoId, type RepoRef } from '@/domain/types'
import { useActionStore, useRunAction } from '@/hooks/use-action'
import { CommentPrDialog, CreatePrDialog, MergePrDialog, ReviewPrDialog } from './PrDialogs'
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

/**
 * How long after a PR write to keep asking GitHub what happened.
 *
 * GitHub is eventually consistent about this: a merge that exits 0 still reports the
 * pull request as open for a beat. `bridge.ts` invalidates on `run:exit`, which
 * lands inside that beat, and this panel has no steady-state polling to catch up
 * afterwards. So a write of our own opens a short window where it does.
 */
const NUDGE_MS = 45_000
const POLL_MS = 3_000

const STATES: { value: PrStateFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]

export function PullRequestsPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const [mineOnly, setMineOnly] = useState(false)
  const [hideDrafts, setHideDrafts] = useState(false)
  const [prState, setPrState] = useState<PrStateFilter>('open')
  const nudgeUntil = useRef(0)

  // One dialog target at a time, which keeps the row menus stateless.
  const [creating, setCreating] = useState(false)
  const [reviewing, setReviewing] = useState<PullRequest | null>(null)
  const [commenting, setCommenting] = useState<PullRequest | null>(null)
  const [merging, setMerging] = useState<PullRequest | null>(null)

  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: keys.prs(id, prState),
    queryFn: () => api.listPullRequests(repo, prState),
    // gh hits the network; don't hammer it while clicking around.
    staleTime: 60_000,
    // No steady-state polling. This is a 20s-ceiling network call, and a PR list
    // does not move by itself the way a running workflow does; the only interval is
    // the one a write of our own opens.
    refetchInterval: () => (Date.now() < nudgeUntil.current ? POLL_MS : false),
    refetchIntervalInBackground: false,
  })

  // `lastRan` is set once `run_action` has actually returned, which is exactly when
  // GitHub's answer becomes worth asking for again.
  const lastRan = useActionStore((s) => s.lastRan)
  useEffect(() => {
    if (!lastRan || !lastRan.kind.startsWith('ghPr')) return
    // Several variants carry an optional `ref`, so presence is not enough.
    const ref = 'ref' in lastRan ? lastRan.ref : null
    if (!ref || repoId(ref) !== id) return
    nudgeUntil.current = Date.now() + NUDGE_MS
    void refetch()
    // `refetch` has a fresh identity each render; the action is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastRan, id])

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
        if (all.length === 0) {
          return (
            <PanelEmpty>
              {prState === 'open' ? 'No open pull requests.' : 'No pull requests here.'}
            </PanelEmpty>
          )
        }
        if (prs.length === 0) {
          return <PanelEmpty>No pull requests match the current filters.</PanelEmpty>
        }
        return (
          <>
            {prs.map((pr) => (
              <PrRow
                key={pr.number}
                pr={pr}
                repo={repo}
                onReview={() => setReviewing(pr)}
                onComment={() => setCommenting(pr)}
                onMerge={() => setMerging(pr)}
              />
            ))}
          </>
        )
    }
  }

  return (
    <>
      <TabPanel
        icon={<GitPullRequest className="size-3.5 text-adaptive-400" />}
        title={data?.kind === 'ok' ? `${prs.length} ${prState === 'open' ? 'open' : 'shown'}` : 'Pull requests'}
        right={
          // The slug is already in hand whenever gh worked, so an "open the repo on
          // GitHub" link costs nothing: no extra call, no new backend field.
          slug ? (
            <button
              type="button"
              onClick={() => openUrl(`https://github.com/${slug}`)}
              className="truncate font-mono text-[11px] text-adaptive-400 hover:text-primary-600 hover:underline"
              title={`Open github.com/${slug}`}
            >
              {slug}
            </button>
          ) : undefined
        }
        trailing={
          <Button
            variant="waOutline"
            size="waSm"
            onClick={() => setCreating(true)}
            title="Open a pull request from this repo's branch"
          >
            <Plus className="size-3" />
            New
          </Button>
        }
        isFetching={isFetching}
        onRefresh={() => void refetch()}
        actions={
          <>
            {/* Always offered, unlike the two filters below: with no open PRs the
                question "are there closed ones?" is exactly the one being asked. */}
            {STATES.map((st) => (
              <FilterChip
                key={st.value}
                label={st.label}
                active={prState === st.value}
                onClick={() => setPrState(st.value)}
                title={`Show ${st.label.toLowerCase()} pull requests`}
              />
            ))}
            {all.length > 0 && (
              <>
                <span className="mx-0.5 h-3 w-px bg-adaptive-300" />
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
            )}
          </>
        }
      >
        {body()}
      </TabPanel>

      <CreatePrDialog
        open={creating}
        onOpenChange={setCreating}
        repo={repo}
        id={id}
        defaultBase={all[0]?.baseRef ?? 'main'}
        currentBranch={null}
      />
      <ReviewPrDialog
        open={reviewing !== null}
        onOpenChange={(o) => !o && setReviewing(null)}
        repo={repo}
        pr={reviewing}
      />
      <CommentPrDialog
        open={commenting !== null}
        onOpenChange={(o) => !o && setCommenting(null)}
        repo={repo}
        pr={commenting}
      />
      <MergePrDialog
        open={merging !== null}
        onOpenChange={(o) => !o && setMerging(null)}
        repo={repo}
        id={id}
        pr={merging}
      />
    </>
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

function PrRow({
  pr,
  repo,
  onReview,
  onComment,
  onMerge,
}: {
  pr: PullRequest
  repo: RepoRef
  onReview: () => void
  onComment: () => void
  onMerge: () => void
}) {
  const run = useRunAction()
  const review = REVIEW_META[pr.reviewDecision]
  const check = CHECK_META[pr.checks]
  const open = pr.state === 'OPEN'

  // Disabled with a reason rather than hidden, wherever the reason is GitHub's rule
  // rather than this app's preference. Rust refuses these too (the row is a hint,
  // the backend's own last listing is the gate), but a button that looks live and
  // then errors is worse than one that explains itself.
  const mergeBlocked = pr.isDraft
    ? 'This is a draft. Mark it ready for review first.'
    : pr.mergeable === 'CONFLICTING'
      ? `Conflicts with ${pr.baseRef} have to be resolved on the branch first.`
      : !open
        ? 'This pull request is not open.'
        : null

  return (
    <div className="wa-pr-cols group relative w-full border-b border-adaptive-200 px-3 py-2.5 last:border-b-0 hover:bg-adaptive-100/60">
      <span className="wa-num font-mono text-[11px] text-primary-600">#{pr.number}</span>

      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openUrl(pr.url)}
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
          {/* Only worth saying on a list that can contain closed rows. */}
          {pr.state === 'MERGED' && (
            <span className="flex-none rounded-sm border border-primary-600/40 px-1 text-[10px] text-primary-600">
              merged
            </span>
          )}
          {pr.state === 'CLOSED' && (
            <span className="flex-none rounded-sm border border-adaptive-300 px-1 text-[10px] text-adaptive-500">
              closed
            </span>
          )}
          {pr.isMine && (
            <span className="flex-none rounded-sm border border-primary-600 px-1 text-[10px] text-primary-600">
              mine
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-adaptive-500">
          {/* `gh pr checkout`, not a plain `git checkout` of the head branch. The
              difference is forks: a fork PR's head does not exist on origin, so the
              git version failed silently on exactly the PRs most worth looking at. */}
          <button
            type="button"
            onClick={() => run({ kind: 'ghPrCheckout', ref: repo, number: pr.number })}
            className="truncate hover:text-primary-600 hover:underline"
            title={`Check out #${pr.number} (${pr.headRef})`}
          >
            {pr.headRef}
          </button>
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
        onClick={() => openUrl(pr.url)}
        title="Open on GitHub"
        className="text-adaptive-400 hover:text-primary-600"
      >
        <ExternalLink className="size-3" />
      </button>

      {/* On hover, over the timestamp: the same place the Actions tab puts its run
          actions, and for the same reason: the row has no track to spare, and these
          are what you reach for once you have found the pull request. */}
      <div className="absolute top-1/2 right-8 hidden -translate-y-1/2 items-center gap-1 bg-adaptive-100 pl-2 group-hover:flex">
        {open && (
          <>
            <Button
              variant="waGhost"
              size="waIcon"
              title={`Review #${pr.number}`}
              aria-label="Review"
              onClick={onReview}
            >
              <Check className="size-3" />
            </Button>
            <Button
              variant="waGhost"
              size="waIcon"
              title={`Comment on #${pr.number}`}
              aria-label="Comment"
              onClick={onComment}
            >
              <MessageSquare className="size-3" />
            </Button>
            <Button
              variant="waGhost"
              size="waIcon"
              disabled={mergeBlocked !== null}
              title={mergeBlocked ?? `Merge #${pr.number} into ${pr.baseRef}`}
              aria-label="Merge"
              onClick={onMerge}
            >
              <GitMerge className="size-3" />
            </Button>
          </>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="waGhost" size="waIcon" title="More" aria-label="More actions">
              <MoreHorizontal className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              onClick={() => run({ kind: 'ghPrCheckout', ref: repo, number: pr.number })}
            >
              Check out this branch
            </DropdownMenuItem>
            {open && (
              <>
                <DropdownMenuSeparator />
                {pr.isDraft ? (
                  <DropdownMenuItem
                    onClick={() => run({ kind: 'ghPrReady', ref: repo, number: pr.number })}
                  >
                    Mark ready for review
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => run({ kind: 'ghPrDraft', ref: repo, number: pr.number })}
                  >
                    Convert to draft
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => run({ kind: 'ghPrClose', ref: repo, number: pr.number })}
                >
                  Close without merging
                </DropdownMenuItem>
              </>
            )}
            {/* GitHub does not reopen a merged pull request, so the item is not
                offered for one. */}
            {pr.state === 'CLOSED' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => run({ kind: 'ghPrReopen', ref: repo, number: pr.number })}
                >
                  Reopen
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openUrl(pr.url)}>Open on GitHub</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
