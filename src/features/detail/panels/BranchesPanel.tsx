import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Cloud, GitBranch, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import type { BranchInfo, RepoId, RepoRef } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useRunAction } from '@/hooks/use-action'
import { relativeFromUnix } from '@/lib/time'
import { BranchCheckout } from './BranchCheckout'
import { InspectChip, PanelEmpty, PanelError, PanelSkeleton, TabPanel } from './panel-parts'

export function BranchesPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const run = useRunAction()
  const current = useScanStore((s) => s.repos.get(id)?.branch)
  const [query, setQuery] = useState('')

  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: keys.branches(id),
    queryFn: () => api.listBranches(repo),
    staleTime: 60_000,
  })

  // The checked-out branch first, then the backend's order (most recent commit
  // first). A 60-branch repo otherwise buries the one you are standing on.
  const branches = useMemo(() => {
    const all = data ?? []
    const q = query.trim().toLowerCase()
    const filtered = q ? all.filter((b) => b.name.toLowerCase().includes(q)) : all
    return [...filtered].sort(
      (a, b) => Number(b.name === current) - Number(a.name === current)
    )
  }, [data, query, current])

  const total = data?.length ?? 0
  const filtering = query.trim().length > 0

  return (
    <TabPanel
      icon={<GitBranch className="size-3.5 text-adaptive-400" />}
      title={
        error ? 'Branches' : filtering ? `${branches.length} of ${total}` : `${total} branches`
      }
      isFetching={isFetching}
      onRefresh={() => void refetch()}
      actions={
        <>
          <div className="relative w-[15rem] flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-adaptive-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
              placeholder="Filter branches…"
              aria-label="Filter branches"
              className="h-[26px] pl-7 text-xs"
            />
          </div>
          <InspectChip
            label="git branch -vv…"
            title="Show the raw branch list in the output pane"
            onClick={() => run({ kind: 'branchList', ref: repo })}
          />
        </>
      }
    >
      {isPending ? (
        <PanelSkeleton n={5} />
      ) : error ? (
        <PanelError what="the branch list" message={error.message} />
      ) : branches.length === 0 ? (
        <PanelEmpty>{filtering ? 'No branches match.' : 'No branches found.'}</PanelEmpty>
      ) : (
        branches.map((b) => (
          <BranchRow key={b.name} branch={b} repo={repo} current={b.name === current} />
        ))
      )}
    </TabPanel>
  )
}

function BranchRow({
  branch,
  repo,
  current,
}: {
  branch: BranchInfo
  repo: RepoRef
  current: boolean
}) {
  const { ahead, behind } = branch

  return (
    <div
      className={cn(
        'wa-branch-cols border-b border-adaptive-200 px-3 py-1.5 last:border-b-0',
        current ? 'bg-adaptive-100/60' : 'hover:bg-adaptive-100/40'
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {/* A cloud, because "you do not have this yet" changes what checkout does:
            it creates a local tracking branch rather than switching to one. */}
        {!branch.local && (
          <span className="flex-none" title="Only on origin — checking out creates it locally">
            <Cloud className="size-3 text-adaptive-400" />
          </span>
        )}
        <span
          className={cn(
            'truncate font-mono text-[11.5px]',
            current ? 'font-semibold text-primary-600' : 'text-adaptive-800'
          )}
          title={branch.subject ? `${branch.name} — ${branch.subject}` : branch.name}
        >
          {branch.name}
        </span>
      </div>

      {/* Drift against its own upstream, which is a different question from the
          repo-level sync in the header: that one is only about the current branch. */}
      <span className="wa-d-narrow truncate text-right font-mono text-[11px]">
        {ahead > 0 && <span className="text-sev-warn">↑{ahead}</span>}
        {ahead > 0 && behind > 0 && ' '}
        {behind > 0 && <span className="text-sev-info">↓{behind}</span>}
        {ahead === 0 && behind === 0 && (
          <span className="text-adaptive-400">{branch.upstream ? 'in sync' : '—'}</span>
        )}
      </span>

      <span
        className="wa-d-optional text-right font-mono text-[11px] text-adaptive-400"
        title={
          branch.lastCommitUnix
            ? new Date(branch.lastCommitUnix * 1000).toLocaleString()
            : undefined
        }
      >
        {relativeFromUnix(branch.lastCommitUnix)}
      </span>

      <div className="flex justify-end">
        {current ? (
          <span className="text-[10px] text-adaptive-400">here</span>
        ) : (
          <BranchCheckout repo={repo} branch={branch.name}>
            <button
              type="button"
              className="rounded-sm px-1.5 py-0.5 text-[11px] text-adaptive-500 hover:bg-adaptive-200 hover:text-adaptive-900"
              title={`Switch this repo to ${branch.name}`}
            >
              switch
            </button>
          </BranchCheckout>
        )}
      </div>
    </div>
  )
}
