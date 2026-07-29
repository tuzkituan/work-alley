import { describe, expect, it } from 'bun:test'
import { failureHint, parseCloneLog, tally } from './clone-log'
import type { LogLine } from '@/domain/types'

/** The shape the backend streams; only `text` and `seq` matter here. */
function log(...texts: string[]): LogLine[] {
  return texts.map((text, i) => ({
    seq: i,
    stream: 'stdout' as const,
    severity: 'out' as const,
    text,
    unix: 0,
    repo: null,
  }))
}

describe('parseCloneLog', () => {
  it('attributes git output to the repo that was being cloned', () => {
    const results = parseCloneLog(
      log(
        '[..]   web',
        'Cloning into /w/web...',
        '[OK]   web',
        '[..]   api',
        'Cloning into /w/api...',
        "ERROR: Repository not found.",
        'fatal: Could not read from remote repository.',
        '[FAIL] api',
        '[OK]   clone finished'
      )
    )

    expect(results.map((r) => [r.name, r.state])).toEqual([
      ['web', 'ok'],
      ['api', 'failed'],
    ])
    // The failing repo carries git's own words, not a generic message.
    expect(results[1]!.detail).toContain('ERROR: Repository not found.')
    expect(results[1]!.hint).toMatch(/does not exist/)
  })

  it("does not mistake the script's closing line for a repository", () => {
    const results = parseCloneLog(log('[..]   web', '[OK]   web', '[OK]   clone finished'))
    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe('web')
  })

  it('keeps the reason a repo was skipped', () => {
    const results = parseCloneLog(log('[SKIP] web — folder already exists'))
    expect(results[0]!.state).toBe('skipped')
    expect(results[0]!.detail).toEqual(['folder already exists'])
  })

  it('reports a repo still in flight as cloning, not as failed', () => {
    // Mid-run the UI must not imply anything about the outcome.
    const results = parseCloneLog(log('[..]   web', 'Receiving objects:  42%'))
    expect(results[0]!.state).toBe('cloning')
    expect(tally(results).cloning).toBe(1)
  })

  it('survives a log with no markers at all', () => {
    expect(parseCloneLog(log('some unrelated output'))).toEqual([])
    expect(parseCloneLog([])).toEqual([])
  })
})

describe('failureHint', () => {
  it('recognises the failures that have a specific fix', () => {
    expect(failureHint(['git@github.com: Permission denied (publickey).'])).toMatch(/SSH key/)
    expect(failureHint(['ssh: Could not resolve hostname githb.com'])).toMatch(/resolved/)
    expect(failureHint(['fatal: Host key verification failed.'])).toMatch(/accept it/)
    expect(failureHint(['fatal: no space left on device'])).toMatch(/disk is full/)
  })

  it('returns null rather than guessing', () => {
    // A wrong hint sends someone to fix the wrong thing; raw output is better.
    expect(failureHint(['fatal: something nobody has seen before'])).toBeNull()
    expect(failureHint([])).toBeNull()
  })
})
