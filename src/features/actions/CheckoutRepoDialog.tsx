import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, CircleAlert, Cloud, Search } from 'lucide-react'
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
import { Skeleton } from '@/components/ui/skeleton'
import { repoId, type BranchInfo, type DirtyPolicy, type RepoRef } from '@/domain/types'
import { useRunAction } from '@/hooks/use-action'
import { api } from '@/ipc/commands'
import { cn } from '@/lib/utils'
import { keys } from '@/queries/keys'
import { isValidBranchName, POLICIES } from './checkout-policy'

/**
 * Switch one repo to one branch.
 *
 * Replaces two surfaces that answered the same question differently: a dropdown
 * submenu that fired immediately with a hardcoded `dirty: 'stash'` and no preview
 * at all, and a popover on the detail page that previewed properly but could only
 * act on a branch you had already picked somewhere else. A dialog is the honest
 * shape — the list is long, the preview is a paragraph, and the dirty-work policy
 * is a decision, none of which fits under a menu item.
 *
 * Three steps, in the order the questions actually arise: which branch, what would
 * happen, and what to do about uncommitted work. The run still goes through the
 * confirmation gate afterwards — this chooses the *policy*, it does not authorise
 * anything.
 */
export function CheckoutRepoDialog({
  open,
  onOpenChange,
  repo,
  current,
  initialBranch = null,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repo: RepoRef
  /** The branch this repo is on, so it can be marked and sorted first. */
  current: string | null
  /**
   * Preselect a branch, for the callers that already know which one — a row in the
   * Branches tab, a PR's head. The picker stays: having decided to switch, changing
   * your mind about the target is one click rather than a second dialog.
   */
  initialBranch?: string | null
}) {
  const run = useRunAction()
  const id = repoId(repo)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(initialBranch)
  const [policy, setPolicy] = useState<DirtyPolicy>('stash')

  // Every open starts from scratch. A branch chosen last time is not a default —
  // it is a different question with the same answer shape.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setPicked(initialBranch)
    setPolicy('stash')
  }, [open, initialBranch])

  const branches = useQuery({
    queryKey: keys.branches(id),
    queryFn: () => api.listBranches(repo),
    enabled: open,
    staleTime: 60_000,
  })

  const typed = query.trim()
  // Typing a name that does not exist yet is legitimate — `preview_checkout`
  // reports `targetExists: false` and the button stays disabled, which is a better
  // answer than hiding the name you just typed.
  const target = picked ?? (typed.length > 0 ? typed : null)
  const nameOk = target === null || isValidBranchName(target)

  const preview = useQuery({
    // Keyed by repo id, not by name: two repos called `web` in different folders
    // would otherwise share a preview.
    queryKey: keys.checkoutPreview(id, target ?? '<none>'),
    queryFn: () => api.previewCheckout([repo], target),
    enabled: open && target !== null && nameOk,
    // Branch and dirty state move while you work, and a stale "0 uncommitted
    // changes" is exactly the wrong thing to be confident about.
    staleTime: 0,
    gcTime: 0,
  })

  const rows = useMemo(() => {
    const all = branches.data ?? []
    const q = typed.toLowerCase()
    const matched = q ? all.filter((b) => b.name.toLowerCase().includes(q)) : all
    // The branch you are on first, so the list opens on something recognisable.
    return [...matched].sort((a, b) => Number(b.name === current) - Number(a.name === current))
  }, [branches.data, typed, current])

  const p = preview.data?.[0]
  const dirty = p?.dirtyCount ?? 0
  const canRun = !!target && nameOk && !!p && p.targetExists && !p.alreadyThere

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Switch branch</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{repo.name}</span> is on{' '}
            <span className="font-mono">{current ?? '(detached)'}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-adaptive-400" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              // Typing supersedes a click: the field is now the answer.
              setPicked(null)
            }}
            placeholder="Filter branches, or type a name…"
            aria-label="Branch"
            className="h-[30px] pl-7 text-xs"
          />
        </div>

        <div className="wa-scroll max-h-56 overflow-y-auto rounded-md border border-adaptive-200">
          {branches.isPending ? (
            <div className="flex flex-col gap-2 p-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          ) : branches.error ? (
            <div className="p-3 text-xs text-sev-err">
              Could not list branches: {branches.error.message}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-3 text-[11.5px] text-adaptive-500">
              {typed
                ? `No branch matches “${typed}”. It will be created from origin if it exists there.`
                : 'No branches found.'}
            </div>
          ) : (
            rows.map((b) => (
              <BranchOption
                key={b.name}
                branch={b}
                current={b.name === current}
                selected={b.name === target}
                onPick={() => {
                  setPicked(b.name)
                  setQuery('')
                }}
              />
            ))
          )}
        </div>

        {/* The preview, in the space it needs rather than as a tooltip. Nothing here
            until a branch is chosen: there is no question to answer yet. */}
        {target && (
          <div className="flex flex-col gap-2 rounded-md border border-adaptive-200 bg-adaptive-50 p-2.5">
            {!nameOk ? (
              <div className="text-[11.5px] text-sev-err">
                “{target}” is not a valid branch name.
              </div>
            ) : preview.isPending ? (
              <Skeleton className="h-8 w-full" />
            ) : preview.error ? (
              <div className="text-[11.5px] text-sev-err">
                Could not preview: {preview.error.message}
              </div>
            ) : !p ? (
              <div className="text-[11.5px] text-adaptive-500">Nothing to preview.</div>
            ) : p.alreadyThere ? (
              <div className="text-[11.5px] text-adaptive-500">
                Already on <span className="font-mono">{target}</span> with a clean tree.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 font-mono text-[11.5px] text-adaptive-600">
                  <span className="truncate">{p.current ?? '(detached)'}</span>
                  <span className="text-adaptive-300">→</span>
                  <span className="truncate text-adaptive-900">{p.target}</span>
                </div>

                {!p.targetExists && (
                  <div className="flex items-start gap-1.5 text-[11.5px] text-sev-warn">
                    <CircleAlert className="mt-px size-3 flex-none" />
                    No such branch locally or on origin.
                  </div>
                )}

                {dirty > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <div className="text-[11.5px] text-sev-warn">
                      {dirty} uncommitted change{dirty === 1 ? '' : 's'} here.
                    </div>
                    {POLICIES.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setPolicy(opt.id)}
                        className={cn(
                          'flex items-start gap-2 rounded-md border px-2 py-1.5 text-left',
                          policy === opt.id
                            ? 'border-adaptive-950 bg-adaptive-100'
                            : 'border-adaptive-200 hover:bg-adaptive-100/60'
                        )}
                      >
                        <opt.icon className={cn('mt-px size-3 flex-none', opt.tone)} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-medium">{opt.label}</span>
                          <span className="block text-[10.5px] leading-tight text-adaptive-500">
                            {opt.detail}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="waOutline" size="waSm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="waPrimary"
            size="waSm"
            disabled={!canRun}
            onClick={() => {
              if (!canRun || !target) return
              onOpenChange(false)
              run({ kind: 'checkout', refs: [repo], branch: target, dirty: policy })
            }}
          >
            {target ? `Check out ${target}` : 'Check out'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BranchOption({
  branch,
  current,
  selected,
  onPick,
}: {
  branch: BranchInfo
  current: boolean
  selected: boolean
  onPick: () => void
}) {
  const { ahead, behind } = branch

  return (
    <button
      type="button"
      onClick={onPick}
      disabled={current}
      className={cn(
        'flex w-full items-center gap-2 border-b border-adaptive-200 px-2.5 py-1.5 text-left last:border-b-0',
        selected ? 'bg-adaptive-100' : 'hover:bg-adaptive-100/60',
        current && 'cursor-default'
      )}
    >
      {/* "You do not have this yet" changes what checkout does — it creates a local
          tracking branch rather than switching to one. */}
      {!branch.local && (
        <Cloud className="size-3 flex-none text-adaptive-400" aria-label="Only on origin" />
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-[11.5px]',
          current ? 'font-semibold text-primary-600' : 'text-adaptive-800'
        )}
        title={branch.subject ?? branch.name}
      >
        {branch.name}
      </span>
      <span className="flex-none font-mono text-[10.5px]">
        {ahead > 0 && <span className="text-sev-warn">↑{ahead}</span>}
        {ahead > 0 && behind > 0 && ' '}
        {behind > 0 && <span className="text-sev-info">↓{behind}</span>}
      </span>
      {current && <span className="flex-none text-[10px] text-adaptive-400">here</span>}
      {selected && !current && <Check className="size-3 flex-none text-sev-ok" />}
    </button>
  )
}
