import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitCommitHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import type { RepoId, RepoRef } from '@/domain/types'
import { useRunAction } from '@/hooks/use-action'
import { useScanStore } from '@/stores/scan-store'
import { InspectChip, PanelEmpty, PanelError, PanelSkeleton, TabPanel } from './panel-parts'

const FIRST_PAGE = 30
const PAGE = 100
/** Past this the panel is a log viewer, and `logGraph` is the better tool. */
const MAX = 500

export function CommitsPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const run = useRunAction()
  const [limit, setLimit] = useState(FIRST_PAGE)
  // How many of these are not on the remote yet, from the scan the header already did.
  const sync = useScanStore((s) => s.repos.get(id)?.sync)
  const ahead = sync?.kind === 'diverged' ? sync.ahead : 0

  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: keys.repoCommits(id, limit),
    queryFn: () => api.repoCommits(repo, limit),
    staleTime: 30_000,
  })

  const commits = data ?? []
  // A short answer means the history ended, so there is nothing more to ask for.
  const maybeMore = commits.length >= limit && limit < MAX

  return (
    <TabPanel
      icon={<GitCommitHorizontal className="size-3.5 text-adaptive-400" />}
      title={error ? 'Commits' : `${commits.length} commits`}
      // Said out loud rather than left as a surprise: the backend passes
      // --no-merges, so a merge-heavy history looks shorter here than `git log`.
      right={
        <span className="font-mono text-[11px] text-adaptive-400">no merges</span>
      }
      isFetching={isFetching}
      onRefresh={() => void refetch()}
      actions={
        <InspectChip
          label="Log graph…"
          title="Show git log --graph in the output pane"
          onClick={() => run({ kind: 'logGraph', ref: repo })}
        />
      }
    >
      {isPending ? (
        <PanelSkeleton n={5} />
      ) : error ? (
        <PanelError what="the commit log" message={error.message} />
      ) : commits.length === 0 ? (
        <PanelEmpty>No commits found.</PanelEmpty>
      ) : (
        <>
          {commits.map((c, i) => (
            <div
              key={c.sha}
              className={cn(
                'wa-commit-cols border-b border-adaptive-200 px-3 py-2 last:border-b-0',
                // Unpushed. Count-based, not a real `@{u}..HEAD` range: the log is
                // HEAD-first and --no-merges, so a merge-heavy history can shade one
                // row too few. Worth it — "have I pushed this?" is asked constantly.
                i < ahead && 'bg-warning-500/[0.06]'
              )}
              title={i < ahead ? 'Not pushed yet' : undefined}
            >
              <span className="font-mono text-[11px] text-primary-600">
                {i < ahead && <span className="mr-1 text-sev-warn">↑</span>}
                {c.sha}
              </span>
              <span className="truncate text-xs text-adaptive-800" title={c.subject}>
                {c.subject}
              </span>
              <span className="wa-d-optional truncate text-[11px] text-adaptive-500">
                {c.author}
              </span>
              <span
                className="wa-num text-right text-[11px] text-adaptive-400"
                title={new Date(c.unix * 1000).toLocaleString()}
              >
                {c.relative}
              </span>
            </div>
          ))}
          {maybeMore && (
            <div className="p-2">
              <Button
                variant="waGhost"
                size="waXs"
                className="w-full"
                disabled={isFetching}
                onClick={() => setLimit((n) => Math.min(n + PAGE, MAX))}
              >
                Load {Math.min(PAGE, MAX - limit)} more
              </Button>
            </div>
          )}
        </>
      )}
    </TabPanel>
  )
}
