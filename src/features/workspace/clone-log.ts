import type { LogLine } from '@/domain/types'
import { parseBulkLog, type BulkResult } from '@/features/output/bulk-log'

export type CloneState = 'cloning' | 'ok' | 'skipped' | 'failed'

export interface CloneResult {
  name: string
  state: CloneState
  /** Everything git said while this repo was being cloned. */
  detail: string[]
  /** A short, actionable reading of `detail`, when one can be recognised. */
  hint: string | null
}

/**
 * Turns a flat clone log into a per-repo result list.
 *
 * The log is the only place git's failure text exists, and it is interleaved with
 * progress noise. Attributing each line to the repo that was being cloned at the
 * time is what makes "3 failed" answer *which three, and why* rather than sending
 * the user to scroll a thousand lines of progress output.
 *
 * Now a thin adapter over `parseBulkLog`, which is the same machine generalised to
 * pull, fetch and checkout. Clone keeps its own vocabulary — `cloning` rather than
 * `active`, and `failureHint`, which is specific to git transport errors — so the
 * wizard is unaffected.
 */
export function parseCloneLog(lines: LogLine[]): CloneResult[] {
  // No `expected`: the clone script prints bare folder names and there are no
  // `targets` to check them against, so the parser falls back to its own key
  // extraction. No `implicitOk` either — the clone script does emit a per-repo [OK].
  return parseBulkLog(lines).map(toCloneResult)
}

function toCloneResult(r: BulkResult): CloneResult {
  const state: CloneState =
    r.state === 'ok'
      ? 'ok'
      : r.state === 'failed'
        ? 'failed'
        : r.state === 'skipped'
          ? 'skipped'
          // `queued` cannot occur without `expected`, and `unknown` only when a run
          // ends mid-repo — which for the wizard reads as still going.
          : 'cloning'
  return {
    name: r.name,
    state,
    detail: r.detail,
    hint: state === 'failed' ? failureHint(r.detail) : null,
  }
}

/**
 * Recognises the handful of clone failures that have a specific fix.
 *
 * Deliberately narrow: a wrong guess is worse than none, because it sends someone
 * to fix the wrong thing. Anything unrecognised falls through to `null` and the
 * raw output is shown instead.
 */
export function failureHint(detail: string[]): string | null {
  const text = detail.join('\n').toLowerCase()

  if (text.includes('permission denied (publickey)')) {
    return 'The host rejected your SSH key. Check that an agent is running and the key is added (ssh-add -l).'
  }
  if (text.includes('could not read from remote repository') && text.includes('correct access rights')) {
    return 'Authentication failed, or you do not have access to this repository.'
  }
  if (text.includes('repository not found') || text.includes('404')) {
    return 'The repository does not exist at that URL, or your account cannot see it.'
  }
  if (text.includes('could not resolve host') || text.includes('temporary failure in name resolution')) {
    return 'The host could not be resolved — check the URL spelling and your network.'
  }
  if (text.includes('connection timed out') || text.includes('connection refused')) {
    return 'Could not reach the host. A VPN or proxy may be required.'
  }
  if (text.includes('host key verification failed')) {
    return "The host's SSH key is not trusted yet. Connect once from a terminal to accept it."
  }
  if (text.includes('terminal prompts disabled') || text.includes('authentication failed')) {
    return 'HTTPS credentials were needed but none were available. Use an SSH URL or configure a credential helper.'
  }
  if (text.includes('permission denied') && text.includes('mkdir')) {
    return 'The workspace folder is not writable.'
  }
  if (text.includes('no space left on device')) {
    return 'The disk is full.'
  }
  return null
}

export function tally(results: CloneResult[]) {
  return {
    ok: results.filter((r) => r.state === 'ok').length,
    failed: results.filter((r) => r.state === 'failed'),
    skipped: results.filter((r) => r.state === 'skipped').length,
    cloning: results.filter((r) => r.state === 'cloning').length,
  }
}
