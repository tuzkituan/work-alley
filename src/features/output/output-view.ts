import { runBlinks, runStatusLabel, runTone, termStatusLabel, termTone } from '@/domain/run-status'
import type { Tone } from '@/domain/severity'
import { repoId, type RepoId } from '@/domain/types'
import { runScope, type Run } from '@/stores/run-store'
import { termScope, type TermTab } from '@/stores/terminal-store'
import { relativeFromUnix } from '@/lib/time'

/**
 * Which of the two things the pane can show.
 *
 * There used to be two independent selection variables resolved one way by the chips
 * (`id === activeRunId`) and another by the body (`activeInScope ?? newest`), so the
 * highlighted chip and the visible log could disagree — and with `activeRunId` null
 * or out of scope, the body showed a run that no chip pointed at. One value, one
 * resolution function, read by both.
 */
export type OutputView = { kind: 'run'; id: string } | { kind: 'term'; id: string }

export interface OutputTab {
  view: OutputView
  /** The run's title or the terminal's title — never the bare `kind`. */
  label: string
  /** `×40` for a bulk run, or a terminal's kind when it is not a plain shell. */
  detail: string | null
  age: string
  tone: Tone
  /**
   * Whether the dot animates.
   *
   * The rule that tells the two chip kinds apart at a glance: blinking means work is
   * happening on its own, steady means it is waiting for you. Terminals never blink.
   */
  blink: boolean
  /** Whether it can be dismissed/closed from the chip. */
  closable: boolean
  title: string
}

/**
 * Whether a run belongs in a scope.
 *
 * A bulk run has `ref: null` and lists every repo it touched, so it belongs to each
 * of their scopes as well as to the workspace. Before this, a "Pull all" was
 * invisible from the pane of every repo it was pulling.
 */
export function runInScope(run: Run, scope: RepoId | null): boolean {
  if (runScope(run) === scope) return true
  if (scope === null) return false
  return (run.summary.targets ?? []).some((t) => repoId(t) === scope)
}

export function buildTabs(input: {
  runs: Map<string, Run>
  runOrder: string[]
  tabs: Map<string, TermTab>
  termOrder: string[]
  scope: RepoId | null
  activeRunId: string | null
  activeTermId: string | null
}): { runTabs: OutputTab[]; termTabs: OutputTab[]; shown: OutputView | null } {
  const { runs, runOrder, tabs, termOrder, scope, activeRunId, activeTermId } = input

  const scopedRuns = runOrder
    .map((id) => runs.get(id))
    .filter((r): r is Run => !!r && runInScope(r, scope))
  // Newest first: with several runs of the same command, the one you just started is
  // the one you want.
  const orderedRuns = [...scopedRuns].reverse()

  const scopedTerms = termOrder
    .map((id) => tabs.get(id))
    .filter((t): t is TermTab => !!t && termScope(t) === scope)

  const runTabs = orderedRuns.map(runTab)
  const termTabs = scopedTerms.map(termTab)

  // One resolution, in priority order. Both the chips and the body read the result,
  // which is what keeps them from disagreeing.
  const termInScope = activeTermId && scopedTerms.some((t) => t.termId === activeTermId)
  const runInScopeSel = activeRunId && scopedRuns.some((r) => r.runId === activeRunId)
  const shown: OutputView | null = termInScope
    ? { kind: 'term', id: activeTermId }
    : runInScopeSel
      ? { kind: 'run', id: activeRunId }
      : orderedRuns[0]
        ? { kind: 'run', id: orderedRuns[0].runId }
        : scopedTerms[scopedTerms.length - 1]
          ? { kind: 'term', id: scopedTerms[scopedTerms.length - 1]!.termId }
          : null

  return { runTabs, termTabs, shown }
}

export function isShown(tab: OutputTab, shown: OutputView | null): boolean {
  return !!shown && shown.kind === tab.view.kind && shown.id === tab.view.id
}

function runTab(run: Run): OutputTab {
  const { summary } = run
  const status = summary.status
  const targets = summary.targets?.length ?? 0
  const running = status.kind === 'running'

  return {
    view: { kind: 'run', id: run.runId },
    // The title, not `kind`: within one scope every run has the same kind, so a
    // column of identical "devStart" chips told you nothing.
    label: summary.title,
    // The repo count is the headline fact about a bulk run, so it sits on the chip
    // rather than in a tooltip.
    detail: targets > 1 ? `×${targets}` : null,
    age: relativeFromUnix(summary.startedUnix),
    tone: runTone(status),
    blink: runBlinks(status),
    // Dismissing a live run would orphan it: the process keeps going with nothing
    // listening to it.
    closable: !running,
    title: `${summary.title} — ${runStatusLabel(status)}\n${summary.argv.join(' ')}`,
  }
}

function termTab(tab: TermTab): OutputTab {
  return {
    view: { kind: 'term', id: tab.termId },
    label: tab.title,
    // A plain shell needs no label; a script or package install is worth naming,
    // and `kind` was stored and never shown.
    detail: tab.kind === 'shell' ? null : tab.kind,
    age: relativeFromUnix(tab.startedUnix),
    tone: termTone(tab),
    // Never. A shell waiting at a prompt is not doing work.
    blink: false,
    closable: true,
    title: `${tab.title} — interactive ${termStatusLabel(tab)}\npid ${tab.pid} · ${tab.cwd}`,
  }
}
