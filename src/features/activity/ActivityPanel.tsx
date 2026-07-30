import { useMemo } from 'react'
import { RecentCommitsPanel } from '@/features/commits/RecentCommitsPanel'
import { LocalServicesPanel } from '@/features/services/LocalServicesPanel'
import { useUiStore } from '@/stores/ui-store'
import type { Bootstrap } from '@/domain/types'

/**
 * Recent commits and local services, on their own tab.
 *
 * These used to sit underneath the repo list in the same scroll container, which
 * meant scrolling past every repo in the folder to reach them — and on a wide
 * window they competed with the cards for the same horizontal space. Neither is
 * something you read *while* scanning repos, so they get their own tab.
 */
export function ActivityPanel({ boot }: { boot: Bootstrap | undefined }) {
  const expanded = useUiStore((s) => s.expandedCategory)

  const inFolder = useMemo(
    () => (expanded ? (boot?.repos ?? []).filter((r) => r.category === expanded) : []),
    [boot?.repos, expanded]
  )

  return (
    // Full height, not a scrolling page: each panel scrolls its own list, so the
    // tab itself never scrolls. Both used to be capped at 320px, which left most
    // of a tall window empty while the commit list scrolled inside a short box.
    <div className="flex min-h-0 flex-1 flex-col px-4 py-3.5">
      {/* Side by side while there is room, stacked when the panel is narrow — the
          centre panel is user-resizable down to 420px. Stacked, the tab scrolls
          instead: two panels sharing a short height would leave both unreadable. */}
      <div className="wa-scroll grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-[1.15fr_1fr] lg:overflow-visible">
        <RecentCommitsPanel repoCount={inFolder.length} scope={expanded} />
        <LocalServicesPanel />
      </div>
    </div>
  )
}
