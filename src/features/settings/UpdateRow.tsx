import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { openUrl } from '@/lib/open-url'
import type { Bootstrap, UpdateCheck } from '@/domain/types'
import { SettingRow } from './sections'

/**
 * "Am I running the newest one?", answered on request.
 *
 * A button rather than a check on launch. The app already spends its first second
 * probing a toolchain and scanning a folder, and a version check is the one piece
 * of startup work whose answer is almost always "no change" — so it waits until
 * someone wonders. It is also the only network call the app makes that is about
 * *itself* rather than about the user's repos, which is a good reason to make it
 * visible and deliberate.
 *
 * Nothing here installs anything: `Download` opens the releases page. See
 * `src-tauri/src/update.rs` for why in-place updating is the wrong shape for an
 * app distributed as a `.deb`, an `.rpm` and an `.AppImage` at once.
 */
export function UpdateRow() {
  // Already in cache — App fetched it before this page could be reached. Read
  // through the query rather than a prop so the version is right after a reload
  // of the page in dev, where the prop chain does not exist yet.
  const { data: boot } = useQuery<Bootstrap>({
    queryKey: keys.bootstrap,
    queryFn: () => api.getBootstrap(),
    staleTime: Infinity,
  })

  // A mutation, not a query: this runs when asked and its result is not something
  // to keep fresh. `data` doubles as "has been asked", which is what lets the row
  // say nothing at all until it has something true to say.
  const check = useMutation<UpdateCheck>({ mutationFn: () => api.checkForUpdates() })

  const result = check.data
  const current = result?.current ?? boot?.appVersion ?? '—'
  const update = result?.kind === 'available' ? result : null

  return (
    <SettingRow label="Version" hint={hint(result, check.isPending)}>
      <span className="wa-num mr-1 font-mono text-xs text-adaptive-500">{current}</span>
      {update && (
        <Button variant="waOutline" size="waXs" onClick={() => openUrl(update.url)}>
          <Download className="size-3" />
          Download {update.latest}
        </Button>
      )}
      <Button
        variant="waOutline"
        size="waXs"
        disabled={check.isPending}
        onClick={() => check.mutate()}
      >
        {check.isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        Check for updates
      </Button>
    </SettingRow>
  )
}

/** The one line under the label. Every state has a sentence; none has a toast. */
function hint(result: UpdateCheck | undefined, pending: boolean): string {
  if (pending) return 'Reading the release tags on github.com…'
  if (!result) {
    return 'Checks github.com for a newer release. Nothing is downloaded or installed.'
  }
  switch (result.kind) {
    case 'upToDate':
      return `Up to date — ${result.current} is the newest release.`
    case 'available':
      return `${result.latest} is out. Download opens the releases page in your browser; installing is up to your package manager.`
    case 'failed':
      // git's own words, usually: "Could not resolve host: github.com" tells
      // someone they are offline, where "the check failed" tells them nothing.
      return `Could not check: ${result.reason}`
  }
}
