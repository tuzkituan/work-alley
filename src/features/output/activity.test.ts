import { describe, expect, it } from 'bun:test'
import { activityLabel, computeActivity, scopesToOffer } from './activity'
import type { Run } from '@/stores/run-store'
import type { TermTab } from '@/stores/terminal-store'
import type { RepoRef, RunStatus } from '@/domain/types'

const ref = (name: string, category = 'fe'): RepoRef => ({ category, name })

function run(
  runId: string,
  opts: { ref?: RepoRef | null; targets?: RepoRef[]; status?: RunStatus } = {}
): Run {
  return {
    runId,
    summary: {
      runId,
      kind: 'pullMany',
      title: 'Pull',
      ref: opts.ref ?? null,
      targets: opts.targets ?? [],
      argv: ['git', 'pull'],
      cwd: '/w',
      startedUnix: 0,
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

function term(termId: string, r: RepoRef | null, status: 'live' | 'exited' = 'live'): TermTab {
  return {
    termId,
    kind: 'shell',
    title: 'zsh',
    cwd: '/w',
    ref: r,
    argv: ['zsh'],
    pid: 1,
    startedUnix: 0,
    status,
    exitCode: status === 'live' ? null : 0,
    restored: false,
  }
}

describe('computeActivity', () => {
  it('reports the repo count from targets, not the run count', () => {
    // The whole point: one bulk run over 40 repos reads "1 running · 40 repos".
    const a = computeActivity([run('r1', { targets: [ref('a'), ref('b'), ref('c')] })], [])
    expect(a.runs).toBe(1)
    expect(a.repos).toBe(3)
  })

  it('counts a repo once when two runs overlap on it', () => {
    const a = computeActivity(
      [
        run('r1', { targets: [ref('a'), ref('b')] }),
        run('r2', { ref: ref('a'), targets: [ref('a')] }),
      ],
      []
    )
    expect(a.runs).toBe(2)
    expect(a.repos).toBe(2)
  })

  it('ignores finished runs and dead terminals', () => {
    const a = computeActivity(
      [run('r1', { targets: [ref('a')], status: { kind: 'exited', code: 0 } })],
      [term('t1', ref('a'), 'exited')]
    )
    expect(a).toMatchObject({ runs: 0, repos: 0, terms: 0 })
  })

  it('scopes to one repo, including a bulk run that touches it', () => {
    const runs = [
      run('r1', { targets: [ref('a'), ref('b')] }),
      run('r2', { ref: ref('z'), targets: [ref('z')] }),
    ]
    expect(computeActivity(runs, [], 'fe/a').runs).toBe(1)
    // The bulk run is not in fe/z's scope, but the single-repo run is.
    expect(computeActivity(runs, [], 'fe/z').runs).toBe(1)
    expect(computeActivity(runs, [], 'fe/nope').runs).toBe(0)
  })

  it('treats null as the workspace scope, not as "everything"', () => {
    // `undefined` means unfiltered; `null` is a real scope with its own runs.
    const runs = [run('r1', { ref: null, targets: [] }), run('r2', { ref: ref('a') })]
    expect(computeActivity(runs, []).runs).toBe(2)
    expect(computeActivity(runs, [], null).runs).toBe(1)
  })

  it('lists the scopes that have activity', () => {
    const a = computeActivity([run('r1', { ref: ref('a'), targets: [ref('a')] })], [term('t1', null)])
    expect(a.scopes.sort()).toEqual(['fe/a', null].sort())
  })
})

describe('activityLabel', () => {
  it('omits a repo count that adds nothing', () => {
    // "1 running · 1 repo" is noise for an ordinary single-repo run.
    expect(activityLabel({ runs: 1, repos: 1, terms: 0, scopes: [] })).toBe('1 running')
  })

  it('reads as one sentence when everything is busy', () => {
    expect(activityLabel({ runs: 2, repos: 41, terms: 1, scopes: [] })).toBe(
      '2 running · 41 repos · 1 shell'
    )
  })

  it('is null when nothing is happening, so the caller can say "idle"', () => {
    expect(activityLabel({ runs: 0, repos: 0, terms: 0, scopes: [] })).toBeNull()
  })
})

describe('scopesToOffer', () => {
  const empty = { runs: 0, repos: 0, terms: 0, scopes: [] as (string | null)[] }

  it('offers only the workspace when nothing is happening', () => {
    // A repo with no runs and no shells has an empty pane, so listing every repo in
    // the workspace made the menu long and most of it a dead end.
    expect(scopesToOffer(empty, null)).toEqual([null])
  })

  it('always includes the current scope, even when it is quiet', () => {
    // Otherwise the menu could not show what the pane is actually scoped to.
    expect(scopesToOffer(empty, 'fe/web')).toEqual([null, 'fe/web'])
  })

  it('offers every scope with activity', () => {
    const a = { ...empty, scopes: ['fe/web', 'be/api'] }
    expect(scopesToOffer(a, null).sort()).toEqual([null, 'be/api', 'fe/web'].sort())
  })

  it('does not list the current scope twice when it is also busy', () => {
    const a = { ...empty, scopes: ['fe/web'] }
    expect(scopesToOffer(a, 'fe/web')).toEqual([null, 'fe/web'])
  })

  it('keeps an opened scope after its activity is gone', () => {
    // The regression this exists for: the tab closed itself when the last run in it
    // was dismissed, and if it was the one being read the pane fell back to the
    // workspace. A tab now goes only when it is closed by hand.
    expect(scopesToOffer(empty, null, ['fe/web'])).toEqual([null, 'fe/web'])
  })

  it('does not duplicate a scope that is both opened and busy', () => {
    const a = { ...empty, scopes: ['fe/web'] }
    expect(scopesToOffer(a, 'fe/web', ['fe/web'])).toEqual([null, 'fe/web'])
  })
})
