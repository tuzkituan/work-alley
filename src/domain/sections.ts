import type { RepoId, RepoRef, RepoStatus } from './types'
import { repoId } from './types'

export type SectionKey = 'running' | 'hostapp' | 'other'

export interface Section {
  key: SectionKey
  label: string
  repos: RepoRef[]
}

const LABELS: Record<SectionKey, string> = {
  running: 'Running',
  hostapp: 'Host apps',
  other: 'Sub-apps & libraries',
}

export function isHostapp(name: string): boolean {
  return name === 'blazeup-hostapp' || name.startsWith('blazeup-hostapp-')
}

export function isRunning(status: RepoStatus | undefined): boolean {
  // Any task counts — a repo with only storybook up is still something you are
  // working on right now.
  return (status?.tasks ?? []).some((t) => t.state === 'up' || t.state === 'starting')
}

/**
 * Groups a folder's repos into Running / Host apps / everything else.
 *
 * Running wins over Host apps deliberately: a running hostapp is something you
 * are working on right now, which is more useful than what kind of repo it is.
 * Order within a section is left as-is (stable, name-ordered from discovery), so
 * rows never reshuffle while a scan streams in.
 */
export function buildSections(
  repos: RepoRef[],
  statuses: Map<RepoId, RepoStatus>
): Section[] {
  const running: RepoRef[] = []
  const hostapp: RepoRef[] = []
  const other: RepoRef[] = []

  for (const r of repos) {
    if (isRunning(statuses.get(repoId(r)))) running.push(r)
    else if (isHostapp(r.name)) hostapp.push(r)
    else other.push(r)
  }

  return (
    [
      { key: 'running' as const, label: LABELS.running, repos: running },
      { key: 'hostapp' as const, label: LABELS.hostapp, repos: hostapp },
      { key: 'other' as const, label: LABELS.other, repos: other },
    ] satisfies Section[]
  ).filter((s) => s.repos.length > 0)
}

export type ListItem =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'row'; key: string; repos: RepoRef[] }

/**
 * Flattens sections into the virtualizer's item list.
 *
 * Headers are omitted entirely when there is only one section — a lone "Sub-apps
 * & libraries" heading above every row is noise, which is exactly what ui/ (two
 * repos, no hostapps, nothing running) would get.
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
