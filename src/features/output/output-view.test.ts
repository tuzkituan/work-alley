import { describe, expect, it } from 'bun:test'
import { buildTabs, isShown, runInScope } from './output-view'
import type { Run } from '@/stores/run-store'
import type { TermTab } from '@/stores/terminal-store'
import type { RepoRef, RunStatus } from '@/domain/types'

const ref = (name: string): RepoRef => ({ category: 'fe', name })

function run(
  runId: string,
  opts: {
    ref?: RepoRef | null
    targets?: RepoRef[]
    status?: RunStatus
    title?: string
    started?: number
  } = {}
): Run {
  return {
    runId,
    summary: {
      runId,
      kind: 'pull',
      title: opts.title ?? `run ${runId}`,
      ref: opts.ref ?? null,
      targets: opts.targets ?? [],
      argv: ['git', 'pull'],
      cwd: '/w',
      startedUnix: opts.started ?? Math.floor(Date.now() / 1000),
      endedUnix: null,
      status: opts.status ?? { kind: 'running' },
      lineCount: 0,
      truncated: false,
    },
    lines: [],
    lastSeq: -1,
    droppedHead: 0,
    follow: true,
    scrollTop: 0,
    scopeKeys: [],
    cleared: false,
    cancelling: false,
  }
}

function term(termId: string, r: RepoRef | null, kind = 'shell'): TermTab {
  return {
    termId,
    kind,
    title: 'zsh',
    cwd: '/w',
    ref: r,
    argv: ['zsh'],
    pid: 42,
    startedUnix: Math.floor(Date.now() / 1000),
    status: 'live',
    exitCode: null,
    restored: false,
  }
}

/** Assembles the store-shaped inputs `buildTabs` expects. */
function input(runList: Run[], termList: TermTab[], over: Partial<Parameters<typeof buildTabs>[0]> = {}) {
  return {
    runs: new Map(runList.map((r) => [r.runId, r])),
    runOrder: runList.map((r) => r.runId),
    tabs: new Map(termList.map((t) => [t.termId, t])),
    termOrder: termList.map((t) => t.termId),
    scope: null as string | null,
    activeRunId: null as string | null,
    activeTermId: null as string | null,
    ...over,
  }
}

describe('runInScope', () => {
  it('puts a bulk run in every repo it touched', () => {
    // A "Pull all" used to be invisible from the pane of every repo it was pulling.
    const r = run('r1', { ref: null, targets: [ref('a'), ref('b')] })
    expect(runInScope(r, 'fe/a')).toBe(true)
    expect(runInScope(r, 'fe/b')).toBe(true)
    expect(runInScope(r, 'fe/c')).toBe(false)
    // And still in the workspace scope, where it was launched.
    expect(runInScope(r, null)).toBe(true)
  })

  it('keeps a single-repo run out of the workspace scope', () => {
    expect(runInScope(run('r1', { ref: ref('a'), targets: [ref('a')] }), null)).toBe(false)
  })
})

describe('buildTabs', () => {
  it('lists a lone run — the run strip used to need two before it appeared', () => {
    const { runTabs, shown } = buildTabs(input([run('r1')], []))
    expect(runTabs).toHaveLength(1)
    expect(shown).toEqual({ kind: 'run', id: 'r1' })
  })

  it('labels a run with its title and a bulk run with its repo count', () => {
    const { runTabs } = buildTabs(
      input([run('r1', { title: 'Pull 40 repos', targets: [ref('a'), ref('b')] })], [])
    )
    expect(runTabs[0]!.label).toBe('Pull 40 repos')
    expect(runTabs[0]!.detail).toBe('×2')
  })

  it('omits the count for a single-repo run', () => {
    const { runTabs } = buildTabs(input([run('r1', { targets: [ref('a')] })], []))
    expect(runTabs[0]!.detail).toBeNull()
  })

  it('orders runs newest first and terminals in open order', () => {
    const { runTabs, termTabs } = buildTabs(
      input([run('r1'), run('r2')], [term('t1', null), term('t2', null)])
    )
    expect(runTabs.map((t) => t.view.id)).toEqual(['r2', 'r1'])
    expect(termTabs.map((t) => t.view.id)).toEqual(['t1', 't2'])
  })

  it('never blinks a terminal, always blinks a running run', () => {
    const { runTabs, termTabs } = buildTabs(input([run('r1')], [term('t1', null)]))
    expect(runTabs[0]!.blink).toBe(true)
    expect(termTabs[0]!.blink).toBe(false)
  })

  it('refuses to close a live run but allows a finished one', () => {
    const { runTabs } = buildTabs(
      input([run('r1'), run('r2', { status: { kind: 'exited', code: 0 } })], [])
    )
    const byId = new Map(runTabs.map((t) => [t.view.id, t]))
    expect(byId.get('r1')!.closable).toBe(false)
    expect(byId.get('r2')!.closable).toBe(true)
  })

  it('names a script terminal but not a plain shell', () => {
    const { termTabs } = buildTabs(
      input([], [term('t1', null), term('t2', null, 'package')])
    )
    expect(termTabs[0]!.detail).toBeNull()
    expect(termTabs[1]!.detail).toBe('package')
  })

  describe('shown resolution', () => {
    it('prefers the active terminal when it is in scope', () => {
      const { shown } = buildTabs(
        input([run('r1')], [term('t1', null)], { activeTermId: 't1', activeRunId: 'r1' })
      )
      expect(shown).toEqual({ kind: 'term', id: 't1' })
    })

    it('falls through to a run when the active terminal is in another scope', () => {
      const { shown } = buildTabs(
        input([run('r1')], [term('t1', ref('a'))], { activeTermId: 't1', activeRunId: 'r1' })
      )
      expect(shown).toEqual({ kind: 'run', id: 'r1' })
    })

    it('falls back to the newest run when the active one is out of scope', () => {
      const { shown } = buildTabs(input([run('r1'), run('r2')], [], { activeRunId: 'gone' }))
      expect(shown).toEqual({ kind: 'run', id: 'r2' })
    })

    it('falls back to a terminal when the scope has no runs', () => {
      const { shown } = buildTabs(input([], [term('t1', null), term('t2', null)]))
      expect(shown).toEqual({ kind: 'term', id: 't2' })
    })

    it('is null for an empty scope, so the caller shows the empty state', () => {
      expect(buildTabs(input([], [])).shown).toBeNull()
    })

    it('always marks exactly one listed tab as shown', () => {
      // The regression this replaces: the body rendered a run that no chip pointed
      // at, so nothing looked selected.
      const cases = [
        input([run('r1'), run('r2')], [term('t1', null)]),
        input([run('r1')], [term('t1', null)], { activeTermId: 't1' }),
        input([run('r1')], [term('t1', null)], { activeRunId: 'nope' }),
        input([], [term('t1', null)]),
      ]
      for (const c of cases) {
        const { runTabs, termTabs, shown } = buildTabs(c)
        const marked = [...runTabs, ...termTabs].filter((t) => isShown(t, shown))
        expect(marked).toHaveLength(1)
      }
    })
  })
})
