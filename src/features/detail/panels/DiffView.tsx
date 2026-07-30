import { useQuery } from '@tanstack/react-query'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { repoId, type RepoRef } from '@/domain/types'

/**
 * How many lines to render before cutting it off.
 *
 * Deliberately high now that the patch is no longer boxed: the cap exists only to
 * stop a 200k-line lockfile diff from stalling the webview, not to keep the diff
 * small. Anything a person actually reads fits well under it.
 */
const MAX_LINES = 4000

/**
 * One file's patch, inline under its row.
 *
 * Rendered from `git diff --no-color` and tinted by the leading character rather
 * than parsed into hunks: the leading `+`/`-`/`@@` is all the colouring needs, and a
 * real hunk parser would be a second, weaker diff implementation to maintain. The
 * text stays exactly what git printed, so it can be read and copied as a patch.
 *
 * Long diffs are truncated. A 20k-line vendored-file diff is not something anyone
 * reads in a 400px panel, and rendering it as 20k DOM nodes stalls the webview.
 */
export function DiffView({
  repo,
  path,
  staged,
}: {
  repo: RepoRef
  path: string
  staged: boolean
}) {
  const { data, isPending, error } = useQuery({
    queryKey: keys.fileDiff(repoId(repo), path, staged),
    queryFn: () => api.fileDiff(repo, path, staged),
    // The working tree moves under you; a cached patch is worse than a re-read.
    staleTime: 0,
    gcTime: 30_000,
  })

  if (isPending) {
    return (
      <div className="flex flex-col gap-1 border-b border-adaptive-200 bg-adaptive-100/40 px-3 py-2">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="border-b border-adaptive-200 bg-adaptive-100/40 px-3 py-2 text-[11px] text-sev-err">
        Could not read the diff: {error.message}
      </div>
    )
  }

  const text = data ?? ''
  if (!text.trim()) {
    return (
      <div className="border-b border-adaptive-200 bg-adaptive-100/40 px-3 py-2 text-[11px] text-adaptive-500">
        {staged
          ? 'Nothing staged for this file.'
          : 'No textual diff — the file may be binary, or the change may be a mode or rename only.'}
      </div>
    )
  }

  const all = text.split('\n')
  const lines = all.slice(0, MAX_LINES)
  const cut = all.length - lines.length

  return (
    <div className="border-b border-adaptive-200 bg-adaptive-100/40">
      {/* No inner scrollport, and no height cap.
       *
       * This used to be `max-h-[26rem] overflow-auto`, which put a second
       * scrollbar inside the panel's own: the patch ended mid-hunk with empty
       * panel below it, and reaching the rest meant scrolling a box while the
       * page it sat in also scrolled. The patch now takes whatever height it
       * needs and the panel scrolls it, which is how an expanded row should
       * behave — the file list stays above it, unchanged. */}
      <div className="px-3 py-2">
        <pre className="font-mono text-[11px] leading-[1.5]">
          {lines.map((line, i) => (
            <div
              key={i}
              // Soft-wrapped rather than clipped, with a hanging indent so a
              // wrapped continuation is visibly subordinate to its own +/- marker
              // and cannot be misread as a separate line. `anywhere` because the
              // long lines in real diffs are single unbroken tokens — a class
              // string or a minified bundle — which `break-words` will not break.
              className={cn(
                'pl-[2ch] -indent-[2ch] whitespace-pre-wrap [overflow-wrap:anywhere]',
                lineClass(line)
              )}
            >
              {line || ' '}
            </div>
          ))}
        </pre>
      </div>
      {cut > 0 && (
        <div className="border-t border-adaptive-200 px-3 py-1 text-[10.5px] text-adaptive-400">
          {cut.toLocaleString()} more lines not shown — “Diff…” prints the whole patch
          into the output pane.
        </div>
      )}
    </div>
  )
}

function lineClass(line: string): string {
  // Order matters: the +++/--- file headers start with + and - too, and must not be
  // coloured as added and removed lines.
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-adaptive-400'
  if (line.startsWith('@@')) return 'text-sev-info'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'text-adaptive-400'
  if (line.startsWith('+')) return 'text-sev-ok'
  if (line.startsWith('-')) return 'text-sev-err'
  return 'text-adaptive-700'
}
