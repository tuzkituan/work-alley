import { useState } from 'react'
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
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { openUrl } from '@/lib/open-url'
import { keys } from '@/queries/keys'
import type { AccountsView } from '@/domain/types'
import { useRunAction } from '@/hooks/use-action'
import { useRescanRepo } from '@/hooks/use-rescan-repo'
import { buildTarget, choresByGroup, runTarget, taskOf } from '@/domain/severity'
import { repoId, type RepoRef, type RepoStatus } from '@/domain/types'
import { useRepoLists } from '@/stores/repo-lists'
import { useUiStore } from '@/stores/ui-store'
import { CheckoutRepoDialog } from '@/features/actions/CheckoutRepoDialog'
import { RunCommandDialog } from '@/features/detail/RunCommandDialog'
import { useTerminalStore } from '@/stores/terminal-store'

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
  const agents = (boot as { agents?: { id: string; label: string }[] } | undefined)?.agents ?? []
  // Same trick as the editors above: whatever the accounts page has already
  // fetched, and nothing when it has not been opened — 113 rows must not each
  // spawn a `git config` read to decide whether to draw a submenu.
  const { data: accountsView } = useQuery({ queryKey: keys.gitAccounts, enabled: false })
  const accounts = (accountsView as AccountsView | undefined)?.accounts ?? []

  const target = runTarget(status)
  const dev = target.server
  const sb = taskOf(status, 'storybook')
  const port = dev?.port ?? status?.devPort ?? null
  const url = dev?.url ?? (port ? `http://localhost:${port}` : null)
  const devUp = dev?.state === 'up'
  // Only offered where package.json actually declares the script — that is every
  // ui/ library here, and nothing else. Suppressed when Storybook *is* the primary
  // task, since then the main Run button already covers it.
  const hasStorybook =
    (status?.availableTasks.includes('storybook') ?? false) && target.id !== 'storybook'
  const build = buildTarget(status)
  const scripts = status?.availableScripts ?? []
  const choreGroups = choresByGroup(status)
  const dirty = (status?.dirtyCount ?? 0) + (status?.untrackedCount ?? 0)
  // Only to label the Push item with a count; the real preflight happens in Rust.
  const ahead = status?.sync.kind === 'diverged' ? status.sync.ahead : 0
  const root = useUiStore((s) => s.workspaceRoot)
  const togglePin = useRepoLists((s) => s.togglePin)
  // A boolean, computed *inside* the selector. Returning `?? []` from one mints a
  // fresh array on every call, which zustand compares by reference — so the store
  // reported a change on every render, on every one of 113 rows, and the app
  // rendered itself into a blank window.
  const isPinned = useRepoLists((s) =>
    (s.byRoot[root]?.pinned ?? []).some((r) => repoId(r) === repoId(repo))
  )
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [runCmdOpen, setRunCmdOpen] = useState(false)

  return (
    <>
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
        {(editors.length > 0 || agents.length > 0) && (
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
                {/* Under a heading, because these behave differently: an editor
                    takes over its own window, while an agent opens a terminal tab
                    in the pane below and stays there. */}
                {agents.length > 0 && (
                  <>
                    {editors.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
                      Agents
                    </DropdownMenuLabel>
                    {agents.map((a) => (
                      <DropdownMenuItem
                        key={a.id}
                        onClick={() => run({ kind: 'openAgent', ref: repo, agent: a.id })}
                      >
                        {a.label}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        <DropdownMenuSeparator />
        {/* A real shell in the repo, as opposed to the run log below. */}
        <DropdownMenuItem
          onClick={() => {
            useTerminalStore.getState().requestFocus()
            run({ kind: 'openShell', ref: repo })
          }}
        >
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

        {/* A dialog, not a submenu of branch names. The submenu fired the moment
            you clicked a name, with a hardcoded dirty policy and no preview — so
            the two questions that decide whether a checkout is safe were never
            asked. `onSelect` closes the menu first: a Radix menu and a dialog
            cannot both hold focus. */}
        <DropdownMenuItem onSelect={() => setCheckoutOpen(true)}>
          Switch branch…
        </DropdownMenuItem>

        {/* Only where something is runnable: an override can replace a detected
            task's command, not invent one for a repo that runs nothing. */}
        <DropdownMenuItem
          disabled={(status?.runnable.length ?? 0) === 0}
          onSelect={() => setRunCmdOpen(true)}
        >
          Edit run command…
        </DropdownMenuItem>

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

        {/* Also on the row and the card, but the row drops its label at 640px and
            a menu item is the one affordance that never shrinks. */}
        {build && (
          <DropdownMenuItem onClick={() => run(build.spec(repo))} title={`Runs ${build.label}`}>
            Build
            <span className="ml-auto font-mono text-[10px] text-adaptive-400">{build.label}</span>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem onClick={() => togglePin(root, repo)}>
          {isPinned ? 'Unpin from the rail' : 'Pin to the rail'}
        </DropdownMenuItem>

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

        {/* The repo scope for a git account: `.git/config` here, overriding the
            machine default. This is the whole point of having more than one — a work
            laptop with three personal repos on it — and the accounts page cannot
            offer it, because it does not know which repo you mean. Hidden until at
            least one account exists rather than shown empty. */}
        {accounts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Commit as…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                {accounts.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    onClick={() => run({ kind: 'useGitAccount', id: a.id, ref: repo })}
                    title={`Writes user.name and user.email into ${repo.name}'s own config`}
                  >
                    {a.label}
                    <span className="ml-auto font-mono text-[10px] text-adaptive-400">
                      {a.email}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        {/* The ecosystem's own commands — `flutter pub get`, `./gradlew clean`,
            `cargo clippy`. One submenu per group rather than one flat list: a React
            Native repo offers four groups at once, and 40 items in a single scroller
            is not a menu you can find anything in. */}
        {choreGroups.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
              Commands
            </DropdownMenuLabel>
            {choreGroups.map(([group, items]) => (
              <DropdownMenuSub key={group}>
                <DropdownMenuSubTrigger>{group}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto">
                  {items.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onClick={() => run({ kind: 'runChore', ref: repo, chore: c.id })}
                      title={
                        c.destructive
                          ? 'Deletes build output or rewrites files — asks first'
                          : c.label
                      }
                    >
                      <span className="font-mono text-[11.5px]">{c.label}</span>
                      {/* The confirm is enforced in Rust; this is only so you can
                          see which items will ask before you click one. */}
                      {c.destructive && (
                        <span className="ml-auto pl-2 text-[10px] text-sev-warn">!</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
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
                  <DropdownMenuItem onClick={() => openUrl(sb.url!)}>
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
          <DropdownMenuItem onClick={() => openUrl(url)}>
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

      {/* Outside the menu: Radix unmounts the content on close, and a dialog
          rendered inside it would go with it the moment the item is chosen. */}
      <CheckoutRepoDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        repo={repo}
        current={status?.branch ?? null}
      />
      <RunCommandDialog
        open={runCmdOpen}
        onOpenChange={setRunCmdOpen}
        repo={repo}
        tasks={status?.runnable ?? []}
        initialTask={status?.primaryTask ?? null}
      />
    </>
  )
}

