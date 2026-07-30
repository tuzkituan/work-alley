import { describe, expect, it } from 'bun:test'
import { bulkKind, isBulkKind, parseBulkLog, tallyBulk } from './bulk-log'
import type { LogLine } from '@/domain/types'

/** The log as the store holds it — only `text` matters to the parser. */
function log(...texts: string[]): LogLine[] {
  return texts.map((text, i) => ({
    seq: i,
    stream: 'stdout',
    severity: 'out',
    text,
    unix: 0,
    repo: null,
  }))
}

const stateOf = (rs: ReturnType<typeof parseBulkLog>, name: string) =>
  rs.find((r) => r.name === name)?.state

describe('parseBulkLog — pull, where success is implicit', () => {
  // bulk_pull_argv echoes `[..] key` and only `[FAIL] key`. There is no per-repo
  // [OK], so without implicitOk every pulled repo stays "active" forever.
  const expected = ['fe/web', 'fe/admin', 'fe/docs']
  const lines = log(
    '[..]   fe/web',
    'Already up to date.',
    '[..]   fe/admin',
    'Updating abc..def',
    '[..]   fe/docs',
    'fatal: could not read Username',
    '[FAIL] fe/docs',
    '[OK]   bulk pull finished'
  )

  it('resolves a repo the log moved past as succeeded', () => {
    const rs = parseBulkLog(lines, { expected, implicitOk: true, finished: true, ok: true })
    expect(stateOf(rs, 'fe/web')).toBe('ok')
    expect(stateOf(rs, 'fe/admin')).toBe('ok')
    expect(stateOf(rs, 'fe/docs')).toBe('failed')
  })

  it('keeps the failure output attached to the repo that failed', () => {
    const rs = parseBulkLog(lines, { expected, implicitOk: true, finished: true, ok: true })
    expect(rs.find((r) => r.name === 'fe/docs')!.detail.join('\n')).toContain('could not read')
    // ...and not to the one before it.
    expect(rs.find((r) => r.name === 'fe/web')!.detail.join('\n')).not.toContain('fatal')
  })

  it('does not treat the closing line as a repo', () => {
    const rs = parseBulkLog(lines, { expected, implicitOk: true, finished: true, ok: true })
    expect(rs.map((r) => r.name)).toEqual(expected)
  })

  it('reports an unresolved repo as unknown when the run was cancelled', () => {
    // The rule that matters most: a cancel mid-repo must never claim success.
    const cut = log('[..]   fe/web', 'Receiving objects:  40%')
    const rs = parseBulkLog(cut, { expected, implicitOk: true, finished: true, ok: false })
    expect(stateOf(rs, 'fe/web')).toBe('unknown')
  })

  it('leaves the in-flight repo active while the run is still going', () => {
    const rs = parseBulkLog(log('[..]   fe/web'), { expected, implicitOk: true })
    expect(stateOf(rs, 'fe/web')).toBe('active')
  })
})

describe('parseBulkLog — fetch, which emits no in-flight marker', () => {
  it('still resolves each repo from its result marker alone', () => {
    // bulk_fetch_argv emits only [OK]/[FAIL] and no finish line.
    const rs = parseBulkLog(log('[OK]   fe/web', '[FAIL] fe/admin'), {
      expected: ['fe/web', 'fe/admin', 'fe/docs'],
      finished: true,
      ok: true,
    })
    expect(stateOf(rs, 'fe/web')).toBe('ok')
    expect(stateOf(rs, 'fe/admin')).toBe('failed')
    // Never mentioned, so queued rather than missing.
    expect(stateOf(rs, 'fe/docs')).toBe('queued')
  })
})

describe('parseBulkLog — checkout, whose markers carry suffixes', () => {
  const expected = ['fe/web', 'fe/admin', 'fe/web-admin']

  it('strips a " -> branch" suffix without eating the name', () => {
    const rs = parseBulkLog(log('[OK]   fe/web -> main'), { expected, finished: true, ok: true })
    expect(stateOf(rs, 'fe/web')).toBe('ok')
  })

  it('keeps a skip reason as detail', () => {
    const rs = parseBulkLog(log('[SKIP] fe/admin — 3 local change(s)'), {
      expected,
      finished: true,
      ok: true,
    })
    const r = rs.find((x) => x.name === 'fe/admin')!
    expect(r.state).toBe('skipped')
    expect(r.detail.join(' ')).toContain('3 local change(s)')
  })

  it('prefers the longest matching key', () => {
    // Splitting on a delimiter would be wrong here, and so would a shortest match:
    // `fe/web` is a prefix of `fe/web-admin`.
    const rs = parseBulkLog(log('[OK]   fe/web-admin -> main'), {
      expected,
      finished: true,
      ok: true,
    })
    expect(stateOf(rs, 'fe/web-admin')).toBe('ok')
    expect(stateOf(rs, 'fe/web')).toBe('queued')
  })
})

describe('queued rows', () => {
  it('lists every expected repo from the first frame', () => {
    // So a 40-repo run shows 40 rows immediately instead of growing one at a time.
    const rs = parseBulkLog([], { expected: ['a', 'b', 'c'] })
    expect(rs.map((r) => r.state)).toEqual(['queued', 'queued', 'queued'])
  })
})

describe('tallyBulk', () => {
  it('totals every state so a progress bar can be determinate', () => {
    const rs = parseBulkLog(log('[OK]   a', '[FAIL] b', '[SKIP] c — why', '[..]   d'), {
      expected: ['a', 'b', 'c', 'd', 'e'],
    })
    const t = tallyBulk(rs)
    expect(t).toMatchObject({ ok: 1, skipped: 1, active: 1, queued: 1, total: 5 })
    expect(t.failed.map((r) => r.name)).toEqual(['b'])
  })
})

describe('bulkKind', () => {
  it('marks only pull as implicitly successful', () => {
    expect(bulkKind('pullMany')!.implicitOk).toBe(true)
    expect(bulkKind('fetchMany')!.implicitOk).toBe(false)
    expect(bulkKind('checkout')!.implicitOk).toBe(false)
  })

  it('does not claim per-repo markers for an ordinary run', () => {
    expect(isBulkKind('devStart')).toBe(false)
    expect(bulkKind('devStart')).toBeNull()
  })
})
