import type { Tone } from './severity'
import type { RunStatus } from './types'

/**
 * One table for how a run or a terminal *reads*, the same way severity.ts is the
 * one table for colour.
 *
 * There were six independent copies of this — in the output pane (three of them),
 * the detail page's Runs tab, the top bar's terminals menu, the machine terminal
 * dock, and the clone wizard — and they had already drifted: a non-zero exit was
 * `warn` in one and `err` in another, and a live terminal's dot was the same blue
 * as a running run's.
 */

/** Only what a chip needs to know about a terminal, so this stays store-agnostic. */
export interface TermLike {
  status: 'live' | 'exited'
  exitCode: number | null
}

export function runTone(status: RunStatus): Tone {
  switch (status.kind) {
    case 'running':
      return 'info'
    case 'exited':
      // A non-zero exit is not always a failure: a drift check exits 1 to *report*
      // drift, and a lint run exits 1 to report lint. So warn, not err — the same
      // reasoning the run:exit toast already uses.
      return status.code === 0 ? 'ok' : 'warn'
    case 'failed':
      return 'err'
    case 'cancelled':
    case 'signaled':
      // Deliberately not `idle`. These used to render grey, which is the same as
      // "nothing has happened here" — so a cancelled pull was indistinguishable
      // from a run that never started. Something *did* happen; it just did not
      // finish.
      return 'warn'
  }
}

export function runStatusLabel(status: RunStatus): string {
  switch (status.kind) {
    case 'running':
      return 'running'
    case 'exited':
      return status.code === 0 ? 'done' : `exit ${status.code}`
    case 'signaled':
      return `signal ${status.signal}`
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      // The message, not just "failed": it is the only place the reason appears,
      // and it was previously dropped entirely.
      return `failed — ${status.message}`
  }
}

export function isRunning(status: RunStatus): boolean {
  return status.kind === 'running'
}

/**
 * Whether a chip's dot should blink.
 *
 * The rule that tells the two chip kinds apart at a glance: **blinking means work
 * is happening on its own; steady means it is waiting for you.** So a running run
 * blinks and a terminal never does, however alive its shell is.
 */
export function runBlinks(status: RunStatus): boolean {
  return status.kind === 'running'
}

export function termTone(t: TermLike): Tone {
  if (t.status === 'live') return 'info'
  // An exit code the output pane used to throw away: both exit 0 and exit 1
  // rendered `idle`, so a shell that died on an error looked like one you closed.
  return t.exitCode === 0 || t.exitCode === null ? 'ok' : 'warn'
}

export function termStatusLabel(t: TermLike): string {
  if (t.status === 'live') return 'shell'
  return t.exitCode === 0 ? 'exited' : `exit ${t.exitCode ?? '?'}`
}
