import { MoreHorizontal } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { useRunAction } from '@/hooks/use-action'
import { useScanStore } from '@/stores/scan-store'
import { useRescanCategory } from '@/hooks/use-category-scan'
import { taskOf } from '@/domain/severity'
import { repoId, type RepoRef, type RepoStatus } from '@/domain/types'
import { useUiStore } from '@/stores/ui-store'

/**
 * Secondary actions, so the visible row stays scannable.
 *
 * "Free port" is here rather than on the row because it is only occasionally
 * wanted — but it is the only way to clear a port held by a stale process the app
 * did not start (a dev server from a previous session, or one launched by hand).
 */
export function RepoMenu({ repo, status }: { repo: RepoRef; status: RepoStatus | undefined }) {
  const run = useRunAction()
  const rescan = useRescanCategory()
  const upsert = useScanStore((s) => s.upsertMany)
  const openDetail = useUiStore((s) => s.openDetail)
  // Served from the bootstrap cache, so this costs nothing per row.
  const { data: boot } = useQuery({ queryKey: keys.bootstrap, enabled: false })
  const editors = (boot as { editors?: { id: string; label: string }[] } | undefined)?.editors ?? []

  const dev = taskOf(status, 'dev')
  const sb = taskOf(status, 'storybook')
  const port = dev?.port ?? status?.devPort ?? null
  const url = dev?.url ?? (port ? `http://localhost:${port}` : null)
  const devUp = dev?.state === 'up'
  // Only offered where package.json actually declares the script — that is every
  // ui/ library here, and nothing else.
  const hasStorybook = status?.availableTasks.includes('storybook') ?? false

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="waOutline"
          size="waIcon"
          className="shrink-0"
          onClick={(e) => e.stopPropagation()}
          title="More actions"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => openDetail(repoId(repo))}>Open details</DropdownMenuItem>

        {editors.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
              Open in
            </DropdownMenuLabel>
            {editors.map((e) => (
              <DropdownMenuItem
                key={e.id}
                onClick={() => run({ kind: 'openInEditor', ref: repo, editor: e.id })}
              >
                {e.label}
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />
        {/* A real shell in the repo, as opposed to the run log below. */}
        <DropdownMenuItem onClick={() => run({ kind: 'openShell', ref: repo })}>
          Open terminal here
        </DropdownMenuItem>
        {/* The escape hatch, for when a 372px pane is not enough room. */}
        <DropdownMenuItem
          onClick={() => run({ kind: 'openShell', ref: repo, external: true })}
        >
          Open in system terminal
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => run({ kind: 'branchList', ref: repo })}>
          Branches…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run({ kind: 'fetchAll', ref: repo })}>
          Fetch
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            void api
              .rescanRepo(repo)
              .then((s) => upsert([s]))
              .catch(() => rescan(repo.category))
          }}
        >
          Rescan this repo
        </DropdownMenuItem>

        {hasStorybook && (
          <>
            <DropdownMenuSeparator />
            {sb ? (
              <>
                <DropdownMenuItem
                  onClick={() => run({ kind: 'devStop', ref: repo, task: 'storybook' })}
                >
                  Stop Storybook
                </DropdownMenuItem>
                {sb.url && (
                  <DropdownMenuItem onClick={() => void openUrl(sb.url!).catch(() => {})}>
                    Open Storybook ({sb.url.replace('http://', '')})
                  </DropdownMenuItem>
                )}
              </>
            ) : (
              <DropdownMenuItem
                onClick={() => run({ kind: 'devStart', ref: repo, task: 'storybook' })}
              >
                Run Storybook
              </DropdownMenuItem>
            )}
          </>
        )}

        <DropdownMenuSeparator />

        {devUp && url && (
          <DropdownMenuItem onClick={() => void openUrl(url).catch(() => {})}>
            Open {url.replace('http://', '')}
          </DropdownMenuItem>
        )}
        {port !== null && (
          <DropdownMenuItem
            variant="destructive"
            onClick={() => run({ kind: 'killPort', port, ref: repo })}
          >
            Free port :{port}
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={() => {
            if (status?.path) void revealItemInDir(status.path).catch(() => {})
          }}
          disabled={!status?.path}
        >
          Reveal in file manager
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
