import { beforeEach, describe, expect, it } from 'bun:test'
import { shouldReplay, useRunStore, WORKSPACE_KEY } from './run-store'
import type { LogLine, RunSummary } from '@/domain/types'

function summary(runId: string, kind = 'devStart'): RunSummary {
  return {
    runId,
    kind,
    title: `${kind} run`,
    ref: { category: 'fe', name: 'web' },
    targets: [{ category: 'fe', name: 'web' }],
    argv: ['bun', 'run', 'dev'],
    cwd: '/w/fe/web',
    startedUnix: 1_700_000_000,
    endedUnix: null,
    status: { kind: 'running' },
    lineCount: 0,
    truncated: false,
  }
}

function line(seq: number, text: string): LogLine {
  return { seq, stream: 'stdout', severity: 'out', text, unix: 0, repo: null }
}

describe('run store', () => {
  beforeEach(() => {
    useRunStore.setState({ runs: new Map(), order: [], activeRunId: null, runningByScope: {} })
  })

  it('records a run once even if start is called twice', () => {
    // Regression: a duplicated event listener called this twice for one run, and
    // `order` grew each time — two chips in the output pane for one dev server,
    // with duplicate React keys.
    const s = useRunStore.getState()
    s.start(summary('r1'))
    s.start(summary('r1'))

    const after = useRunStore.getState()
    expect(after.order).toEqual(['r1'])
    expect(after.runs.size).toBe(1)
  })

  it('keeps distinct runs in start order', () => {
    const s = useRunStore.getState()
    s.start(summary('r1'))
    s.start(summary('r2'))
    expect(useRunStore.getState().order).toEqual(['r1', 'r2'])
  })

  it('drops log lines it has already seen', () => {
    // Replay after a remount overlaps with live events, so seq is the guard.
    const s = useRunStore.getState()
    s.start(summary('r1'))
    s.append('r1', [line(0, 'a'), line(1, 'b')])
    s.append('r1', [line(1, 'b'), line(2, 'c')])

    const run = useRunStore.getState().runs.get('r1')!
    expect(run.lines.map((l) => l.text)).toEqual(['a', 'b', 'c'])
    expect(run.lastSeq).toBe(2)
  })

  it('ignores output for a run it does not know', () => {
    const s = useRunStore.getState()
    s.append('gone', [line(0, 'x')])
    expect(useRunStore.getState().runs.size).toBe(0)
  })
})

describe('busy counting across repos', () => {
  beforeEach(() => {
    useRunStore.setState({ runs: new Map(), order: [], activeRunId: null, runningByScope: {} })
  })

  /** A bulk pull: no single `ref`, many `targets`. */
  function bulk(runId: string, names: string[]): RunSummary {
    return {
      ...summary(runId, 'pullMany'),
      ref: null,
      targets: names.map((name) => ({ category: 'fe', name })),
    }
  }

  it('counts a bulk run against every repo it touches', () => {
    // The bug: keyed on `ref` alone, a 40-repo pull counted once against the
    // workspace and left all 40 repo rows reporting nothing running.
    useRunStore.getState().start(bulk('r1', ['web', 'admin', 'docs']))

    const busy = useRunStore.getState().runningByScope
    expect(busy['fe/web']).toBe(1)
    expect(busy['fe/admin']).toBe(1)
    expect(busy['fe/docs']).toBe(1)
    expect(busy[WORKSPACE_KEY]).toBe(1)
  })

  it('releases every key it took when the run exits', () => {
    const s = useRunStore.getState()
    s.start(bulk('r1', ['web', 'admin']))
    useRunStore
      .getState()
      .exit('r1', { status: { kind: 'exited', code: 0 }, endedUnix: 1_700_000_100 })

    // Deleted, not zeroed, so the map stays the size of what is actually busy.
    expect(useRunStore.getState().runningByScope).toEqual({})
  })

  it('counts a single-repo run once, not twice', () => {
    // `ref` and `targets` name the same repo for a single-repo run; a naive union
    // would double it and the row would read "2 running" for one pull.
    useRunStore.getState().start(summary('r1'))
    expect(useRunStore.getState().runningByScope['fe/web']).toBe(1)
  })

  it('cannot be driven negative by a duplicate exit', () => {
    const s = useRunStore.getState()
    s.start(bulk('r1', ['web']))
    const e = { status: { kind: 'exited' as const, code: 0 }, endedUnix: 1 }
    useRunStore.getState().exit('r1', e)
    useRunStore.getState().exit('r1', e)
    expect(useRunStore.getState().runningByScope).toEqual({})
  })

  it('stores the line count the exit event reports', () => {
    // Previously dropped, so a finished run kept the count it had at start.
    useRunStore.getState().start(summary('r1'))
    useRunStore.getState().exit('r1', {
      status: { kind: 'exited', code: 0 },
      endedUnix: 2,
      lineCount: 412,
      truncated: true,
    })
    const run = useRunStore.getState().runs.get('r1')!
    expect(run.summary.lineCount).toBe(412)
    expect(run.summary.truncated).toBe(true)
  })
})

describe('cancelling', () => {
  beforeEach(() => {
    useRunStore.setState({ runs: new Map(), order: [], activeRunId: null, runningByScope: {} })
  })

  it('marks a live run as cancelling', () => {
    const s = useRunStore.getState()
    s.start(summary('r1'))
    useRunStore.getState().setCancelling('r1', true)
    expect(useRunStore.getState().runs.get('r1')!.cancelling).toBe(true)
    // Still running: cancelling is a request, and the process has not gone yet.
    expect(useRunStore.getState().runs.get('r1')!.summary.status.kind).toBe('running')
  })

  it('clears the flag when the run exits', () => {
    const s = useRunStore.getState()
    s.start(summary('r1'))
    useRunStore.getState().setCancelling('r1', true)
    useRunStore.getState().exit('r1', { status: { kind: 'cancelled' }, endedUnix: 2 })
    expect(useRunStore.getState().runs.get('r1')!.cancelling).toBe(false)
  })

  it('will not mark a finished run as cancelling', () => {
    // A click that lands just after the exit event would otherwise leave the footer
    // reading "cancelling…" next to the run's exit code, forever.
    const s = useRunStore.getState()
    s.start(summary('r1'))
    useRunStore.getState().exit('r1', { status: { kind: 'exited', code: 0 }, endedUnix: 2 })
    useRunStore.getState().setCancelling('r1', true)
    expect(useRunStore.getState().runs.get('r1')!.cancelling).toBe(false)
  })

  it('ignores a cancel for a run it does not know', () => {
    useRunStore.getState().setCancelling('gone', true)
    expect(useRunStore.getState().runs.size).toBe(0)
  })
})

describe('clear', () => {
  beforeEach(() => {
    useRunStore.setState({ runs: new Map(), order: [], activeRunId: null, runningByScope: {} })
  })

  it('stays cleared, and still accepts new live lines', () => {
    // The bug: `clear` reset `lines` but the view refilled it from the backend on
    // the next remount, so Clear appeared to do nothing.
    const s = useRunStore.getState()
    s.start(summary('r1'))
    s.append('r1', [line(1, 'old'), line(2, 'older')])
    useRunStore.getState().clear('r1')

    let run = useRunStore.getState().runs.get('r1')!
    expect(run.lines).toEqual([])
    expect(shouldReplay(run)).toBe(false)

    // A replay of what was cleared is refused...
    useRunStore.getState().append('r1', [line(1, 'old'), line(2, 'older')])
    expect(useRunStore.getState().runs.get('r1')!.lines).toEqual([])

    // ...but the run is still live, so new output arrives normally.
    useRunStore.getState().append('r1', [line(3, 'new')])
    run = useRunStore.getState().runs.get('r1')!
    expect(run.lines.map((l) => l.text)).toEqual(['new'])
  })

  it('asks for a replay only when a remount left it empty', () => {
    const s = useRunStore.getState()
    s.start(summary('r1'))
    expect(shouldReplay(useRunStore.getState().runs.get('r1')!)).toBe(true)
  })
})
