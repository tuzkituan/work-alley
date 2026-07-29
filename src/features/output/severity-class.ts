import type { Severity } from '@/domain/types'

/**
 * Log-line colour by severity. Shared so the output pane and the first-run clone
 * screen cannot drift apart on what "[FAIL]" looks like.
 *
 * `stream` and `severity` are deliberately independent: git writes progress to
 * stderr, and painting all of stderr red trains people to ignore red.
 */
export const SEVERITY_CLASS: Record<Severity, string> = {
  cmd: 'text-primary font-semibold',
  ok: 'text-sev-ok',
  warn: 'text-sev-warn',
  err: 'text-sev-err',
  info: 'text-sev-info',
  out: 'text-adaptive-800',
}
