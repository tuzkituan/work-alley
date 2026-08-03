import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, RefreshCw, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openUrl } from '@/lib/open-url'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { useUiStore } from '@/stores/ui-store'
import { ProjectBoard } from './ProjectBoard'

/**
 * A GitHub Projects v2 board, read-only, spanning every repo in this workspace.
 *
 * Phase 1: display only, manual refresh. Moving an item, editing a field or
 * adding one all still happen on github.com — this page is a read surface, not
 * yet a write path. Which project to show is chosen in Settings; this page
 * itself takes no repo/owner arguments, since a project is workspace-wide, not
 * repo-scoped like the PRs/Actions tabs.
 */
export function GithubProjectsPage() {
  const setPage = useUiStore((s) => s.setPage)

  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: keys.githubProjectItems,
    queryFn: () => api.listGithubProjectItems(),
    // Same reasoning as the PR/workflow panels: gh hits the network, so refetch
    // on the Refresh button, not on every focus.
    staleTime: 60_000,
  })

  const items = data?.kind === 'ok' ? data.items : []

  const body = () => {
    if (isPending) {
      return <p className="px-1 text-[12.5px] text-adaptive-400">Loading…</p>
    }
    if (error) {
      return <Empty title="Could not load the board">{error.message}</Empty>
    }

    switch (data?.kind) {
      case 'ghMissing':
        return (
          <Empty title="GitHub CLI not found">
            The <code className="font-mono">gh</code> CLI is not installed, so the board cannot
            be fetched. Install it, then Refresh.
          </Empty>
        )
      case 'notAuthenticated':
        return (
          <Empty title="Not signed in">
            <code className="font-mono">gh</code> is not logged in. Run{' '}
            <code className="font-mono">gh auth login</code> in a terminal, then Refresh.
            <div className="mt-1 font-mono text-[11px] text-adaptive-400">{data.message}</div>
          </Empty>
        )
      case 'missingScope':
        return (
          <Empty title="Missing the project scope">
            <code className="font-mono">gh</code> is signed in, but its token cannot read
            Projects yet. Run{' '}
            <code className="font-mono">gh auth refresh -s read:project</code> in a terminal,
            then Refresh.
            <div className="mt-1 font-mono text-[11px] text-adaptive-400">{data.message}</div>
          </Empty>
        )
      case 'notConfigured':
        return (
          <Empty title="No project chosen yet">
            Pick a GitHub Projects v2 board in{' '}
            <button
              type="button"
              onClick={() => setPage('settings')}
              className="font-medium text-primary-600 hover:underline"
            >
              Settings
            </button>{' '}
            to see it here.
          </Empty>
        )
      case 'failed':
        return <Empty title="Could not load the board">{data.message}</Empty>
      default:
        if (items.length === 0) return <Empty title="Nothing on this board yet">—</Empty>
        return <ProjectBoard items={items} />
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-adaptive-200 bg-background px-4 py-3">
        <div className="mx-auto flex w-full max-w-[104rem] items-center gap-2">
          <Button
            variant="waGhost"
            size="waIcon"
            onClick={() => setPage('repos')}
            title="Back to the workspace"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold tracking-[-0.01em]">
            {data?.kind === 'ok' ? data.projectTitle : 'Projects'}
          </h1>
          {data?.kind === 'ok' && (
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {items.length}
            </span>
          )}
          <div className="flex-1" />
          {data?.kind === 'ok' && (
            <button
              type="button"
              onClick={() => openUrl(data.projectUrl)}
              className="flex items-center gap-1 truncate font-mono text-[11px] text-adaptive-400 hover:text-primary-600 hover:underline"
              title="Open on GitHub"
            >
              {data.owner}/{data.number}
              <ExternalLink className="size-3" />
            </button>
          )}
          <Button
            variant="waGhost"
            size="waIcon"
            onClick={() => setPage('settings')}
            title="Change which project this shows"
          >
            <Settings className="size-4" />
          </Button>
          <Button
            variant="waOutline"
            size="waXs"
            disabled={isFetching}
            onClick={() => void refetch()}
            title="Refresh from GitHub"
          >
            <RefreshCw className={isFetching ? 'size-3 animate-spin' : 'size-3'} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="wa-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3.5">
        <div className="mx-auto flex w-full max-w-[104rem] min-h-0 flex-1 flex-col">
          {body()}
        </div>
      </div>
    </div>
  )
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-dashed border-adaptive-300 p-5 text-center">
      <p className="text-[13px] text-adaptive-700">{title}</p>
      <p className="mt-1 text-[11.5px] text-adaptive-500">{children}</p>
    </div>
  )
}
