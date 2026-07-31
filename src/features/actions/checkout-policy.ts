import { Archive, ArrowRight, Trash2 } from 'lucide-react'
import type { DirtyPolicy } from '@/domain/types'

/**
 * What to do about uncommitted work when switching branch.
 *
 * Shared between the workspace-wide CheckoutAllDialog and the per-repo checkout
 * popover on the detail page. Extracted rather than duplicated because the wording
 * is the safety notice: "cannot be undone" has to say exactly the same thing in both
 * places, or one of them is lying.
 */
export const POLICIES: {
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

/** Singular wording, for the one-repo case where "those repos" reads wrong. */
export const POLICY_LABEL: Record<DirtyPolicy, string> = {
  skip: 'Leave changes alone',
  stash: 'Stash first',
  discard: 'Discard changes',
}

/**
 * Mirrors the backend's `valid_branch_name`, to fail before a round trip.
 *
 * The backend still validates — this is a nicer error, not the guard. Shared by
 * both checkout dialogs, since a name one of them accepts and the other rejects
 * would be the more confusing outcome.
 */
export function isValidBranchName(name: string): boolean {
  const n = name.trim()
  if (!n || n.length > 255) return false
  if (/^[-/]/.test(n) || /[/.]$/.test(n)) return false
  if (n.endsWith('.lock') || n.includes('..') || n.includes('//') || n.includes('@{')) return false
  if (n === '@') return false
  return !/[\s~^:?*[\\'"\u0000-\u001f]/.test(n)
}
