import { MoreHorizontal } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { useRunAction } from '@/hooks/use-action'
import { useRescanRepo } from '@/hooks/use-rescan-repo'
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
  const rescanRepo = useRescanRepo()
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
  const scripts = status?.availableScripts ?? []
  const dirty = (status?.dirtyCount ?? 0) + (status?.untrackedCount ?? 0)
  // Only to label the Push item with a count; the real preflight happens in Rust.
  const ahead = status?.sync.kind === 'diverged' ? status.sync.ahead : 0

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

        {/* A submenu rather than one item per editor: a machine with VS Code, Cursor,
            Zed and a JetBrains IDE installed put four entries above everything
            else, pushing the git actions off the first screen of the menu. */}
        {editors.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Open in</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52">
                {editors.map((e) => (
                  <DropdownMenuItem
                    key={e.id}
                    onClick={() => run({ kind: 'openInEditor', ref: repo, editor: e.id })}
                  >
                    {e.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
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
        <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
          Git
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => run({ kind: 'pull', ref: repo })}>Pull</DropdownMenuItem>
        <DropdownMenuItem onClick={() => run({ kind: 'push', ref: repo })}>
          Push{ahead > 0 ? ` (${ahead})` : ''}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => run({ kind: 'fetchAll', ref: repo })}>
          Fetch
        </DropdownMenuItem>

        {/* Reuses the bulk checkout action with a single target: one repo is just
            the n=1 case, and the dirty policy and preflight come free. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Switch branch</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
            <SwitchBranchItems repo={repo} current={status?.branch ?? null} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Stash</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuItem onClick={() => run({ kind: 'stash', ref: repo })}>
              Stash changes{dirty > 0 ? ` (${dirty})` : ''}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => run({ kind: 'stash', ref: repo, includeUntracked: true })}
            >
              Stash including untracked
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run({ kind: 'stashPop', ref: repo })}>
              Pop newest stash
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => run({ kind: 'stashList', ref: repo })}>
              List stash…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Read-only, so every one of these skips the confirm dialog and goes
            straight to the run log. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Inspect</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuItem onClick={() => run({ kind: 'status', ref: repo })}>
              Status…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run({ kind: 'diff', ref: repo })}>
              Diff…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run({ kind: 'diff', ref: repo, staged: true })}>
              Staged diff…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run({ kind: 'branchList', ref: repo })}>
              Branches…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run({ kind: 'logGraph', ref: repo })}>
              Log graph…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuItem onClick={() => void rescanRepo(repo)}>
          Rescan this repo
        </DropdownMenuItem>

        {scripts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
              Scripts
            </DropdownMenuLabel>
            {/* A submenu rather than inline items: a repo can declare a dozen
                scripts, and the menu already has plenty in it. */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Run script</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-52 overflow-y-auto">
                {scripts.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => run({ kind: 'runScript', ref: repo, script: s })}
                  >
                    <span className="font-mono text-[11.5px]">{s}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

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
        {/* Down here with the other destructive items rather than next to Push:
            after a rebase it is the only way forward, but it is never the thing
            you want by default. Both of these require a typed confirmation. */}
        <DropdownMenuItem
          variant="destructive"
          onClick={() => run({ kind: 'push', ref: repo, force: true })}
        >
          Force-push (with lease)…
        </DropdownMenuItem>
        {/* Hidden when there is nothing to lose, so the destructive item is not
            sitting there on a clean repo waiting to be misclicked. */}
        {dirty > 0 && (
          <DropdownMenuItem
            variant="destructive"
            onClick={() => run({ kind: 'discardChanges', ref: repo })}
          >
            Discard {dirty} local change{dirty === 1 ? '' : 's'}…
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

/**
 * The branch list, fetched only once the submenu is opened.
 *
 * Radix mounts sub-content lazily, so putting the query in its own component is
 * what keeps `git for-each-ref` off every row of a 40-repo grid — the same reason
 * the editors list above reads from the bootstrap cache instead of querying.
 */
function SwitchBranchItems({ repo, current }: { repo: RepoRef; current: string | null }) {
  const run = useRunAction()
  const { data, isPending, isError } = useQuery({
    queryKey: keys.branches(repoId(repo)),
    queryFn: () => api.listBranches(repo),
    staleTime: 60_000,
  })

  if (isPending) {
    return <DropdownMenuItem disabled>Loading branches…</DropdownMenuItem>
  }
  if (isError || (data ?? []).length === 0) {
    return <DropdownMenuItem disabled>No branches found</DropdownMenuItem>
  }

  return (
    <>
      {(data ?? []).map((b) => (
        <DropdownMenuItem
          key={b.name}
          disabled={b.name === current}
          // `dirty: 'stash'` rather than 'skip': asking to switch and getting
          // nothing because the tree was dirty is the more surprising outcome, and
          // stashing is recoverable. The confirm dialog says so before it runs.
          onClick={() => run({ kind: 'checkout', refs: [repo], branch: b.name, dirty: 'stash' })}
        >
          <span className="truncate font-mono text-[11.5px]">{b.name}</span>
          {b.name === current ? (
            <span className="ml-auto flex-none text-[10px] text-adaptive-400">current</span>
          ) : (
            // Drift at a glance, so you can tell a live branch from a stale one
            // without leaving the menu.
            (b.ahead > 0 || b.behind > 0) && (
              <span className="ml-auto flex-none font-mono text-[10px] text-adaptive-400">
                {b.ahead > 0 && `↑${b.ahead}`}
                {b.behind > 0 && `↓${b.behind}`}
              </span>
            )
          )}
        </DropdownMenuItem>
      ))}
    </>
  )
}
