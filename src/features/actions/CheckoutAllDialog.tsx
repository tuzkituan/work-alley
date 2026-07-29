import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, ArrowRight, CircleAlert, GitBranch, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { useRunAction } from '@/hooks/use-action'
import { repoId, type CheckoutPreview, type DirtyPolicy, type RepoRef } from '@/domain/types'

const POLICIES: {
  id: DirtyPolicy
  label: string
  detail: string
  icon: typeof Archive
  tone: string
}[] = [
  {
    id: 'skip',
    label: 'Leave them alone',
    detail: 'Those repos stay on their current branch. Nothing is lost.',
    icon: ArrowRight,
    tone: 'text-adaptive-700',
  },
  {
    id: 'stash',
    label: 'Stash the changes',
    detail: 'git stash push -u, including untracked files. Recover with git stash pop.',
    icon: Archive,
    tone: 'text-sev-warn',
  },
  {
    id: 'discard',
    label: 'Discard the changes',
    detail: 'git reset --hard and git clean -fd. Cannot be undone.',
    icon: Trash2,
    tone: 'text-sev-err',
  },
]

/**
 * Switch a set of repos to one branch: each repo's own default, or a name typed in.
 *
 * The dialog exists because the interesting question cannot be answered in
 * advance: whether repos have uncommitted work, and what to do about it. So it
 * runs the read-only preview first, shows exactly which repos are affected, and
 * only then offers the three policies. The action itself still goes through the
 * normal confirmation gate afterwards — this screen picks the *policy*, it does
 * not authorise the run.
 */
export function CheckoutAllDialog({
  open,
  onOpenChange,
  repos,
  scopeLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repos: RepoRef[]
  scopeLabel: string
}) {
  const run = useRunAction()
  const [policy, setPolicy] = useState<DirtyPolicy>('stash')
  const [mode, setMode] = useState<'default' | 'named'>('default')
  const [typed, setTyped] = useState('')

  // Debounced: the preview runs 2-3 git processes per repo, so it must not fire on
  // every keystroke of a branch name.
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(typed.trim()), 300)
    return () => clearTimeout(t)
  }, [typed])

  const branch = mode === 'named' ? debounced : null
  const nameOk = mode === 'default' || isValidBranchName(debounced)

  const { data, isPending, error } = useQuery({
    queryKey: keys.checkoutPreview(`${scopeLabel}:${repos.length}`, branch ?? '<default>'),
    queryFn: () => api.previewCheckout(repos, branch),
    enabled: open && repos.length > 0 && nameOk && (mode === 'default' || debounced.length > 0),
    // Branch and dirty state change as you work; this must not be served stale.
    staleTime: 0,
    gcTime: 0,
  })

  const groups = useMemo(() => split(data ?? []), [data])

  const start = () => {
    // Only the repos that would actually do something are sent.
    const targets = [...groups.willSwitch, ...groups.dirty].map((p) => p.ref)
    onOpenChange(false)
    run({
      kind: 'checkout',
      refs: targets,
      ...(branch ? { branch } : {}),
      dirty: policy,
    })
  }

  const affected =
    groups.willSwitch.length + (policy === 'skip' ? 0 : groups.dirty.length)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">Check out a branch</DialogTitle>
          <DialogDescription className="text-xs">
            {mode === 'named' ? (
              <>
                Switches every repo in <span className="font-mono">{scopeLabel}</span> that
                has the branch. It is created as a tracking branch where only{' '}
                <span className="font-mono">origin</span> has it.
              </>
            ) : (
              <>
                Switches each repo in <span className="font-mono">{scopeLabel}</span> to the
                branch <span className="font-mono">origin/HEAD</span> points at — which is
                per-repo, not assumed to be <span className="font-mono">main</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* --- which branch ------------------------------------------------ */}
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setMode('default')}
              className={cn(
                'h-[26px] rounded-[5px] border px-2 text-[11px] font-semibold',
                mode === 'default'
                  ? 'border-adaptive-400 bg-adaptive-100 text-adaptive-900'
                  : 'border-adaptive-200 text-adaptive-500 hover:border-adaptive-400'
              )}
            >
              Each repo's default
            </button>
            <button
              type="button"
              onClick={() => setMode('named')}
              className={cn(
                'h-[26px] rounded-[5px] border px-2 text-[11px] font-semibold',
                mode === 'named'
                  ? 'border-adaptive-400 bg-adaptive-100 text-adaptive-900'
                  : 'border-adaptive-200 text-adaptive-500 hover:border-adaptive-400'
              )}
            >
              A branch I type
            </button>
          </div>

          {mode === 'named' && (
            <>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                spellCheck={false}
                placeholder="v26, develop, release/2026.1…"
                className="h-[30px] w-full rounded-md border border-adaptive-300 bg-background px-2 font-mono text-xs text-adaptive-900 placeholder:text-adaptive-400 focus:border-adaptive-950 focus:shadow-focus-ring focus:outline-none"
              />
              {debounced.length > 0 && !nameOk && (
                <p className="text-[11px] text-sev-err">
                  Not a valid branch name — no spaces, and none of
                  <span className="font-mono"> ~ ^ : ? * [ \\ </span>
                  or <span className="font-mono">..</span>
                </p>
              )}
              {/* Repos without the branch are listed below, not silently dropped. */}
              <p className="text-[11px] text-adaptive-500">
                Repos that do not have this branch, locally or on origin, are skipped.
              </p>
            </>
          )}
        </div>

        {error ? (
          <p className="text-xs text-sev-err">{String(error instanceof Error ? error.message : error)}</p>
        ) : mode === 'named' && debounced.length === 0 ? (
          <p className="text-xs text-adaptive-500">Type a branch name to see what would happen.</p>
        ) : isPending ? (
          <div className="flex flex-col gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3 font-mono text-xs">
              <span className="text-sev-ok">{groups.willSwitch.length} will switch</span>
              {groups.dirty.length > 0 && (
                <span className="text-sev-warn">{groups.dirty.length} with local changes</span>
              )}
              {groups.already.length > 0 && (
                <span className="text-adaptive-400">{groups.already.length} already there</span>
              )}
              {groups.unknown.length > 0 && (
                <span className="text-adaptive-400">
                  {groups.unknown.length} {branch ? 'without it' : 'unknown default'}
                </span>
              )}
            </div>

            {groups.dirty.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border border-adaptive-200 bg-card p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <CircleAlert className="size-3.5 text-sev-warn" />
                  {groups.dirty.length} repo{groups.dirty.length === 1 ? '' : 's'} have
                  uncommitted changes
                </div>
                <RepoList rows={groups.dirty} showDirty />
                <div className="flex flex-col gap-1 pt-1">
                  {POLICIES.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPolicy(p.id)}
                      className={cn(
                        'flex items-start gap-2 rounded-md border px-2 py-1.5 text-left',
                        policy === p.id
                          ? 'border-adaptive-400 bg-adaptive-100'
                          : 'border-transparent hover:bg-adaptive-100'
                      )}
                    >
                      <p.icon className={cn('mt-0.5 size-3.5 flex-none', p.tone)} />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-xs font-medium">{p.label}</span>
                        <span className="text-[11px] text-adaptive-500">{p.detail}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {groups.willSwitch.length > 0 && (
              <Section title="Will switch">
                <RepoList rows={groups.willSwitch} />
              </Section>
            )}
            {groups.unknown.length > 0 && (
              <Section
                title={
                  branch
                    ? `Skipped — no branch "${branch}" here`
                    : 'Skipped — no origin/HEAD, so the default branch is unknown'
                }
              >
                <RepoList rows={groups.unknown} />
              </Section>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <span className="text-[11px] text-adaptive-500">
            {affected === 0
              ? 'Nothing would change.'
              : `${affected} repo${affected === 1 ? '' : 's'} will be checked out.`}
          </span>
          <span className="flex gap-2">
            <Button variant="waOutline" size="wa" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="waPrimary" size="wa" disabled={affected === 0} onClick={start}>
              <GitBranch className="size-3.5" />
              {branch ? `Check out ${branch}` : 'Continue'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function split(rows: CheckoutPreview[]) {
  return {
    // A repo with no resolvable target is never guessed at.
    unknown: rows.filter((r) => !r.target),
    already: rows.filter((r) => r.alreadyThere),
    dirty: rows.filter((r) => !!r.target && !r.alreadyThere && r.dirtyCount > 0),
    willSwitch: rows.filter((r) => !!r.target && !r.alreadyThere && r.dirtyCount === 0),
  }
}

/**
 * Mirrors the backend's `valid_branch_name`, to fail before a round trip.
 *
 * The backend still validates — this is a nicer error, not the guard.
 */
function isValidBranchName(name: string): boolean {
  const n = name.trim()
  if (!n || n.length > 255) return false
  if (/^[-/]/.test(n) || /[/.]$/.test(n)) return false
  if (n.endsWith('.lock') || n.includes('..') || n.includes('//') || n.includes('@{')) return false
  if (n === '@') return false
  return !/[\s~^:?*[\\'"\u0000-\u001f]/.test(n)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-semibold tracking-[0.05em] text-adaptive-500 uppercase">
        {title}
      </div>
      {children}
    </div>
  )
}

function RepoList({ rows, showDirty }: { rows: CheckoutPreview[]; showDirty?: boolean }) {
  return (
    <div className="wa-scroll max-h-40 overflow-y-auto rounded-md border border-adaptive-200">
      {rows.map((r) => (
        <div
          key={repoId(r.ref)}
          className="flex items-center gap-2 border-b border-adaptive-200 px-2 py-1 font-mono text-[11px] last:border-b-0"
        >
          <span className="min-w-0 flex-1 truncate text-adaptive-800">{r.ref.name}</span>
          <span className="flex-none text-adaptive-500">{r.current ?? '—'}</span>
          {r.target && (
            <>
              <ArrowRight className="size-2.5 flex-none text-adaptive-400" />
              <span className="flex-none text-adaptive-800">{r.target}</span>
            </>
          )}
          {showDirty && (
            <span className="w-16 flex-none text-right text-sev-warn">
              {r.dirtyCount} change{r.dirtyCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
