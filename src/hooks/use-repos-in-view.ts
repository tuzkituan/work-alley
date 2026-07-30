import { useMemo } from 'react'
import type { Bootstrap, Category, RepoRef } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'

/**
 * Which repos the centre panel and the Needs-you strip are describing.
 *
 * One hook rather than the same conditional in both, because they have to agree:
 * counts computed over a different set than the rows below them is a strip that
 * says "3 uncommitted" above four uncommitted repos.
 *
 * `scope` is what identifies the view for scanning and caching — a folder name, or
 * the string 'all'. It is deliberately not a `Category`: nothing looks it up as a
 * directory, and typing it as one is how a sentinel ends up being passed to
 * `startScan` as a folder to scan.
 */
export interface ReposInView {
  repos: RepoRef[]
  /** null when nothing is selected — neither a folder nor all-repos mode. */
  scope: Category | 'all' | null
  /** For headings: "mobile/" or "all repos". */
  label: string
  /** Every folder this view covers, which is what a scan is started for. */
  categories: Category[]
  /** All of `categories` have been scanned. */
  scanned: boolean
  /** A scan covering this view is in flight. */
  scanning: boolean
}

export function useReposInView(boot: Bootstrap | undefined): ReposInView {
  const allRepos = useUiStore((s) => s.allRepos)
  const expanded = useUiStore((s) => s.expandedCategory)
  const scannedSet = useScanStore((s) => s.scanned)
  const scanningOne = useScanStore((s) => s.scanning)

  const bootRepos = boot?.repos
  const bootCategories = boot?.categories

  return useMemo(() => {
    const repos = bootRepos ?? []

    if (allRepos) {
      const categories = (bootCategories ?? []).map((c) => c.category)
      return {
        repos,
        scope: 'all',
        label: 'all repos',
        categories,
        // Every folder, because a flat list that silently omits an unscanned folder
        // is exactly the "did I check that one?" problem this mode exists to fix.
        scanned: categories.length > 0 && categories.every((c) => scannedSet.has(c)),
        scanning: scanningOne !== null,
      }
    }

    if (expanded) {
      return {
        repos: repos.filter((r) => r.category === expanded),
        scope: expanded,
        label: `${expanded}/`,
        categories: [expanded],
        scanned: scannedSet.has(expanded),
        scanning: scanningOne === expanded,
      }
    }

    return {
      repos: [],
      scope: null,
      label: '',
      categories: [],
      scanned: false,
      scanning: false,
    }
  }, [allRepos, expanded, bootRepos, bootCategories, scannedSet, scanningOne])
}
