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
    <div className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
      {/* Side by side while there is room, stacked when the panel is narrow — the
          centre panel is user-resizable down to 420px. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.15fr_1fr]">
        <RecentCommitsPanel repoCount={inFolder.length} scope={expanded} />
        <LocalServicesPanel />
      </div>
    </div>
  )
}
