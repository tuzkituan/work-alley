import { describe, expect, it } from 'bun:test'
import { runBlinks, runStatusLabel, runTone, termStatusLabel, termTone } from './run-status'
import type { RunStatus } from './types'

/** Every variant of the union, so a new one cannot be added without a decision. */
const ALL: RunStatus[] = [
  { kind: 'running' },
  { kind: 'exited', code: 0 },
  { kind: 'exited', code: 1 },
  { kind: 'signaled', signal: 15 },
  { kind: 'cancelled' },
  { kind: 'failed', message: 'boom' },
]

describe('runTone', () => {
  it('never returns idle for anything that happened', () => {
    // idle must mean "nothing here". cancelled and signaled used to land on it,
    // which made a cancelled run look identical to a run that never started.
    for (const s of ALL) {
      expect(runTone(s)).not.toBe('idle')
    }
  })

  it('treats a non-zero exit as a warning, not an error', () => {
    // A drift check exits 1 to report drift; that is information, not a crash.
    expect(runTone({ kind: 'exited', code: 0 })).toBe('ok')
    expect(runTone({ kind: 'exited', code: 1 })).toBe('warn')
    expect(runTone({ kind: 'failed', message: 'x' })).toBe('err')
  })

  it('distinguishes cancelled and signaled from success', () => {
    expect(runTone({ kind: 'cancelled' })).toBe('warn')
    expect(runTone({ kind: 'signaled', signal: 9 })).toBe('warn')
  })
})

describe('runStatusLabel', () => {
  it('gives every variant a distinct label', () => {
    const labels = ALL.map(runStatusLabel)
    expect(new Set(labels).size).toBe(ALL.length)
  })

  it('includes the failure message, which used to be dropped', () => {
    expect(runStatusLabel({ kind: 'failed', message: 'no such file' })).toContain('no such file')
  })
})

describe('runBlinks', () => {
  it('blinks only while running', () => {
    for (const s of ALL) {
      expect(runBlinks(s)).toBe(s.kind === 'running')
    }
  })
})

describe('termTone / termStatusLabel', () => {
  it('separates a clean exit from a failed one', () => {
    // Both were `idle` before, so a shell that died on an error looked closed.
    expect(termTone({ status: 'exited', exitCode: 0 })).toBe('ok')
    expect(termTone({ status: 'exited', exitCode: 1 })).toBe('warn')
  })

  it('reads a live shell as info', () => {
    expect(termTone({ status: 'live', exitCode: null })).toBe('info')
    expect(termStatusLabel({ status: 'live', exitCode: null })).toBe('shell')
  })

  it('does not claim an exit code it was never given', () => {
    // `open` initialises exitCode to null even for a tab that arrives dead.
    expect(termStatusLabel({ status: 'exited', exitCode: null })).toBe('exit ?')
  })
})
