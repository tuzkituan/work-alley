import { useMemo, useRef } from 'react'
import { Pill, SectionLabel } from '@/components/wa/primitives'
import { NEEDS_YOU_META, derive } from '@/domain/severity'
import type { NeedsYouKind } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'

const ORDER: NeedsYouKind[] = [
  'uncommitted',
  'behind',
  'stale',
  'error',
  'packageDrift',
  'detached',
]

/**
 * The counts are filters, not decoration. At any real repo count "41
 * uncommitted" is only useful if clicking it shows you those 41.
 */
export function NeedsYouStrip() {
  const repos = useScanStore((s) => s.repos)
  const trackedLatest = useScanStore((s) => s.trackedLatest)
  const scanning = useScanStore((s) => s.scanning)
  const expanded = useUiStore((s) => s.expandedCategory)
  const isScanned = useScanStore((s) => (expanded ? s.scanned.has(expanded) : false))
  const filterChip = useUiStore((s) => s.filterChip)
  const toggleFilterChip = useUiStore((s) => s.toggleFilterChip)

  // Counts cover the open folder only, because that is the only folder that has
  // been scanned. Summing across folders would mix real numbers with unknowns.
  const counts = useMemo(() => {
    const c = new Map<NeedsYouKind, number>()
    if (!expanded) return c
    for (const r of repos.values()) {
      if (r.ref.category !== expanded) continue
      for (const k of derive(r, trackedLatest).kinds) c.set(k, (c.get(k) ?? 0) + 1)
    }
    return c
  }, [repos, trackedLatest, expanded])

  // Partial counts during a scan would be misinformation — "12 uncommitted"
  // climbing to 41 reads as a change in the workspace, not in our knowledge of it.
  const settled = isScanned && scanning !== expanded

  // So instead of live counts, a rescan keeps showing the last ones we were sure
  // about.
  //
  // The previous answer was to render every kind with an em-dash placeholder, which
  // was worse than either alternative: pressing Rescan flashed all six chips on
  // screen — including "errored" and "detached" for a folder that had neither — and
  // then removed four of them a moment later. Holding the settled counts keeps the
  // strip the same width and the same shape across a rescan; the numbers are a
  // second stale, which is invisible next to six chips appearing and vanishing.
  const held = useRef<{ folder: string; counts: Map<NeedsYouKind, number> } | null>(null)
  if (settled && expanded) held.current = { folder: expanded, counts }
  // Another folder's counts are not a stand-in for this one's, so a folder switch
  // falls back to the scanning note rather than to numbers from somewhere else.
  const shown = settled
    ? counts
    : held.current?.folder === expanded
      ? held.current.counts
      : null

  return (
    <div className="flex flex-none flex-wrap items-center gap-[7px] border-b border-adaptive-200 px-4 py-2.5">
      <SectionLabel className="flex-none">
        Needs you {expanded ? `in ${expanded}/` : ''}
      </SectionLabel>

      {!expanded && (
        <span className="text-xs text-adaptive-400">open a folder to scan it</span>
      )}

      {/* Nothing known about this folder yet — a first scan, or one just switched
          to. One word beats six placeholder chips. */}
      {expanded && !shown && (
        <span className="text-xs text-adaptive-400">scanning…</span>
      )}

      {expanded &&
        shown &&
        ORDER.map((kind) => {
          const meta = NEEDS_YOU_META[kind]
          const n = shown.get(kind) ?? 0
          if (n === 0) return null
          return (
            <Pill
              key={kind}
              tone={meta.tone}
              count={n}
              label={meta.label}
              active={filterChip === kind}
              // Not clickable mid-scan: the count it would filter on is the previous
              // one, so the result would not match the number on the chip.
              onClick={settled ? () => toggleFilterChip(kind) : undefined}
              title={settled ? `Show only repos that are ${meta.label}` : 'Scanning…'}
            />
          )
        })}

      {expanded && shown && shown.size === 0 && (
        <Pill tone="ok" label="everything is clean and in sync" dot count={undefined} />
      )}
    </div>
  )
}
