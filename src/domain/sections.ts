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
 *
 * Whichever axis wins, a section long enough to scroll is then split again by
 * shared name prefix — see `splitByPrefix`. Forty `blazeup-subapp-*` repos are one
 * heading and forty near-identical rows on any axis this file knows about, and the
 * convention in the names is the only thing left that tells them apart.
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
  const sections = (
    byLanguage.size > 1 ? languageSections(byLanguage) : kindSections(rest, statuses)
  ).flatMap(splitByPrefix)

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

/** A section shorter than this is already scannable; splitting it adds headings. */
const SPLIT_MIN = 12
/** Below this a "family" is a coincidence of naming, not a group. */
const FAMILY_MIN = 3
/** `blazeup-subapp-workflow-builder` — past three segments the prefix is the repo. */
const MAX_SEGMENTS = 3

/**
 * Splits one long section into the naming families inside it.
 *
 * Repos in a real workspace are named by convention — `blazeup-subapp-*`,
 * `blazeup-lib-*`, `Blazeup_Micro-service_*` — and that convention is a grouping
 * the app otherwise ignores, so a 40-repo folder reads as one heading over forty
 * rows that differ in their last word.
 *
 * Derived, never configured: families come from the names actually present, so a
 * workspace with no convention produces none and the section is returned
 * untouched. That is also why the thresholds are conservative — a heading that
 * separates three repos from two is worse than no heading.
 */
export function splitByPrefix(section: Section): Section[] {
  if (section.repos.length < SPLIT_MIN) return [section]

  // Every candidate prefix and how many repos carry it. Separators stay in the key
  // so the label reads exactly as the names do.
  const counts = new Map<string, number>()
  for (const r of section.repos) {
    for (const p of prefixesOf(r.name)) counts.set(p, (counts.get(p) ?? 0) + 1)
  }

  // The longest prefix a repo shares with enough others. Longest wins so
  // `blazeup-subapp-` beats the `blazeup-` every repo in the folder also carries —
  // a family everything belongs to is not a family.
  const familyOf = (name: string): string | null => {
    let best: string | null = null
    for (const p of prefixesOf(name)) {
      if ((counts.get(p) ?? 0) >= FAMILY_MIN && (best === null || p.length > best.length)) {
        best = p
      }
    }
    return best
  }

  const families = groupBy(section.repos, (r) => familyOf(r.name))
  const named = [...families.keys()].filter((k) => k !== null).length
  // One family is the same non-answer as one language: it separates nothing, and
  // everything else lands in the leftovers.
  if (named < 2) return [section]

  const out: Section[] = []
  let leftovers: RepoRef[] = []
  for (const [family, list] of families) {
    if (family === null) leftovers = leftovers.concat(list)
    else out.push({ key: `${section.key}/pre:${family}`, label: trimSep(family), repos: list })
  }
  // Biggest first, as the language axis orders itself.
  out.sort((a, b) => b.repos.length - a.repos.length || a.label.localeCompare(b.label))
  // Whatever follows no convention keeps the section's own label — it is still
  // Frontend, it just is not part of a family.
  if (leftovers.length > 0) {
    out.push({ key: `${section.key}/pre:rest`, label: section.label, repos: leftovers })
  }
  return out
}

/**
 * `blazeup-subapp-task` -> `blazeup-`, `blazeup-subapp-`.
 *
 * Separator-terminated, so a prefix can only end where a name segment does.
 * Without that, `blazeup-s` would be a candidate and `siem` and `smartassess`
 * would look like a family.
 */
function prefixesOf(name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < name.length && out.length < MAX_SEGMENTS; i++) {
    const c = name[i]!
    if (c === '-' || c === '_' || c === '.') out.push(name.slice(0, i + 1))
  }
  return out
}

function trimSep(s: string): string {
  return s.replace(/[-_.]+$/, '')
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
