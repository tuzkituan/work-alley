import { useRunStore, WORKSPACE_KEY } from '@/stores/run-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { RepoId } from '@/domain/types'

export interface Busy {
  runs: number
  terms: number
  total: number
}

/**
 * What is happening in one repo: commands running, and live shells open.
 *
 * Two *primitive* selectors summed at the call site, never one selector returning a
 * fresh object — that breaks useSyncExternalStore's snapshot caching and re-renders
 * every row on every store write.
 *
 * Both numbers exist because two places used to label a count of runs as
 * "terminals" — the repo row's tooltip and the top bar's menu — there being no
 * per-scope terminal count to read. And `runningByScope` now counts bulk runs
 * against each repo they touch, so a 40-repo pull finally lights up all 40 rows.
 */
export function useBusy(id: RepoId | null): Busy {
  const key = id ?? WORKSPACE_KEY
  const runs = useRunStore((s) => s.runningByScope[key] ?? 0)
  const terms = useTerminalStore((s) => s.liveByScope[key] ?? 0)
  return { runs, terms, total: runs + terms }
}

/** `2 running · 1 shell`, or null when this repo is quiet. */
export function busyLabel(b: Busy): string | null {
  const parts: string[] = []
  if (b.runs > 0) parts.push(`${b.runs} running`)
  if (b.terms > 0) parts.push(`${b.terms} ${b.terms === 1 ? 'shell' : 'shells'}`)
  return parts.length > 0 ? parts.join(' · ') : null
}
