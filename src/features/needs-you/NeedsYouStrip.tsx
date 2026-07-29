import { useMemo } from 'react'
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
  'uiMismatch',
  'detached',
]

/**
 * In the design this strip is decorative. With 63 repos it becomes the primary
 * filter: "41 uncommitted" is only useful if clicking it shows you those repos.
 */
export function NeedsYouStrip() {
  const repos = useScanStore((s) => s.repos)
  const uiLatest = useScanStore((s) => s.uiLatest)
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
      for (const k of derive(r, uiLatest).kinds) c.set(k, (c.get(k) ?? 0) + 1)
    }
    return c
  }, [repos, uiLatest, expanded])

  // Partial counts during a scan would be misinformation — "12 uncommitted"
  // climbing to 41 reads as a change in the workspace, not in our knowledge of it.
  const settled = isScanned && scanning !== expanded

  return (
    <div className="flex flex-none flex-wrap items-center gap-[7px] border-b border-adaptive-200 px-4 py-2.5">
      <SectionLabel className="flex-none">
        Needs you {expanded ? `in ${expanded}/` : ''}
      </SectionLabel>

      {!expanded && (
        <span className="text-xs text-adaptive-400">open a folder to scan it</span>
      )}

      {expanded &&
        ORDER.map((kind) => {
          const meta = NEEDS_YOU_META[kind]
          const n = counts.get(kind) ?? 0
          if (settled && n === 0) return null
          return (
            <Pill
              key={kind}
              tone={meta.tone}
              count={settled ? n : '—'}
              label={meta.label}
              active={filterChip === kind}
              onClick={settled ? () => toggleFilterChip(kind) : undefined}
              title={settled ? `Show only repos that are ${meta.label}` : 'Scanning…'}
            />
          )
        })}

      {expanded && settled && counts.size === 0 && (
        <Pill tone="ok" label="everything is clean and in sync" dot count={undefined} />
      )}
    </div>
  )
}
