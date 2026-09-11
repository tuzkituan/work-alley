import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { isValidBranchName } from '@/features/actions/checkout-policy'
import { useRunAction } from '@/hooks/use-action'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import type {
  MergeMethod,
  PullRequest,
  RepoId,
  RepoRef,
  ReviewVerdict,
} from '@/domain/types'

/**
 * The forms the one-click PR actions cannot express.
 *
 * Three of the nine writes need something typed or chosen first: a title and a
 * base to open a PR, a body to leave a review, a strategy to merge. The rest are
 * a click on a row and have no dialog at all.
 *
 * None of these is the confirmation gate. That still lives in Rust and still
 * renders as `ConfirmActionDialog` afterwards for merge, which is why the merge
 * form below does not restate the warnings: the gate has the authoritative set,
 * derived from the backend's own last listing rather than from this row.
 */

const METHODS: { value: MergeMethod; label: string; hint: string }[] = [
  { value: 'squash', label: 'Squash', hint: 'One commit on the base branch.' },
  { value: 'merge', label: 'Merge commit', hint: 'History kept as it happened.' },
  { value: 'rebase', label: 'Rebase', hint: 'Replayed onto the base, no merge commit.' },
]

// --- create ------------------------------------------------------------------

/**
 * Open a pull request from whatever branch the repo is on.
 *
 * The head branch is deliberately not a field. Rust reads it from git at prepare
 * time, along with whether it has an upstream at all, because a branch that was
 * never pushed makes gh ask where to push it and every backend child has its
 * stdin closed. Offering a picker here would only move that failure later.
 */
export function CreatePrDialog({
  open,
  onOpenChange,
  repo,
  id,
  currentBranch,
  defaultBase,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repo: RepoRef
  id: RepoId
  currentBranch: string | null
  defaultBase: string
}) {
  const run = useRunAction()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState(defaultBase)
  const [draft, setDraft] = useState(false)

  // Reset on each open: a dialog that reopens holding the last PR's title is how
  // you end up filing the same description twice.
  useEffect(() => {
    if (open) {
      setTitle('')
      setBody('')
      setBase(defaultBase)
      setDraft(false)
    }
  }, [open, defaultBase])

  const branches = useQuery({
    queryKey: keys.branches(id),
    queryFn: () => api.listBranches(repo),
    enabled: open,
  })

  const baseOk = base.trim().length > 0 && isValidBranchName(base)
  const sameBranch = currentBranch !== null && base.trim() === currentBranch
  const canRun = title.trim().length > 0 && baseOk && !sameBranch

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Open a pull request</DialogTitle>
          <DialogDescription>
            {currentBranch ? (
              <>
                From <span className="font-mono">{currentBranch}</span>
              </>
            ) : (
              // Not "there is no branch": this panel does not read HEAD, and Rust
              // resolves it at prepare time and refuses a detached one there.
              'From the branch this repo is on.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Field label="Title *">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="feat: what this changes"
              aria-label="Title"
              className="h-[30px] text-xs"
            />
          </Field>

          <Field label="Body" hint="Markdown, as on GitHub. Optional.">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              spellCheck={false}
              aria-label="Body"
              className="w-full rounded-md border border-adaptive-300 bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-primary-600"
            />
          </Field>

          <Field label="Base" hint="The branch this merges into.">
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                value={base}
                onChange={(e) => setBase(e.target.value)}
                spellCheck={false}
                aria-label="Base"
                className="h-[30px] min-w-40 flex-1 font-mono text-xs"
              />
              {(branches.data ?? [])
                .filter((b) => b.name !== currentBranch)
                .slice(0, 3)
                .map((b) => (
                  <Button
                    key={b.name}
                    variant="waOutline"
                    size="waSm"
                    className="font-mono text-[11px]"
                    onClick={() => setBase(b.name)}
                  >
                    {b.name}
                  </Button>
                ))}
            </div>
            {!baseOk && base.length > 0 && (
              <span className="text-[11px] text-sev-err">Not a valid branch name.</span>
            )}
            {sameBranch && (
              <span className="text-[11px] text-sev-err">
                That is the branch you are on, so there is nothing to merge.
              </span>
            )}
          </Field>

          <label className="flex items-center gap-2 text-[11.5px] text-adaptive-700">
            <Switch checked={draft} onCheckedChange={setDraft} aria-label="Draft" />
            Open as a draft
          </label>
        </div>

        <DialogFooter>
          <Button variant="waOutline" size="waSm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="waPrimary"
            size="waSm"
            disabled={!canRun}
            onClick={() => {
              if (!canRun) return
              onOpenChange(false)
              run({
                kind: 'ghPrCreate',
                ref: repo,
                title: title.trim(),
                body,
                base: base.trim(),
                draft,
              })
            }}
          >
            {draft ? 'Open draft' : 'Open pull request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- review ------------------------------------------------------------------

/**
 * Approve, request changes, or leave a review comment.
 *
 * Approving your own PR is not offered, because GitHub refuses it. Rust refuses it
 * too (the row's `isMine` is a hint, the backend's own listing is the gate), but
 * hiding the button is better than explaining the error.
 */
export function ReviewPrDialog({
  open,
  onOpenChange,
  repo,
  pr,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repo: RepoRef
  pr: PullRequest | null
}) {
  const run = useRunAction()
  const [verdict, setVerdict] = useState<ReviewVerdict>('approve')
  const [body, setBody] = useState('')

  useEffect(() => {
    if (open) {
      setVerdict(pr?.isMine ? 'comment' : 'approve')
      setBody('')
    }
  }, [open, pr?.isMine])

  if (!pr) return null

  // Both of these carry a required body, on GitHub's side as well as gh's.
  const needsBody = verdict !== 'approve'
  const canRun = !needsBody || body.trim().length > 0

  const options: { value: ReviewVerdict; label: string; disabled?: boolean }[] = [
    { value: 'approve', label: 'Approve', disabled: pr.isMine },
    { value: 'requestChanges', label: 'Request changes', disabled: pr.isMine },
    { value: 'comment', label: 'Comment' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review #{pr.number}</DialogTitle>
          <DialogDescription className="truncate">{pr.title}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Field label="Verdict">
            <div className="flex flex-wrap gap-1.5">
              {options.map((o) => (
                <Button
                  key={o.value}
                  variant={verdict === o.value ? 'waPrimary' : 'waOutline'}
                  size="waSm"
                  disabled={o.disabled}
                  title={o.disabled ? 'GitHub does not let you review your own pull request' : undefined}
                  onClick={() => setVerdict(o.value)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
            {pr.isMine && (
              <span className="text-[11px] text-adaptive-500">
                This is your own pull request, so only a comment is available.
              </span>
            )}
          </Field>

          <Field
            label={needsBody ? 'Body *' : 'Body'}
            hint={needsBody ? 'Required for a comment or a change request.' : 'Optional.'}
          >
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              spellCheck={false}
              aria-label="Review body"
              className="w-full rounded-md border border-adaptive-300 bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-primary-600"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="waOutline" size="waSm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="waPrimary"
            size="waSm"
            disabled={!canRun}
            onClick={() => {
              if (!canRun) return
              onOpenChange(false)
              run({ kind: 'ghPrReview', ref: repo, number: pr.number, verdict, body })
            }}
          >
            Submit review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- comment -----------------------------------------------------------------

export function CommentPrDialog({
  open,
  onOpenChange,
  repo,
  pr,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repo: RepoRef
  pr: PullRequest | null
}) {
  const run = useRunAction()
  const [body, setBody] = useState('')

  useEffect(() => {
    if (open) setBody('')
  }, [open])

  if (!pr) return null
  const canRun = body.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Comment on #{pr.number}</DialogTitle>
          <DialogDescription className="truncate">{pr.title}</DialogDescription>
        </DialogHeader>

        <Field label="Comment *" hint="An ordinary comment, not a review.">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            spellCheck={false}
            aria-label="Comment"
            className="w-full rounded-md border border-adaptive-300 bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-primary-600"
          />
        </Field>

        <DialogFooter>
          <Button variant="waOutline" size="waSm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="waPrimary"
            size="waSm"
            disabled={!canRun}
            onClick={() => {
              if (!canRun) return
              onOpenChange(false)
              run({ kind: 'ghPrComment', ref: repo, number: pr.number, body })
            }}
          >
            Comment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- merge -------------------------------------------------------------------

/**
 * Pick a strategy, then hand over to the confirmation gate.
 *
 * The chosen strategy is remembered per repo, not globally: a repo with a
 * linear-history rule wants one answer and nothing else, and being asked afresh
 * every time is how the wrong one gets picked on the repo that cares.
 *
 * This form states no warnings. The gate that opens next has them, built in Rust
 * from the backend's last listing, and duplicating them here would mean two sets
 * that can disagree.
 */
export function MergePrDialog({
  open,
  onOpenChange,
  repo,
  id,
  pr,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repo: RepoRef
  id: RepoId
  pr: PullRequest | null
}) {
  const run = useRunAction()
  const config = useQuery({ queryKey: keys.config, queryFn: () => api.getConfig() })
  const remembered = config.data?.mergeMethodOverrides?.[id]

  const [method, setMethod] = useState<MergeMethod>('squash')
  const [deleteBranch, setDeleteBranch] = useState(true)

  useEffect(() => {
    if (open) {
      setMethod(remembered ?? 'squash')
      setDeleteBranch(true)
    }
  }, [open, remembered])

  if (!pr) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Merge #{pr.number} into {pr.baseRef}
          </DialogTitle>
          <DialogDescription className="truncate">{pr.title}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Field label="Strategy">
            <div className="flex flex-col gap-1">
              {METHODS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMethod(m.value)}
                  className={cn(
                    'flex items-baseline gap-2 rounded-md border px-2 py-1.5 text-left',
                    method === m.value
                      ? 'border-primary-600 bg-primary-600/10'
                      : 'border-adaptive-300 hover:bg-adaptive-100'
                  )}
                >
                  <span className="text-[12px] font-medium">{m.label}</span>
                  <span className="text-[11px] text-adaptive-500">{m.hint}</span>
                </button>
              ))}
            </div>
            <span className="text-[11px] text-adaptive-500">
              Remembered for this repo.
            </span>
          </Field>

          <label className="flex items-center gap-2 text-[11.5px] text-adaptive-700">
            <Switch
              checked={deleteBranch}
              onCheckedChange={setDeleteBranch}
              aria-label="Delete the branch"
            />
            Delete <span className="font-mono">{pr.headRef}</span> afterwards
          </label>
          {deleteBranch && (
            <span className="text-[11px] text-adaptive-500">
              Deletes it locally as well as on GitHub.
            </span>
          )}
        </div>

        <DialogFooter>
          <Button variant="waOutline" size="waSm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="waPrimary"
            size="waSm"
            onClick={() => {
              onOpenChange(false)
              // Remembered before the gate, not after: the choice was made here,
              // and it is worth keeping even if the merge is then cancelled or
              // refused for conflicts.
              if (method !== remembered) {
                void api.setConfig({
                  mergeMethodOverrides: {
                    ...(config.data?.mergeMethodOverrides ?? {}),
                    [id]: method,
                  },
                })
              }
              run({ kind: 'ghPrMerge', ref: repo, number: pr.number, method, deleteBranch })
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11.5px] font-semibold text-adaptive-800">{label}</span>
      {hint && <span className="text-[11px] text-adaptive-500">{hint}</span>}
      {children}
    </div>
  )
}
