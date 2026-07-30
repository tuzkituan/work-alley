import { useEffect, useRef } from 'react'
import { derive, taskOf } from '@/domain/severity'
import { repoRefOf, type RepoId } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useRunStore } from '@/stores/run-store'
import { useTrackedPackage } from '@/hooks/use-tracked-package'
import { useRescanRepo } from '@/hooks/use-rescan-repo'

/**
 * Everything the detail page derives from one repo id, in one place.
 *
 * Extracted because the header, the action bar and four panels all needed the same
 * six store reads, and passing them down as a dozen props was worse than reading
 * them again — zustand selectors are cheap and each component re-renders only for
 * what it actually selected.
 */
export function useDetailRepo(id: RepoId) {
  const status = useScanStore((s) => s.repos.get(id))
  const trackedLatest = useScanStore((s) => s.trackedLatest)
  const trackedPackage = useTrackedPackage()
  const running = useRunStore((s) => s.runningByScope[id] ?? 0)

  // Prefer the ref the backend sent. Parsing the id is only a fallback for a repo
  // that has not been scanned yet, and it is genuinely ambiguous: a category can
  // contain a slash, so "a/b/c" cannot be split reliably without the real ref.
  const repo = status?.ref ?? repoRefOf(id)

  // Scan this one repo if nothing has scanned it yet.
  //
  // Folders are scanned lazily, on first expand — so opening a repo straight from
  // the command palette used to land on a page of em-dashes with no way to fill it
  // in short of going back and expanding its folder. One repo, not the folder: this
  // is the cheap answer to "what am I looking at".
  const rescanRepo = useRescanRepo()
  const asked = useRef(false)
  useEffect(() => {
    if (status || asked.current) return
    asked.current = true
    void rescanRepo(repo)
    // `repo` is derived from `id`, and re-running on a fresh object identity would
    // fire a second scan for the same repo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, status])

  const d = status ? derive(status, trackedLatest) : null
  const dev = taskOf(status, 'dev')
  const sb = taskOf(status, 'storybook')

  return {
    id,
    repo,
    status,
    d,
    dev,
    sb,
    // 'starting' counts as up: the button has to offer Stop, or a server stuck
    // starting can never be stopped from here.
    devUp: dev?.state === 'up' || dev?.state === 'starting',
    hasStorybook: status?.availableTasks.includes('storybook') ?? false,
    scripts: status?.availableScripts ?? [],
    dirty: (status?.dirtyCount ?? 0) + (status?.untrackedCount ?? 0),
    ahead: status?.sync.kind === 'diverged' ? status.sync.ahead : 0,
    behind: status?.sync.kind === 'diverged' ? status.sync.behind : 0,
    trackedPackage,
    trackedLatest,
    running,
  }
}
