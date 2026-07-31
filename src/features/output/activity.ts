import { repoId, type RepoId } from '@/domain/types'
import { runScope, type Run } from '@/stores/run-store'
import { termScope, type TermTab } from '@/stores/terminal-store'

/**
 * What is happening right now, as one small object.
 *
 * The pane could previously only say "running devStart…" — the status of the single
 * run it happened to be showing. With three runs going in two repos it still said
 * that, in the singular, and never mentioned the other two. This is the answer to
 * "what is running" and "how many repos".
 */
export interface Activity {
  /** Runs currently going. */
  runs: number
  /**
   * Distinct repos those runs are touching, from `targets`.
   *
   * The field that makes a bulk pull legible: `ref` is null on one, so without
   * `targets` there was no way to say "41 repos" rather than "1 run".
   */
  repos: number
  /** Live terminal sessions. */
  terms: number
  /** Scopes with any activity, for the scope menu. `null` is the workspace. */
  scopes: (RepoId | null)[]
}

export function computeActivity(
  runs: Iterable<Run>,
  tabs: Iterable<TermTab>,
  scope?: RepoId | null
): Activity {
  // `undefined` means "everything"; `null` means "the workspace scope", which is a
  // real scope and not the absence of one.
  const all = scope === undefined
  const repos = new Set<RepoId>()
  const scopes = new Set<RepoId | null>()
  let running = 0
  let terms = 0

  for (const r of runs) {
    if (r.summary.status.kind !== 'running') continue
    const own = runScope(r)
    // A bulk run belongs to every repo it touches, so it counts in each of their
    // scopes — the same rule the pane's own filter uses.
    const touched = r.summary.targets?.map(repoId) ?? []
    const inScope = all || own === scope || (scope !== null && touched.includes(scope))
    if (!inScope) continue

    running++
    for (const t of touched) repos.add(t)
    if (own) repos.add(own)
    scopes.add(own)
  }

  for (const t of tabs) {
    if (t.status !== 'live') continue
    const own = termScope(t)
    if (!all && own !== scope) continue
    terms++
    scopes.add(own)
  }

  return { runs: running, repos: repos.size, terms, scopes: [...scopes] }
}

/**
 * The scopes worth offering in the pane's tab strip.
 *
 * The workspace, whatever is selected, scopes with something happening, and scopes
 * that have been opened and not closed. Never every repo in the workspace: a repo
 * with no runs and no shells has an empty pane, so listing all of them made the
 * strip long and most of it a dead end.
 *
 * `opened` is what stops a tab closing itself. Activity alone used to decide, so
 * dismissing the last run in a repo removed the tab out from under you — and if it
 * was the one you were on, the pane fell back to the workspace. It is a separate
 * argument rather than folded into `activity` because the two answer different
 * questions: one is "what is happening", the other "what did the user ask to keep".
 *
 * `current` is always included even when quiet, or the strip could not show what
 * the pane is actually scoped to.
 */
export function scopesToOffer(
  activity: Activity,
  current: RepoId | null,
  opened: RepoId[] = []
): (RepoId | null)[] {
  const ids = new Set<RepoId | null>([null, ...activity.scopes, ...opened])
  ids.add(current)
  return [...ids]
}

/** `2 running · 41 repos · 1 shell`, or null when nothing is happening. */
export function activityLabel(a: Activity): string | null {
  const parts: string[] = []
  if (a.runs > 0) parts.push(`${a.runs} running`)
  // Only when it adds something: for a single-repo run "1 repo" is noise, and the
  // interesting case is the bulk one where the repo count dwarfs the run count.
  if (a.repos > 1) parts.push(`${a.repos} repos`)
  if (a.terms > 0) parts.push(`${a.terms} ${a.terms === 1 ? 'shell' : 'shells'}`)
  return parts.length > 0 ? parts.join(' · ') : null
}
