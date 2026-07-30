import { useEffect } from 'react'
import type { Run } from '@/stores/run-store'
import { requestCancel } from './cancel-run'

/**
 * Whether a key event is someone typing, in which case Ctrl+C is theirs.
 *
 * xterm's hidden textarea counts, which is the case that matters: while a shell is
 * focused, Ctrl+C must reach the shell as SIGINT rather than cancel a run in the
 * background.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

/**
 * Ctrl+C cancels the run being shown, the way it would in a terminal.
 *
 * Two deliberate exclusions, both because Ctrl+C is also Copy:
 *
 * - a non-empty selection means copy, so the accelerator falls through untouched. The
 *   log is selectable text and copying a failing line out of it is common, so
 *   swallowing that would be worse than having no shortcut at all.
 * - Cmd is never accepted, only Ctrl. On macOS Cmd+C is Copy and Ctrl+C is the
 *   interrupt, and conflating the modifiers would break copy on that platform.
 *
 * Bound on `window` rather than the log element: the pane holds no focus of its own
 * once you have clicked a chip, so a locally bound handler would never fire.
 */
export function useCancelKey(run: Run | undefined): void {
  const runId = run?.runId
  const active = run?.summary.status.kind === 'running' && !run.cancelling

  useEffect(() => {
    if (!runId || !active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'c' || !e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (window.getSelection()?.toString()) return
      e.preventDefault()
      requestCancel(runId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runId, active])
}
