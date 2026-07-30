import { useQuery } from '@tanstack/react-query'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { repoId, type RepoRef } from '@/domain/types'

/** How many lines to render before cutting it off. */
const MAX_LINES = 600

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
      <div className="wa-scroll max-h-[26rem] overflow-auto px-3 py-2">
        <pre className="font-mono text-[11px] leading-[1.5]">
          {lines.map((line, i) => (
            <div key={i} className={cn('whitespace-pre', lineClass(line))}>
              {line || ' '}
            </div>
          ))}
        </pre>
      </div>
      {cut > 0 && (
        <div className="border-t border-adaptive-200 px-3 py-1 text-[10.5px] text-adaptive-400">
          {cut.toLocaleString()} more lines not shown — use “Diff…” for the whole patch.
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
