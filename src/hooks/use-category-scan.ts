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
 * view, so running git across every repo would be work nobody asked for. A
 * folder is scanned once and then cached; "Rescan" re-runs it explicitly.
 */
export function useCategoryScan(toolsReady: boolean) {
  const qc = useQueryClient()
  const expanded = useUiStore((s) => s.expandedCategory)
  const allRepos = useUiStore((s) => s.allRepos)
  const scanned = useScanStore((s) => s.scanned)
  const beginCategory = useScanStore((s) => s.beginCategory)
  const inFlight = useRef<Set<Category>>(new Set())

  // All-repos mode scans the whole workspace, once, on the same
  // scan-then-cache terms as a folder. Omitting `categories` is what asks the
  // backend for everything — see `git::categories_or_all`.
  useEffect(() => {
    if (!allRepos) return
    if (!toolsReady) return
    if (inFlight.current.has(ALL)) return
    inFlight.current.add(ALL)

    void connectBridge(qc)
      .then(() => api.startScan({}))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        useScanStore.getState().fail(msg)
        toast.error('Could not scan the workspace', { description: msg })
      })
      .finally(() => {
        inFlight.current.delete(ALL)
      })
    // Deliberately not keyed on `scanned`: a workspace-wide scan marks every folder
    // it covered, so re-running on that change would start a second scan the moment
    // the first one landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRepos, toolsReady, qc])

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

/**
 * The in-flight key for the workspace-wide scan.
 *
 * Only ever a key in this module's own `inFlight` set — never passed to the backend
 * as a folder name, which is the trap a sentinel category invites.
 */
const ALL = '\u0000all'

/**
 * Explicit re-scan. `null` re-scans every folder, for all-repos mode.
 *
 * `beginCategory` is skipped for the workspace-wide case: it sets `scanning` to a
 * single folder name, and claiming one folder is scanning when all of them are
 * would light the wrong spinner.
 */
export function useRescanCategory() {
  const qc = useQueryClient()
  const beginCategory = useScanStore((s) => s.beginCategory)
  return (category: Category | null) => {
    if (category === null) {
      void connectBridge(qc).then(() => api.startScan({ force: true }))
      return
    }
    beginCategory(category)
    void connectBridge(qc).then(() => api.startScan({ categories: [category], force: true }))
  }
}
