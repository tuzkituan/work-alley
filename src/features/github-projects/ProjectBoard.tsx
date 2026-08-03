import type { ProjectItem } from '@/domain/types'
import { groupByStatus, NO_STATUS } from './group-by-status'
import { ProjectItemCard } from './ProjectItemCard'

/** One board, columns from whatever status values are actually present. */
export function ProjectBoard({ items }: { items: ProjectItem[] }) {
  const groups = groupByStatus(items)

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-1">
      {[...groups.entries()].map(([status, statusItems]) => (
        <div
          key={status}
          className="flex w-[19rem] flex-none flex-col gap-2 rounded-lg border border-adaptive-200 bg-adaptive-50 p-2.5"
        >
          <div className="flex items-center gap-2 px-0.5">
            <span
              className={
                status === NO_STATUS
                  ? 'text-[11px] font-semibold text-adaptive-400 uppercase tracking-[0.04em]'
                  : 'text-[11px] font-semibold text-adaptive-700 uppercase tracking-[0.04em]'
              }
            >
              {status}
            </span>
            <span className="wa-num font-mono text-[10.5px] text-adaptive-400">
              {statusItems.length}
            </span>
          </div>
          <div className="wa-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {statusItems.map((item) => (
              <ProjectItemCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
