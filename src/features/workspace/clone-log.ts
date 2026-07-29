import type { LogLine } from '@/domain/types'

export type CloneState = 'cloning' | 'ok' | 'skipped' | 'failed'

export interface CloneResult {
  name: string
  state: CloneState
  /** Everything git said while this repo was being cloned. */
  detail: string[]
  /** A short, actionable reading of `detail`, when one can be recognised. */
  hint: string | null
}

/** Markers the generated clone script emits, one per repo. */
const START = '[..]   '
const OK = '[OK]   '
const FAIL = '[FAIL] '
const SKIP = '[SKIP] '

/**
 * Turns a flat clone log into a per-repo result list.
 *
 * The log is the only place git's failure text exists, and it is interleaved with
 * progress noise. Attributing each line to the repo that was being cloned at the
 * time is what makes "3 failed" answer *which three, and why* rather than sending
 * the user to scroll a thousand lines of progress output.
 */
export function parseCloneLog(lines: LogLine[]): CloneResult[] {
  const results: CloneResult[] = []
  let current: CloneResult | null = null

  const finish = (name: string, state: CloneState) => {
    // Normally the repo being closed is the open one; be tolerant if not.
    const target = current?.name === name ? current : results.find((r) => r.name === name)
    if (target) target.state = state
    else results.push({ name, state, detail: [], hint: null })
    if (current?.name === name) current = null
  }

  for (const l of lines) {
    const t = l.text
    if (t.startsWith(START)) {
      current = { name: t.slice(START.length).trim(), state: 'cloning', detail: [], hint: null }
      results.push(current)
      continue
    }
    if (t.startsWith(OK)) {
      const name = t.slice(OK.length).trim()
      // The script's own closing line is not a repo.
      if (name !== 'clone finished') finish(name, 'ok')
      continue
    }
    if (t.startsWith(FAIL)) {
      finish(t.slice(FAIL.length).trim(), 'failed')
      continue
    }
    if (t.startsWith(SKIP)) {
      // "name — folder already exists": keep the reason as the detail.
      const rest = t.slice(SKIP.length).trim()
      const parts = rest.split(' — ')
      const name = parts[0] ?? rest
      const why = parts.slice(1)
      results.push({
        name: name.trim(),
        state: 'skipped',
        detail: why.length ? [why.join(' — ')] : [],
        hint: null,
      })
      continue
    }
    // Ordinary output belongs to whichever repo is in flight.
    if (current && t.trim()) current.detail.push(t)
  }

  for (const r of results) {
    if (r.state === 'failed') r.hint = failureHint(r.detail)
  }
  return results
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
