import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/ipc/commands'
import { connectBridge } from '@/ipc/bridge'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'
import type { Category } from '@/domain/types'

/**
 * Scans a folder the first time it is expanded, and never before.
 *
 * Nothing is scanned at launch: with everything collapsed there is no folder in
 * view, so running git across all 63 repos would be work nobody asked for. A
 * folder is scanned once and then cached; "Rescan" re-runs it explicitly.
 */
export function useCategoryScan(toolsReady: boolean) {
  const qc = useQueryClient()
  const expanded = useUiStore((s) => s.expandedCategory)
  const scanned = useScanStore((s) => s.scanned)
  const beginCategory = useScanStore((s) => s.beginCategory)
  const inFlight = useRef<Set<Category>>(new Set())

  useEffect(() => {
    if (!expanded) return
    // git is resolved by the toolchain probe, so scanning before it finishes fails
    // with "tool not available". This effect re-runs when toolsReady flips.
    if (!toolsReady) return
    if (scanned.has(expanded) || inFlight.current.has(expanded)) return

    const category = expanded
    inFlight.current.add(category)
    beginCategory(category)

    // Listeners must be attached before start_scan, or scan:started is emitted
    // into the void and `total` is never set.
    void connectBridge(qc)
      .then(() => api.startScan({ categories: [category] }))
      .catch((e: unknown) => {
        // Previously this only set an error flag, which left the rail spinning and
        // every row on a skeleton with no indication of why.
        const msg = e instanceof Error ? e.message : String(e)
        useScanStore.getState().fail(msg)
        toast.error(`Could not scan ${category}/`, { description: msg })
      })
      .finally(() => {
        inFlight.current.delete(category)
      })
  }, [expanded, scanned, beginCategory, qc, toolsReady])
}

/** Explicit re-scan of the open folder. */
export function useRescanCategory() {
  const qc = useQueryClient()
  const beginCategory = useScanStore((s) => s.beginCategory)
  return (category: Category) => {
    beginCategory(category)
    void connectBridge(qc).then(() => api.startScan({ categories: [category], force: true }))
  }
}
