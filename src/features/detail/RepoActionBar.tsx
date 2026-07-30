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
import { cn } from '@/lib/utils'
import type { useDetailRepo } from './use-detail-repo'

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
  const { repo, dev, sb, devUp, target, hasStorybook, scripts, choreGroups, ahead } = ctx

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
          disabled={!target.id}
          title={!target.id ? 'Nothing to run in this repo' : undefined}
          onClick={() => {
            if (!target.id) return
            run({ kind: devUp ? 'devStop' : 'devStart', ref: repo, task: target.id })
          }}
        >
          {devUp
            ? `Stop ${target.label}${dev?.port ? ` :${dev.port}` : ''}`
            : `Start ${target.label}`}
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

      <CheckoutAllDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        repos={[repo]}
        scopeLabel={repo.name}
      />
    </div>
  )
}
