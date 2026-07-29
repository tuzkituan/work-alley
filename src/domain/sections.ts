import type { RepoId, RepoKind, RepoRef, RepoStatus } from './types'
import { repoId } from './types'

export type SectionKey =
  | 'running'
  | 'frontend'
  | 'backend'
  | 'library'
  | 'mobile'
  | 'docs'
  | 'other'

export interface Section {
  key: SectionKey
  label: string
  repos: RepoRef[]
}

const LABELS: Record<SectionKey, string> = {
  running: 'Running',
  frontend: 'Frontend',
  backend: 'Backend',
  library: 'Libraries',
  mobile: 'Mobile',
  docs: 'Docs',
  other: 'Other',
}

/** Order sections appear in. Running first because it is what you act on now. */
const ORDER: SectionKey[] = [
  'running',
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

const KIND_SECTION: Record<RepoKind, SectionKey> = {
  frontend: 'frontend',
  backend: 'backend',
  library: 'library',
  mobile: 'mobile',
  docs: 'docs',
  unknown: 'other',
}

/**
 * Groups a folder's repos into sections.
 *
 * Precedence is deliberate: Running beats everything — it is what you are
 * working on right now — then the *detected* kind. Kind comes from the repo's
 * own files, so this works in any workspace, with or without naming
 * conventions.
 */
export function buildSections(
  repos: RepoRef[],
  statuses: Map<RepoId, RepoStatus>
): Section[] {
  const buckets = new Map<SectionKey, RepoRef[]>()
  const push = (key: SectionKey, r: RepoRef) => {
    const list = buckets.get(key)
    if (list) list.push(r)
    else buckets.set(key, [r])
  }

  for (const r of repos) {
    const st = statuses.get(repoId(r))
    if (isRunning(st)) push('running', r)
    else push(KIND_SECTION[st?.shape.kind ?? 'unknown'], r)
  }

  return ORDER.filter((k) => (buckets.get(k)?.length ?? 0) > 0).map((k) => ({
    key: k,
    label: LABELS[k],
    repos: buckets.get(k)!,
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
