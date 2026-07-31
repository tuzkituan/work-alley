import { ChevronDown, Hammer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { buildTarget, choresByGroup } from '@/domain/severity'
import type { RepoRef, RepoStatus } from '@/domain/types'
import { useRunAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'

/**
 * Build, with everything else this repo can run behind a chevron.
 *
 * Build alone was one detected command out of a dozen the scan already collects —
 * `lint`, `typecheck`, `cargo clippy`, `pub get` — and reaching any of the others
 * from a row meant the ⋯ menu and two submenus. Same split-button shape as Run's
 * version picker, for the same reason: the common case is one click and the rest
 * is one more.
 *
 * When a repo has no build step the primary half is dropped and the chevron
 * carries a hammer, so the control still says what it is. When there is neither a
 * build nor anything to run, nothing renders — an empty menu is worse than a
 * missing one.
 */
export function BuildMenu({
  repo,
  status,
  /** Icon only, for the list row — 113 rows do not need the word 113 times. */
  iconOnly = false,
  /** `waXs` in a list row, `waSm` on a card. */
  size = 'waXs',
}: {
  repo: RepoRef
  status: RepoStatus | undefined
  iconOnly?: boolean
  size?: 'waXs' | 'waSm'
}) {
  const run = useRunAction()
  const build = buildTarget(status)

  // Whatever Build itself runs is not repeated in its own menu.
  const builtScript = status?.primaryBuild?.kind === 'script' ? status.primaryBuild.name : null
  const builtChore = status?.primaryBuild?.kind === 'chore' ? status.primaryBuild.id : null
  const scripts = (status?.availableScripts ?? []).filter((s) => s !== builtScript)
  const choreGroups = choresByGroup(status)
    .map(([group, items]) => [group, items.filter((c) => c.id !== builtChore)] as const)
    .filter(([, items]) => items.length > 0)

  const hasMenu = scripts.length > 0 || choreGroups.length > 0
  if (!build && !hasMenu) return null

  return (
    <div className="flex flex-none items-center">
      {build && (
        <Button
          variant="waOutline"
          size={size}
          className="shrink-0"
          data-split={hasMenu ? 'left' : undefined}
          title={`Runs ${build.label}`}
          aria-label={`Build with ${build.label}`}
          onClick={(e) => {
            e.stopPropagation()
            run(build.spec(repo))
          }}
        >
          <Hammer className="size-3" />
          {!iconOnly && <span>Build</span>}
        </Button>
      )}

      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="waOutline"
              size={size}
              className="shrink-0 px-1"
              data-split={build ? 'right' : undefined}
              title="Scripts and commands in this repo"
              aria-label="Scripts and commands"
              onClick={(e) => e.stopPropagation()}
            >
              {!build && <Hammer className="size-3" />}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-96 w-56 overflow-y-auto">
            {scripts.length > 0 && (
              <>
                <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
                  Scripts
                </DropdownMenuLabel>
                {scripts.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    className="font-mono text-[11.5px]"
                    onClick={() => run({ kind: 'runScript', ref: repo, script: s })}
                  >
                    {s}
                  </DropdownMenuItem>
                ))}
              </>
            )}

            {/* One labelled block per ecosystem rather than a submenu each: this
                menu is already one level deep, and a React Native repo offers four
                groups at once. */}
            {choreGroups.map(([group, items], i) => (
              <div key={group}>
                {(i > 0 || scripts.length > 0) && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
                  {group}
                </DropdownMenuLabel>
                {items.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    className={cn('font-mono text-[11.5px]', c.destructive && 'text-sev-warn')}
                    title={
                      c.destructive
                        ? `${c.label} — deletes build output or rewrites files, so it asks first`
                        : c.label
                    }
                    onClick={() => run({ kind: 'runChore', ref: repo, chore: c.id })}
                  >
                    {c.label}
                  </DropdownMenuItem>
                ))}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
