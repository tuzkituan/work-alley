import { useEffect, useRef } from 'react'
import { buildTarget, choresByGroup, derive, runTarget, taskOf } from '@/domain/severity'
import { repoId, repoRefOf, type RepoId } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useTrackedPackage } from '@/hooks/use-tracked-package'
import { useBusy } from '@/hooks/use-busy'
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
  const busy = useBusy(id)

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

  // Opening a repo shows the terminal you left in it, if there is one.
  //
  // The pane resolves what to display in priority order (see `buildTabs`), and a
  // run outranks a terminal — so a repo with a live shell *and* any earlier run
  // opened onto the run log, with the shell one click away behind a chip.
  // Selecting it here is what makes "open the repo I was working in" land on the
  // work rather than on a finished command's output.
  useEffect(() => {
    // Read imperatively rather than by selector: this needs to fire on open, not
    // on every terminal event, and subscribing here would re-render the header,
    // the action bar and four panels each time a session printed a line.
    const { tabs, order, setActive } = useTerminalStore.getState()
    const own = [...order]
      .reverse()
      .map((termId) => tabs.get(termId))
      .find((t) => t?.status === 'live' && t.ref && repoId(t.ref) === id)
    // No session here: leave the selection alone. A terminal belonging to another
    // repo is already filtered out of this pane, so it cannot win anyway.
    if (own) setActive(own.termId)
  }, [id])

  const d = status ? derive(status, trackedLatest) : null
  // What "run this repo" means here — its own script, or the Cargo/Go/Python
  // entry point its files imply. `dev` keeps its name because the header, the
  // action bar and the panels all read it as "the main server".
  const target = runTarget(status)
  const build = buildTarget(status)
  const sb = taskOf(status, 'storybook')

  // Whatever the Build button took, the chip strips give up: the same command
  // offered twice on one screen reads as two different things that happen to be
  // spelled alike.
  const builtScript = status?.primaryBuild?.kind === 'script' ? status.primaryBuild.name : null
  const builtChore = status?.primaryBuild?.kind === 'chore' ? status.primaryBuild.id : null

  return {
    id,
    repo,
    status,
    d,
    dev: target.server,
    sb,
    target,
    build,
    devUp: target.up,
    // Storybook keeps its own button, but not when it is the only thing this repo
    // runs — then the primary button already is it.
    hasStorybook:
      (status?.availableTasks.includes('storybook') ?? false) && target.id !== 'storybook',
    scripts: (status?.availableScripts ?? []).filter((s) => s !== builtScript),
    choreGroups: choresByGroup(status)
      .map(([group, items]) => [group, items.filter((c) => c.id !== builtChore)] as const)
      .filter(([, items]) => items.length > 0)
      .map(([group, items]) => [group, [...items]] as [string, typeof items[number][]]),
    dirty: (status?.dirtyCount ?? 0) + (status?.untrackedCount ?? 0),
    ahead: status?.sync.kind === 'diverged' ? status.sync.ahead : 0,
    behind: status?.sync.kind === 'diverged' ? status.sync.behind : 0,
    trackedPackage,
    trackedLatest,
    busy,
  }
}
