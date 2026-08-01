import type { ProjectItem } from '@/domain/types'

/** Items with no status, or a blank one. Not a real column, so kept out of the
 * status set — a project without a "Status" field would otherwise render one
 * column named "" and nothing else. */
export const NO_STATUS = 'No status'

/**
 * Groups items by their status field, first-seen order.
 *
 * No fixed column set: a project's status options are its own (a board might use
 * "Todo/Doing/Done" or "Backlog/Now/Later/Shipped"), so the columns are whatever
 * values are actually present, not a guess baked into this app.
 */
export function groupByStatus(items: ProjectItem[]): Map<string, ProjectItem[]> {
  const groups = new Map<string, ProjectItem[]>()
  const noStatus: ProjectItem[] = []

  for (const item of items) {
    const key = item.status?.trim()
    if (!key) {
      noStatus.push(item)
      continue
    }
    const bucket = groups.get(key)
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }

  if (noStatus.length > 0) groups.set(NO_STATUS, noStatus)
  return groups
}
