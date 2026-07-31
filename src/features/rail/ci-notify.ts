import type { WorkflowRun, WorkflowRunState } from '@/domain/types'

/** The states a run can still leave. Mirrors `isActive` in CiSection. */
const ACTIVE: WorkflowRunState[] = ['queued', 'running']

export function isActiveRun(r: WorkflowRun): boolean {
  return ACTIVE.includes(r.state)
}

/**
 * Which runs have just finished, given what they were doing last time.
 *
 * The whole rule is "was active, is not any more". Without the first half, the
 * first poll after opening an Actions tab would announce every run in the repo's
 * history — fifty toasts for things that finished last Tuesday — and that is the
 * failure mode worth a pure function and a test rather than an inline comparison.
 *
 * `seen` maps run id to the state it was last observed in. Runs missing from it
 * have never been seen active and are ignored, which also covers the case of a run
 * that starts and finishes between two polls: nothing announces it, because nothing
 * ever saw it running. Ten seconds of CI is not news.
 */
export function justFinished(
  seen: ReadonlyMap<number, WorkflowRunState>,
  runs: readonly WorkflowRun[]
): WorkflowRun[] {
  return runs.filter((r) => {
    const before = seen.get(r.id)
    return before !== undefined && ACTIVE.includes(before) && !isActiveRun(r)
  })
}

/** The states to carry into the next comparison. */
export function nextSeen(
  seen: ReadonlyMap<number, WorkflowRunState>,
  runs: readonly WorkflowRun[]
): Map<number, WorkflowRunState> {
  const out = new Map(seen)
  for (const r of runs) out.set(r.id, r.state)
  return out
}

/** What the toast says. Kept here so the wording is testable and in one place. */
export function finishedMessage(run: WorkflowRun, repoName: string) {
  const what = run.workflowName || run.title || 'Workflow'
  switch (run.state) {
    case 'success':
      return { tone: 'success' as const, text: `${what} passed`, detail: repoName }
    case 'cancelled':
      return { tone: 'info' as const, text: `${what} cancelled`, detail: repoName }
    case 'skipped':
      return { tone: 'info' as const, text: `${what} skipped`, detail: repoName }
    // `actionRequired` is not a failure — it is a deployment waiting on a human,
    // and calling it failed would send someone looking for a broken build.
    case 'actionRequired':
      return {
        tone: 'warning' as const,
        text: `${what} needs approval`,
        detail: repoName,
      }
    default:
      return { tone: 'error' as const, text: `${what} failed`, detail: repoName }
  }
}
