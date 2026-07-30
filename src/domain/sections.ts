import type { RepoId, RepoKind, RepoRef, RepoStatus } from './types'
import { repoId } from './types'

export type KindSectionKey =
  | 'frontend'
  | 'backend'
  | 'library'
  | 'mobile'
  | 'docs'
  | 'other'

export interface Section {
  /** Unique and stable, so the virtualizer's row keys never collide. */
  key: string
  label: string
  repos: RepoRef[]
}

const LABELS: Record<KindSectionKey, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  library: 'Libraries',
  mobile: 'Mobile',
  docs: 'Docs',
  other: 'Other',
}

/** Order kind sections appear in. */
const ORDER: KindSectionKey[] = [
  'frontend',
  'backend',
  'library',
  'mobile',
  'docs',
  'other',
]

export function isRunning(status: RepoStatus | undefined): boolean {
  // Any task counts — a repo with only storybook up is still something you are
  // working on right now.
  return (status?.tasks ?? []).some((t) => t.state === 'up' || t.state === 'starting')
}

const KIND_SECTION: Record<RepoKind, KindSectionKey> = {
  frontend: 'frontend',
  backend: 'backend',
  library: 'library',
  mobile: 'mobile',
  docs: 'docs',
  unknown: 'other',
}

/** Buckets preserving insertion order within each bucket. */
function groupBy<T>(items: RepoRef[], key: (r: RepoRef) => T): Map<T, RepoRef[]> {
  const out = new Map<T, RepoRef[]>()
  for (const r of items) {
    const k = key(r)
    const list = out.get(k)
    if (list) list.push(r)
    else out.set(k, [r])
  }
  return out
}

/**
 * Groups a folder's repos into sections.
 *
 * Running beats everything — it is what you are acting on now. The rest are
 * grouped on whichever axis actually separates them:
 *
 *   - **Language**, when the folder holds more than one. This is the useful answer
 *     for a mixed folder, and it needs no naming convention: a folder of CMake, Qt
 *     and shell projects reads as C++ / Shell rather than as one undifferentiated
 *     list.
 *   - **Kind** otherwise. In a folder where everything is TypeScript, language
 *     separates nothing, and Frontend / Backend / Libraries is what tells the repos
 *     apart.
 *
 * Choosing between the two rather than fixing one is the point: a single axis is
 * wrong for half of any real workspace.
 */
export function buildSections(
  repos: RepoRef[],
  statuses: Map<RepoId, RepoStatus>
): Section[] {
  const running: RepoRef[] = []
  const rest: RepoRef[] = []
  for (const r of repos) {
    if (isRunning(statuses.get(repoId(r)))) running.push(r)
    else rest.push(r)
  }

  const byLanguage = groupBy(rest, (r) => statuses.get(repoId(r))?.shape.language ?? null)
  // A single language group means the axis tells you nothing — including the case
  // where it is all `null` because nothing has been scanned yet.
  const sections =
    byLanguage.size > 1 ? languageSections(byLanguage) : kindSections(rest, statuses)

  return running.length > 0
    ? [{ key: 'running', label: 'Running', repos: running }, ...sections]
    : sections
}

/**
 * Biggest group first, ties broken by name.
 *
 * Size order rather than alphabetical because the bulk of a folder is what you
 * scroll through, and it should not sit under three one-repo headings. Unknown
 * trails regardless of size — it is a group only in the sense of "not the others".
 */
function languageSections(byLanguage: Map<string | null, RepoRef[]>): Section[] {
  return [...byLanguage.entries()]
    .sort(([aLang, a], [bLang, b]) => {
      if ((aLang === null) !== (bLang === null)) return aLang === null ? 1 : -1
      return b.length - a.length || (aLang ?? '').localeCompare(bLang ?? '')
    })
    .map(([lang, list]) => ({
      key: `lang:${lang ?? 'unknown'}`,
      label: lang ?? 'Other',
      repos: list,
    }))
}

function kindSections(repos: RepoRef[], statuses: Map<RepoId, RepoStatus>): Section[] {
  const byKind = groupBy(
    repos,
    (r) => KIND_SECTION[statuses.get(repoId(r))?.shape.kind ?? 'unknown']
  )
  return ORDER.filter((k) => (byKind.get(k)?.length ?? 0) > 0).map((k) => ({
    key: `kind:${k}`,
    label: LABELS[k],
    repos: byKind.get(k)!,
  }))
}

export type ListItem =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'row'; key: string; repos: RepoRef[] }

/**
 * Flattens sections into the virtualizer's item list.
 *
 * Headers are omitted entirely when there is only one section — a lone heading
 * above every row is noise.
 *
 * `perRow` pairs repos for card view. Pairing never crosses a section boundary,
 * so a section always starts on a fresh row.
 */
export function flattenSections(sections: Section[], perRow: number): ListItem[] {
  const showHeaders = sections.length > 1
  const items: ListItem[] = []

  for (const s of sections) {
    if (showHeaders) {
      items.push({
        kind: 'header',
        key: `h:${s.key}`,
        label: s.label,
        count: s.repos.length,
      })
    }
    for (let i = 0; i < s.repos.length; i += perRow) {
      const group = s.repos.slice(i, i + perRow)
      items.push({
        kind: 'row',
        key: `r:${s.key}:${group.map(repoId).join('|')}`,
        repos: group,
      })
    }
  }

  return items
}
