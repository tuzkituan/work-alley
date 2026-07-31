import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StackPicker } from '@/features/stacks/StackPicker'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { SectionLabel } from '@/components/wa/primitives'
import { useUiStore } from '@/stores/ui-store'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { useRunAction } from '@/hooks/use-action'
import type { PackageStatus, PackageUpdate } from '@/domain/types'

/**
 * Install / upgrade / remove developer tooling.
 *
 * Deliberately a curated list rather than a package browser: the value is knowing
 * which tools a working repo needs and having one obvious way to get each.
 *
 * Not scoped to a workspace — it describes this machine, so it is a full-window
 * page that works before any folder has been opened.
 */
export function Toolbox({ toolsReady }: { toolsReady: boolean }) {
  const setPage = useUiStore((s) => s.setPage)
  const { data, isPending, isFetching, refetch } = useQuery({
    queryKey: keys.packages,
    queryFn: () => api.listPackages(),
    // Detection resolves paths through the toolchain, so querying before the probe
    // finishes reports installed tools as missing. Waiting is the whole fix.
    enabled: toolsReady,
    // Probing ~25 binaries for versions is cheap but not free.
    staleTime: 30_000,
  })

  // The slow half, and a separate query for exactly that reason: this one asks
  // mirrors and registries, so the list renders first and the "newer version"
  // answers fold in when they arrive. A failure here leaves every row exactly as
  // it was before — see `checked` below.
  const updates = useQuery({
    queryKey: keys.packageUpdates,
    queryFn: () => api.checkPackageUpdates(),
    enabled: toolsReady,
    // Mirrors publish on the order of days; re-asking on every visit would spend
    // seconds to learn nothing.
    staleTime: 10 * 60_000,
  })

  // Still waiting on the first answer. Distinct from `!checked`, which means the
  // answer arrived and was "could not ask" — the rows look the same in the data
  // and mean opposite things to someone deciding whether to click Upgrade.
  const checking = updates.isFetching && !updates.data

  // Only ids the backend actually managed to ask about get a definitive "up to
  // date". Everything else keeps its Upgrade button, because an unreachable
  // registry is not evidence that a tool is current.
  const checked = useMemo(
    () => new Set(updates.data?.checked ?? []),
    [updates.data]
  )
  const outdated = useMemo(
    () => new Map((updates.data?.updates ?? []).map((u) => [u.id, u])),
    [updates.data]
  )

  const [query, setQuery] = useState('')

  // Matched against id and manager as well as the label: people look for "podman"
  // by name, but also ask "what does dnf install here" — and the id is what the
  // description sometimes omits.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return data ?? []
    return (data ?? []).filter(({ package: m }) =>
      [m.label, m.id, m.description, m.manager, m.group].some((f) =>
        f.toLowerCase().includes(q)
      )
    )
  }, [data, query])

  const groups = useMemo(() => {
    const byGroup = new Map<string, PackageStatus[]>()
    for (const p of matches) {
      const list = byGroup.get(p.package.group)
      if (list) list.push(p)
      else byGroup.set(p.package.group, [p])
    }
    return [...byGroup.entries()]
  }, [matches])

  const installed = (data ?? []).filter((p) => p.installed).length
  const total = data?.length ?? 0
  const filtering = query.trim().length > 0
  // Counted against the list rather than taken from the report's length: a tool
  // that has since been removed should not be advertised as upgradable.
  const upgradable = (data ?? []).filter(
    (p) => p.installed && outdated.has(p.package.id)
  ).length

  return (
    <div className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
      {/* One centred column. The page was multi-column to fit 50 rows on a wide
          screen, but that made the reading order snake down and back up, and each
          group's width changed with the window. A single 64rem column keeps every
          tool's description and its buttons a readable distance apart, and the list
          in one order. */}
      <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-3.5">
        <div className="flex items-center gap-2">
          {/* A full-window page, so it needs its own way out. */}
          <Button
            variant="waGhost"
            size="waIcon"
            onClick={() => setPage('repos')}
            title="Back to the workspace"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold tracking-[-0.01em]">Toolbox</h1>
          {total > 0 && (
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {installed}/{total} installed
            </span>
          )}
          {/* Only ever a count of real answers: while the check is still running,
              or if it failed, there is nothing here rather than a reassuring 0. */}
          {upgradable > 0 && (
            <span className="rounded-sm border border-sev-warn/40 px-1.5 py-px font-mono text-[10px] text-sev-warn">
              {upgradable} {upgradable === 1 ? 'update' : 'updates'}
            </span>
          )}
          {updates.isFetching && (
            <span className="text-[11px] text-adaptive-400">checking for updates…</span>
          )}
          {/* Before the search field: it decides what the list *is*, where the
              field only narrows what is already there. */}
          <StackPicker />
          {/* In the header row at a fixed width, not full-bleed on its own line: a
              field the width of a 2000px window reads as the page's subject rather
              than as a filter, and the query is never more than a word. */}
          <div className="relative ml-1 w-[17rem] flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-adaptive-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // Escape clears rather than blurs: the field holds the only state on
              // this page, so getting back to the full list is the useful escape.
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('')
              }}
              placeholder="Filter tools…"
              aria-label="Filter tools by name, manager or description"
              className="h-[30px] pr-7 pl-7 text-xs"
            />
            {filtering && (
              <button
                type="button"
                onClick={() => setQuery('')}
                title="Clear the filter"
                aria-label="Clear the filter"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 text-adaptive-400 hover:bg-adaptive-200 hover:text-adaptive-800"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          {filtering && (
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {matches.length} of {total}
            </span>
          )}

          <div className="flex-1" />
          {/* A list of 50 rows is the wrong first screen on a machine with nothing
              on it — that needs an order, which the setup page is. */}
          <Button
            variant="waOutline"
            size="waXs"
            onClick={() => setPage('setup')}
            title="The ordered path for a machine with nothing on it"
          >
            <ListChecks className="size-3" />
            Guided setup
          </Button>
          <Button
            variant="waOutline"
            size="waXs"
            disabled={isFetching || updates.isFetching}
            // Both halves: "re-check" means the whole picture, and the version
            // answers are the half most likely to have gone stale.
            onClick={() => {
              void refetch()
              void updates.refetch()
            }}
          >
            <RefreshCw
              className={cn('size-3', (isFetching || updates.isFetching) && 'animate-spin')}
            />
            Re-check
          </Button>
        </div>

        <p className="max-w-prose text-xs text-adaptive-500">
          Every operation runs in a terminal at the bottom of this page, which is
          also where you type your password when something needs root — a desktop
          app cannot ask for it. System packages use whichever manager this machine
          has.
        </p>

        {!toolsReady ? (
          <div className="rounded-lg border border-adaptive-200 bg-card p-4 text-xs text-adaptive-500">
            Resolving your toolchain…
          </div>
        ) : isPending ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-lg border border-adaptive-200 bg-card p-4 text-xs text-adaptive-500">
            Nothing matches “{query.trim()}”. The Toolbox is a curated list, so a
            tool that is not here has to be installed by hand.
          </div>
        ) : (
          // One column, in group order. `break-inside-avoid` below is left on the
          // group cards deliberately: it costs nothing here and is what this needs
          // again if the page is ever widened back out.
          <div className="flex flex-col">
            {groups.map(([group, items]) => (
              // break-inside-avoid: a group card split across a column boundary
              // would put half its rows at the top of the next column.
              <div key={group} className="mb-3.5 flex break-inside-avoid flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <SectionLabel>{group}</SectionLabel>
                  <span className="wa-num font-mono text-[10px] text-adaptive-400">
                    {items.filter((i) => i.installed).length}/{items.length}
                  </span>
                  <span className="h-px flex-1 bg-adaptive-200" />
                </div>
                <div className="overflow-hidden rounded-lg border border-adaptive-200 bg-card">
                  {items.map((p) => (
                    <PackageRow
                      key={p.package.id}
                      pkg={p}
                      update={outdated.get(p.package.id)}
                      checked={checked.has(p.package.id)}
                      pending={checking}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * An action button with a version menu beside it.
 *
 * The plain button installs whatever the manager considers current, which is what
 * almost everyone wants; the chevron is there for the cases where it matters —
 * matching a project's Node version, or holding a tool back.
 *
 * Versions are fetched only when the menu is opened. Listing them costs a registry
 * round trip per tool, and doing that for 45 rows on page load would be absurd.
 */
function SplitAction({
  id,
  label,
  op,
  variant,
  icon,
  title,
  menuOnly,
}: {
  id: string
  label: string
  op: 'install' | 'upgrade'
  variant: 'waPrimary' | 'waOutline'
  icon?: React.ReactNode
  title: string
  /**
   * Drops the main button and keeps the version menu. Used for a tool that is
   * already current: there is nothing to upgrade to, but pinning a specific
   * version is still a thing people do.
   */
  menuOnly?: boolean
}) {
  const run = useRunAction()
  const [menuOpen, setMenuOpen] = useState(false)

  const { data: versions, isPending } = useQuery({
    queryKey: keys.packageVersions(id),
    queryFn: () => api.listPackageVersions(id),
    enabled: menuOpen,
    // Published versions do not change minute to minute.
    staleTime: 5 * 60_000,
  })

  return (
    <div className="flex flex-none items-center">
      {!menuOnly && (
        <Button
          variant={variant}
          size="waXs"
          title={title}
          data-split="left"
          onClick={() => run({ kind: 'package', id, op })}
        >
          {icon}
          {label}
        </Button>
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            size="waXs"
            title={menuOnly ? title : 'Choose a version'}
            data-split={menuOnly ? undefined : 'right'}
            className="px-1"
          >
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
          <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
            Version
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => run({ kind: 'package', id, op })}>
            Current
            <span className="ml-auto text-[10px] text-adaptive-400">default</span>
          </DropdownMenuItem>

          {isPending && (
            <div className="px-2 py-1.5 text-[11px] text-adaptive-400">Looking up versions…</div>
          )}
          {!isPending && (versions?.length ?? 0) === 0 && (
            // Honest about why, rather than an empty menu: pacman and apk carry one
            // version at a time, and bun upgrades itself.
            <div className="px-2 py-1.5 text-[11px] text-adaptive-400">
              This manager installs one version only.
            </div>
          )}
          {(versions?.length ?? 0) > 0 && <DropdownMenuSeparator />}
          {versions?.map((v) => (
            <DropdownMenuItem
              key={v.value}
              className="font-mono text-xs"
              onClick={() => run({ kind: 'package', id, op, version: v.value })}
            >
              <span className="truncate">{v.label}</span>
              {v.note && (
                <span className="ml-auto flex-none text-[10px] text-sev-ok">{v.note}</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * @param update  The newer version this tool's manager reports, if any.
 * @param checked Whether the manager could be asked at all. Without it there is no
 *                difference between "current" and "we do not know", and rendering
 *                the second as the first would quietly hide a real upgrade.
 * @param pending The check is still in flight. A third state, and it has to be: it
 *                is indistinguishable from `!checked` in the data, but one of them
 *                is about to resolve and the other never will.
 */
function PackageRow({
  pkg,
  update,
  checked,
  pending,
}: {
  pkg: PackageStatus
  update?: PackageUpdate
  checked: boolean
  pending: boolean
}) {
  const run = useRunAction()
  const { package: meta, installed, version, managerAvailable, path } = pkg
  const upToDate = installed && checked && !update

  return (
    // flex-wrap so a narrow panel stacks the actions under the name rather than
    // squeezing the description to nothing.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-adaptive-200 px-3 py-2.5 last:border-b-0">
      <span
        className={cn(
          'size-1.5 flex-none rounded-full',
          // Amber for behind, so a row needing attention is findable by scanning
          // the left edge rather than by reading every version. Grey while the
          // check runs: green would be a claim nobody has verified yet.
          installed && !pending ? (update ? 'bg-sev-warn' : 'bg-sev-ok') : 'bg-adaptive-300'
        )}
        title={pending ? 'Checking for a newer version…' : undefined}
      />

      <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium">{meta.label}</span>
          {installed && version && (
            <span className="wa-num font-mono text-[11px] text-adaptive-500">{version}</span>
          )}
          {/* The new version next to the installed one, so the row answers "how far
              behind am I" without opening a menu. */}
          {installed && update?.latest && (
            <span
              className="wa-num font-mono text-[11px] text-sev-warn"
              title={`${meta.manager} has ${update.latest}`}
            >
              → {update.latest}
            </span>
          )}
          <span className="rounded-sm border border-adaptive-200 px-1 font-mono text-[10px] text-adaptive-400">
            {meta.manager}
          </span>
          {meta.needsRoot && (
            <span
              className="flex items-center gap-1 text-[10px] text-adaptive-400"
              title="Runs in the terminal below, where you can enter your password"
            >
              <Terminal className="size-2.5" />
              root
            </span>
          )}
        </div>
        <span className="truncate text-[11.5px] text-adaptive-500" title={path ?? undefined}>
          {meta.description}
        </span>
      </div>

      {!managerAvailable ? (
        <span
          className="flex-none text-[11px] text-sev-warn"
          title={`Not available through ${meta.manager} on this machine`}
        >
          unavailable
        </span>
      ) : installed ? (
        <div className="flex flex-none items-center gap-1.5">
          {pending ? (
            // Said per row, not only in the page header: the row is where the
            // answer will appear, and "installed" in green next to an Upgrade
            // button reads as a verdict rather than as a question still open.
            <span className="hidden items-center gap-1 text-[11px] text-adaptive-400 sm:flex">
              <Loader2 className="size-3 animate-spin" />
              checking…
            </span>
          ) : (
            <span
              className={cn(
                'hidden items-center gap-1 text-[11px] sm:flex',
                upToDate ? 'text-adaptive-400' : 'text-sev-ok'
              )}
            >
              <Check className="size-3" />
              {upToDate ? 'up to date' : 'installed'}
            </span>
          )}
          {/* The point of the check: Upgrade is offered when there is something to
              upgrade to, or when the manager could not be asked — never as a button
              that reinstalls the version already on disk. A tool that is current
              keeps only the version menu, since pinning is still worth doing. */}
          <SplitAction
            id={meta.id}
            label="Upgrade"
            op="upgrade"
            variant={update ? 'waPrimary' : 'waOutline'}
            icon={update ? <ArrowUp className="size-3" /> : undefined}
            menuOnly={upToDate}
            title={
              update
                ? `Upgrade ${meta.label}${update.latest ? ` to ${update.latest}` : ''}`
                : upToDate
                  ? `${meta.label} is current — install a specific version`
                  : `Upgrade ${meta.label}`
            }
          />
          {meta.removable && (
            <Button
              variant="waDanger"
              size="waIcon"
              title={`Remove ${meta.label}`}
              onClick={() => run({ kind: 'package', id: meta.id, op: 'remove' })}
            >
              <Trash2 className="size-3" />
            </Button>
          )}
        </div>
      ) : (
        <SplitAction
          id={meta.id}
          label="Install"
          op="install"
          variant="waPrimary"
          icon={<Download className="size-3" />}
          title={`Install ${meta.label}`}
        />
      )}
    </div>
  )
}
