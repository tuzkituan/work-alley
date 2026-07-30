import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, GitBranch, Play, SquareTerminal } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { keys } from '@/queries/keys'
import { useRunAction } from '@/hooks/use-action'
import { CheckoutAllDialog } from '@/features/actions/CheckoutAllDialog'
import type { useDetailRepo } from './use-detail-repo'

/** The always-visible actions. Everything rarer stays in the RepoMenu above. */
export function RepoActionBar({ ctx }: { ctx: ReturnType<typeof useDetailRepo> }) {
  const run = useRunAction()
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const { repo, dev, sb, devUp, hasStorybook, scripts, ahead } = ctx

  // From the bootstrap cache, so this costs nothing — the same trick RepoMenu uses.
  const { data: boot } = useQuery({ queryKey: keys.bootstrap, enabled: false })
  const editors = (boot as { editors?: { id: string; label: string }[] } | undefined)?.editors ?? []

  return (
    <div className="flex flex-col gap-1.5 border-t border-adaptive-200 pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="waOutline"
          size="waSm"
          title="Open a shell in this repo"
          onClick={() => run({ kind: 'openShell', ref: repo })}
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
        {/* The same dialog the folder header uses, with this repo as the only
            target: it is the one path that takes a branch *name*, so the detail page
            no longer needs the Branches tab just to switch to something typed. */}
        <Button
          variant="waOutline"
          size="waSm"
          title="Check out a branch in this repo"
          onClick={() => setCheckoutOpen(true)}
        >
          <GitBranch className="size-3" />
          Checkout
        </Button>
        <Button
          variant={devUp ? 'waDanger' : 'waOutline'}
          size="waSm"
          onClick={() => run({ kind: devUp ? 'devStop' : 'devStart', ref: repo, task: 'dev' })}
        >
          {devUp ? `Stop dev${dev?.port ? ` :${dev.port}` : ''}` : 'Start dev'}
        </Button>
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
              className={editors.length > 1 ? 'rounded-r-none' : undefined}
              title={`Open this repo in ${editors[0]!.label}`}
              onClick={() => run({ kind: 'openInEditor', ref: repo, editor: editors[0]!.id })}
            >
              {editors[0]!.label}
            </Button>
            {editors.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="waOutline"
                    size="waSm"
                    className="rounded-l-none border-l-0 px-1"
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
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

        {dev?.url && devUp && (
          <Button
            variant="waPrimary"
            size="waSm"
            onClick={() => void openUrl(dev.url!).catch(() => {})}
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
          {scripts.map((s) => (
            <Button
              key={s}
              variant="waGhost"
              size="waXs"
              className="font-mono"
              title={`Run the "${s}" script`}
              onClick={() => run({ kind: 'runScript', ref: repo, script: s })}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      <CheckoutAllDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        repos={[repo]}
        scopeLabel={repo.name}
      />
    </div>
  )
}
