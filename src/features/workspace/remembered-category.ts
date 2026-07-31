import type { Category } from '@/domain/types'

/**
 * Whether a remembered folder selection still applies to the open workspace.
 *
 * Two ways it can stop applying, and only one of them was ever checked. The
 * obvious one: the folder is gone — renamed, or emptied of repos. The other: the
 * selection belongs to a *different* workspace. `expandedCategory` is a bare
 * folder name, and two workspaces both having a `frontend/` is entirely normal, so
 * without the stamp a launch into workspace B silently scans B's `frontend` as
 * though it were the folder you last chose in A.
 *
 * A missing stamp (`null`) is accepted: it means the selection predates the stamp,
 * and the folder-exists half still has to pass.
 */
export function keepRememberedCategory(
  selected: Category | null,
  categoryRoot: string | null,
  bootRoot: string,
  categories: readonly Category[]
): boolean {
  if (selected === null) return true
  if (categoryRoot !== null && categoryRoot !== bootRoot) return false
  return categories.includes(selected)
}
