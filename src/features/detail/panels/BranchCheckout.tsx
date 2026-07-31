import { useState } from 'react'
import { CheckoutRepoDialog } from '@/features/actions/CheckoutRepoDialog'
import { useScanStore } from '@/stores/scan-store'
import { repoId, type RepoRef } from '@/domain/types'

/**
 * A trigger that opens the checkout dialog on a branch already chosen.
 *
 * This used to be a popover with its own preview and policy buttons — a second
 * implementation of the same three questions the dialog asks, differing only in
 * how much room it had to ask them in. It is now a wrapper, so the Branches tab, a
 * PR's head branch and the repo menu all go through one flow.
 *
 * `children` is the trigger, unchanged, so callers did not have to move.
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
  const current = useScanStore((s) => s.repos.get(repoId(repo))?.branch ?? null)

  return (
    <>
      {/* A span rather than cloning the child with an onClick: the callers pass
          buttons of their own, and re-typing their props here is how the two get
          out of step. */}
      <span onClick={() => setOpen(true)}>{children}</span>
      <CheckoutRepoDialog
        open={open}
        onOpenChange={setOpen}
        repo={repo}
        current={current}
        initialBranch={branch}
      />
    </>
  )
}
