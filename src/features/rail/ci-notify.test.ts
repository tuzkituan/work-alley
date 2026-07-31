import { describe, expect, it } from 'bun:test'
import { finishedMessage, justFinished, nextSeen } from './ci-notify'
import type { WorkflowRun, WorkflowRunState } from '@/domain/types'

function run(id: number, state: WorkflowRunState, name = 'CI'): WorkflowRun {
  return {
    id,
    number: id,
    attempt: 1,
    title: 'a commit',
    workflowName: name,
    workflowId: 1,
    event: 'push',
    branch: 'main',
    headSha: 'abc1234',
    status: 'completed',
    conclusion: state,
    state,
    url: 'https://github.com/x/y/actions/runs/1',
    createdUnix: 0,
    startedUnix: 0,
    updatedUnix: 0,
    durationSecs: 60,
    updatedRelative: '1m ago',
  }
}

describe('justFinished', () => {
  it('announces a run that was active and is not any more', () => {
    const seen = new Map<number, WorkflowRunState>([[1, 'running']])
    expect(justFinished(seen, [run(1, 'success')]).map((r) => r.id)).toEqual([1])
  })

  it('says nothing about history', () => {
    // The case that makes this a function with a test: the first poll after
    // opening an Actions tab returns fifty finished runs, and every one of them
    // would otherwise be announced as news.
    expect(justFinished(new Map(), [run(1, 'success'), run(2, 'failure')])).toEqual([])
  })

  it('says nothing while a run is still going', () => {
    const seen = new Map<number, WorkflowRunState>([[1, 'queued']])
    expect(justFinished(seen, [run(1, 'running')])).toEqual([])
  })

  it('announces a finish once, not on every poll after it', () => {
    let seen = new Map<number, WorkflowRunState>([[1, 'running']])
    const runs = [run(1, 'failure')]
    expect(justFinished(seen, runs)).toHaveLength(1)
    seen = nextSeen(seen, runs)
    expect(justFinished(seen, runs)).toHaveLength(0)
  })

  it('ignores a run that started and finished between two polls', () => {
    // Nothing ever saw it running, so nothing announces it. Ten seconds of CI is
    // not news, and the alternative is announcing runs triggered by other people.
    const seen = nextSeen(new Map(), [run(1, 'running')])
    expect(justFinished(seen, [run(1, 'success'), run(2, 'success')]).map((r) => r.id)).toEqual([1])
  })

  it('follows a re-run back into flight and out again', () => {
    let seen = nextSeen(new Map(), [run(7, 'running')])
    seen = nextSeen(seen, [run(7, 'success')])
    // Re-run: the same id goes active again.
    seen = nextSeen(seen, [run(7, 'queued')])
    expect(justFinished(seen, [run(7, 'failure')]).map((r) => r.id)).toEqual([7])
  })
})

describe('finishedMessage', () => {
  it('names the workflow and the repo', () => {
    const m = finishedMessage(run(1, 'success', 'Build and test'), 'web')
    expect(m.text).toBe('Build and test passed')
    expect(m.detail).toBe('web')
    expect(m.tone).toBe('success')
  })

  it('treats a run waiting on approval as a prompt, not a failure', () => {
    // `actionRequired` is a deployment waiting on a human. Calling it failed sends
    // someone looking for a broken build.
    const m = finishedMessage(run(1, 'actionRequired', 'Deploy'), 'api')
    expect(m.tone).toBe('warning')
    expect(m.text).toContain('needs approval')
  })

  it('falls back to the commit subject when a ruleset run has no workflow name', () => {
    const m = finishedMessage({ ...run(1, 'failure'), workflowName: '' }, 'api')
    expect(m.text).toBe('a commit failed')
    expect(m.tone).toBe('error')
  })

  it('reads cancelled and skipped as neither good nor bad', () => {
    expect(finishedMessage(run(1, 'cancelled'), 'x').tone).toBe('info')
    expect(finishedMessage(run(1, 'skipped'), 'x').tone).toBe('info')
  })
})
