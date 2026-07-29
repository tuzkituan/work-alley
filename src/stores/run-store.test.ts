import { beforeEach, describe, expect, it } from 'bun:test'
import { useRunStore } from './run-store'
import type { LogLine, RunSummary } from '@/domain/types'

function summary(runId: string, kind = 'devStart'): RunSummary {
  return {
    runId,
    kind,
    title: `${kind} run`,
    ref: { category: 'fe', name: 'web' },
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
