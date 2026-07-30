import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { useRunAction } from '@/hooks/use-action'
import { POLICIES } from '@/features/actions/checkout-policy'
import { repoId, type DirtyPolicy, type RepoRef } from '@/domain/types'

/**
 * Switch one repo to one branch, with the preview first.
 *
 * The same shape as CheckoutAllDialog and for the same reason: the interesting
 * question — is there uncommitted work, and what should happen to it — cannot be
 * answered until something looks. So this runs the read-only preview, then offers
 * the policy, and only then dispatches. The action still passes through the normal
 * confirmation gate; this popover chooses the *policy*, it does not authorise the run.
 *
 * Reuses `preview_checkout`, an existing command with one caller: it takes a list of
 * repos, and one repo is simply the n=1 case.
 */
export function BranchCheckout({
  repo,
  branch,
  children,
}: {
  repo: RepoRef
  branch: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [policy, setPolicy] = useState<DirtyPolicy>('stash')
  const run = useRunAction()

  const { data, isPending, error } = useQuery({
    queryKey: keys.checkoutPreview(repoId(repo), branch),
    queryFn: () => api.previewCheckout([repo], branch),
    enabled: open,
    // Never cached: branch and dirty state change while you work, and a stale
    // "0 uncommitted changes" here is exactly the wrong thing to be confident about.
    staleTime: 0,
    gcTime: 0,
  })

  const preview = data?.[0]
  const dirty = preview?.dirtyCount ?? 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            Switch to <span className="truncate font-mono text-primary-600">{branch}</span>
          </div>

          {isPending ? (
            <Skeleton className="h-12 w-full" />
          ) : error ? (
            <div className="text-xs text-sev-err">Could not preview: {error.message}</div>
          ) : !preview ? (
            <div className="text-xs text-adaptive-500">Nothing to preview.</div>
          ) : preview.alreadyThere ? (
            <div className="text-xs text-adaptive-500">
              Already on <span className="font-mono">{branch}</span> with a clean tree.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 font-mono text-[11.5px] text-adaptive-600">
                <span className="truncate">{preview.current ?? '(detached)'}</span>
                <span className="text-adaptive-300">→</span>
                <span className="truncate text-adaptive-900">{preview.target}</span>
              </div>

              {!preview.targetExists && (
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
                  {POLICIES.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPolicy(p.id)}
                      className={cn(
                        'flex items-start gap-2 rounded-md border px-2 py-1.5 text-left',
                        policy === p.id
                          ? 'border-adaptive-950 bg-adaptive-100'
                          : 'border-adaptive-200 hover:bg-adaptive-100/60'
                      )}
                    >
                      <p.icon className={cn('mt-px size-3 flex-none', p.tone)} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-medium">{p.label}</span>
                        <span className="block text-[10.5px] leading-tight text-adaptive-500">
                          {p.detail}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <Button
                variant="waPrimary"
                size="waSm"
                disabled={!preview.targetExists}
                onClick={() => {
                  setOpen(false)
                  run({ kind: 'checkout', refs: [repo], branch, dirty: policy })
                }}
              >
                Check out {branch}
              </Button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
