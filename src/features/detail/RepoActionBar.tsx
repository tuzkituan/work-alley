import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  GitBranch,
  PackagePlus,
  Play,
  Settings2,
  SquareTerminal,
} from 'lucide-react'
import { openUrl } from '@/lib/open-url'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { keys } from '@/queries/keys'
import { useRunAction } from '@/hooks/use-action'
import { CheckoutRepoDialog } from '@/features/actions/CheckoutRepoDialog'
import { RunCommandDialog } from './RunCommandDialog'
import { cn } from '@/lib/utils'
import { installTarget } from '@/domain/severity'
import { MANAGERS } from '@/domain/types'
import { useManagerStore } from '@/stores/manager-store'
import type { useDetailRepo } from './use-detail-repo'
import { useTerminalStore } from '@/stores/terminal-store'

/**
 * Drops the leading binary name from a command label.
 *
 * `flutter pub get` under a "Flutter" heading reads as "pub get" — the heading
 * already said which tool, and repeating it three times a row is all the width.
 * Only the first token, and only when it matches: `./gradlew clean` keeps its
 * wrapper path, which is information.
 */
function stripTool(label: string, group: string): string {
  const [head, ...rest] = label.split(' ')
  if (!rest.length) return label
  return head?.toLowerCase() === group.toLowerCase() ? rest.join(' ') : label
}

/** The always-visible actions. Everything rarer stays in the RepoMenu above. */
export function RepoActionBar({ ctx }: { ctx: ReturnType<typeof useDetailRepo> }) {
  const run = useRunAction()
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [runCmdOpen, setRunCmdOpen] = useState(false)
  const {
    id,
    repo,
    status,
    dev,
    sb,
    devUp,
    target,
    build,
    hasStorybook,
    scripts,
    choreGroups,
    ahead,
  } = ctx
  const install = installTarget(status)
  // Shared, because it governs Run and the Build menu too — see `useRunAction`.
  const manager = useManagerStore((s) => s.byRepo[id] ?? null)
  const setManager = useManagerStore((s) => s.set)

  // From the bootstrap cache, so this costs nothing — the same trick RepoMenu uses.
  const { data: boot } = useQuery({ queryKey: keys.bootstrap, enabled: false })
  const editors = (boot as { editors?: { id: string; label: string }[] } | undefined)?.editors ?? []
  const agents = (boot as { agents?: { id: string; label: string }[] } | undefined)?.agents ?? []
  // The repo's own answer, else the machine's — which already honours the
  // Settings choice. Never a hardcoded name: a chip that says npm while bun runs
  // is worse than a chip that says nothing.
  const detected =
    status?.packageManager ??
    (boot as { packageManager?: string | null } | undefined)?.packageManager ??
    null


  return (
    <div className="flex flex-col gap-1.5 border-t border-adaptive-200 pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="waOutline"
          size="waSm"
          title="Open a shell in this repo"
          onClick={() => {
            useTerminalStore.getState().requestFocus()
            run({ kind: 'openShell', ref: repo })
          }}
        >
          <SquareTerminal className="size-3" />
          Terminal
        </Button>
        <Button variant="waOutline" size="waSm" onClick={() => run({ kind: 'pull', ref: repo })}>
          Pull
        </Button>
        {/* Disabled at zero rather than hidden: a Push that comes and goes as you
            commit is harder to find than one that is always in the same place. The
            real preflight is in Rust — this count is only the label. */}
        <Button
          variant="waOutline"
          size="waSm"
          disabled={ahead === 0}
          title={ahead === 0 ? 'Nothing to push' : `Push ${ahead} commit(s) to origin`}
          onClick={() => run({ kind: 'push', ref: repo })}
        >
          Push{ahead > 0 ? ` (${ahead})` : ''}
        </Button>
        <Button
          variant="waOutline"
          size="waSm"
          onClick={() => run({ kind: 'fetchAll', ref: repo })}
        >
          Fetch
        </Button>
        {/* Picks from this repo's branches, previews the switch and asks what to do
            with uncommitted work — the same dialog the row menu and the branch
            fields open. */}
        <Button
          variant="waOutline"
          size="waSm"
          title="Check out a branch in this repo"
          onClick={() => setCheckoutOpen(true)}
        >
          <GitBranch className="size-3" />
          Checkout
        </Button>
        {install ? (
          <Button
            variant="waPrimary"
            size="waSm"
            title="Dependencies are not installed — install them"
            onClick={() => run(install.spec(repo))}
          >
            <PackagePlus className="size-3" />
            Install
          </Button>
        ) : (
        <Button
          variant={devUp ? 'waDanger' : 'waOutline'}
          size="waSm"
          disabled={!target.id || target.busy}
          title={
            !target.id
              ? 'Nothing to run in this repo'
              : target.busy
                ? `Stopping ${target.label}…`
                : devUp
                  ? `Stop ${target.label}`
                  : target.crashed
                    ? `Restart ${target.label}`
                    : `Start ${target.label}`
          }
          onClick={() => {
            if (!target.id || target.busy) return
            run({ kind: devUp ? 'devStop' : 'devStart', ref: repo, task: target.id })
          }}
        >
          {/* The port stays on the Stop label — it is the one place with room, and
              it is the number you want while something is up. */}
          {devUp ? `Stop${dev?.port ? ` :${dev.port}` : ''}` : 'Run'}
        </Button>
        )}
        {/* Beside Run, because it is about Run: what that button executes. */}
        <Button
          variant="waGhost"
          size="waIcon"
          disabled={(status?.runnable.length ?? 0) === 0}
          title={
            (status?.runnable.length ?? 0) === 0
              ? 'Nothing runnable here to override'
              : 'Edit what Run executes'
          }
          aria-label="Edit run command"
          onClick={() => setRunCmdOpen(true)}
        >
          <Settings2 className="size-3" />
        </Button>
        {build && (
          <Button
            variant="waOutline"
            size="waSm"
            title={`Runs ${build.label}`}
            onClick={() => run(build.spec(repo))}
          >
            Build
          </Button>
        )}
        {hasStorybook && (
          <Button
            variant={sb ? 'waDanger' : 'waOutline'}
            size="waSm"
            onClick={() => run({ kind: sb ? 'devStop' : 'devStart', ref: repo, task: 'storybook' })}
          >
            {sb ? `Stop Storybook${sb.port ? ` :${sb.port}` : ''}` : 'Run Storybook'}
          </Button>
        )}

        {/* First editor as the button, the rest behind a chevron: one click for the
            common case without four buttons for the uncommon one. */}
        {editors.length > 0 && (
          <div className="flex items-center">
            <Button
              variant="waOutline"
              size="waSm"
              data-split={editors.length > 1 ? 'left' : undefined}
              title={`Open this repo in ${editors[0]!.label}`}
              onClick={() => run({ kind: 'openInEditor', ref: repo, editor: editors[0]!.id })}
            >
              {editors[0]!.label}
            </Button>
            {(editors.length > 1 || agents.length > 0) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="waOutline"
                    size="waSm"
                    data-split="right"
                    className="px-1"
                    title="Open in another editor"
                  >
                    <ChevronDown className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {editors.slice(1).map((e) => (
                    <DropdownMenuItem
                      key={e.id}
                      onClick={() => run({ kind: 'openInEditor', ref: repo, editor: e.id })}
                    >
                      {e.label}
                    </DropdownMenuItem>
                  ))}
                  {agents.length > 0 && (
                    <>
                      {editors.length > 1 && <DropdownMenuSeparator />}
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
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

        {dev?.url && devUp && (
          <Button
            variant="waPrimary"
            size="waSm"
            onClick={() => openUrl(dev.url!)}
          >
            Open {dev.url.replace('http://', '')}
          </Button>
        )}
      </div>

      {/* The repo's own one-shot scripts, on the page rather than two dropdown
          submenus deep. Every scan already collects these; nothing here was
          reachable in fewer than three clicks before. */}
      {scripts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <Play className="size-2.5 flex-none text-adaptive-400" />
          {/* One picker for the whole strip rather than a chevron per chip: eight
              scripts would be eight menus, and the manager is a property of the
              run you are about to do, not of any one script. Defaults to what the
              repo's own files say, and resets when you leave the page — an
              override is for "just this once". */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="waGhost"
                size="waXs"
                className="font-mono"
                title={
                  manager
                    ? `Running with ${manager}${detected ? ` instead of ${detected}` : ''}. Applies to Run, the scripts here and the package chores.`
                    : detected
                      ? `Running with ${detected} — from this repo's files, or your default`
                      : 'No package manager detected'
                }
              >
                {manager ?? detected ?? 'auto'}
                {manager && <span className="text-sev-warn">*</span>}
                <ChevronDown className="size-2.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem onClick={() => setManager(id, null)}>
                {detected ?? 'auto'}
                <span className="ml-auto text-[10px] text-adaptive-400">detected</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {MANAGERS.filter((m) => m !== detected).map((m) => (
                <DropdownMenuItem key={m} className="font-mono" onClick={() => setManager(id, m)}>
                  {m}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {scripts.map((s) => (
            <Button
              key={s}
              variant="waGhost"
              size="waXs"
              className="font-mono"
              title={`Run the "${s}" script with ${manager ?? detected}`}
              // The manager is stamped on by `useRunAction`, so every surface
              // that runs a script agrees without repeating it here.
              onClick={() => run({ kind: 'runScript', ref: repo, script: s })}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      {/* The ecosystem's own commands, one row per group. On the page rather than
          two submenus deep, for the same reason the scripts above are: this is the
          screen you are on when you want `pub get` or `clippy`, and the row menu is
          three clicks from here. */}
      {choreGroups.map(([group, items]) => (
        <div key={group} className="flex flex-wrap items-center gap-1">
          <span className="flex-none pr-0.5 text-[10px] font-semibold tracking-[0.05em] text-adaptive-400 uppercase">
            {group}
          </span>
          {items.map((c) => (
            <Button
              key={c.id}
              variant="waGhost"
              size="waXs"
              className={cn('font-mono', c.destructive && 'text-sev-warn')}
              title={
                c.destructive
                  ? `${c.label} — deletes build output or rewrites files, so it asks first`
                  : c.label
              }
              onClick={() => run({ kind: 'runChore', ref: repo, chore: c.id })}
            >
              {/* The group already names the tool, so the button drops it: a row of
                  "flutter pub get / flutter clean / flutter test" is mostly the word
                  "flutter". */}
              {stripTool(c.label, group)}
            </Button>
          ))}
        </div>
      ))}

      {/* The single-repo dialog, not the bulk one with n=1: that one has no branch
          list — only "each repo's default" or a typed name — and its copy is all
          plural. */}
      <RunCommandDialog
        open={runCmdOpen}
        onOpenChange={setRunCmdOpen}
        repo={repo}
        tasks={status?.runnable ?? []}
        initialTask={status?.primaryTask ?? null}
      />
      <CheckoutRepoDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        repo={repo}
        current={status?.branch ?? null}
      />
    </div>
  )
}
