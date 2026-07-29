import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  ListChecks,
  RefreshCw,
  Terminal,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import type { PackageStatus } from '@/domain/types'

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

  const groups = useMemo(() => {
    const byGroup = new Map<string, PackageStatus[]>()
    for (const p of data ?? []) {
      const list = byGroup.get(p.package.group)
      if (list) list.push(p)
      else byGroup.set(p.package.group, [p])
    }
    return [...byGroup.entries()]
  }, [data])

  const installed = (data ?? []).filter((p) => p.installed).length
  const total = data?.length ?? 0

  return (
    <div className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
      {/* Capped and centred. Full-window rows stretched to ~2000px, leaving a dead
          gap between each tool's description and its buttons — the two things you
          need to read together ended up at opposite edges of the screen. */}
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3.5">
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
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} />
            Re-check
          </Button>
        </div>

        <p className="max-w-prose text-xs text-adaptive-500">
          Anything needing root opens a terminal so you can enter your password —
          a desktop app cannot ask for it. Everything else streams into the output
          pane. System packages use whichever manager this machine has.
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
        ) : (
          groups.map(([group, items]) => (
            <div key={group} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <SectionLabel>{group}</SectionLabel>
                <span className="wa-num font-mono text-[10px] text-adaptive-400">
                  {items.filter((i) => i.installed).length}/{items.length}
                </span>
                <span className="h-px flex-1 bg-adaptive-200" />
              </div>
              <div className="overflow-hidden rounded-lg border border-adaptive-200 bg-card">
                {items.map((p) => (
                  <PackageRow key={p.package.id} pkg={p} />
                ))}
              </div>
            </div>
          ))
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
}: {
  id: string
  label: string
  op: 'install' | 'upgrade'
  variant: 'waPrimary' | 'waOutline'
  icon?: React.ReactNode
  title: string
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
      <Button
        variant={variant}
        size="waXs"
        title={title}
        className="rounded-r-none"
        onClick={() => run({ kind: 'package', id, op })}
      >
        {icon}
        {label}
      </Button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            size="waXs"
            title="Choose a version"
            className="rounded-l-none border-l-0 px-1"
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

function PackageRow({ pkg }: { pkg: PackageStatus }) {
  const run = useRunAction()
  const { package: meta, installed, version, managerAvailable, path } = pkg

  return (
    // flex-wrap so a narrow panel stacks the actions under the name rather than
    // squeezing the description to nothing.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-adaptive-200 px-3 py-2.5 last:border-b-0">
      <span
        className={cn(
          'size-1.5 flex-none rounded-full',
          installed ? 'bg-sev-ok' : 'bg-adaptive-300'
        )}
      />

      <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium">{meta.label}</span>
          {installed && version && (
            <span className="wa-num font-mono text-[11px] text-adaptive-500">{version}</span>
          )}
          <span className="rounded-sm border border-adaptive-200 px-1 font-mono text-[10px] text-adaptive-400">
            {meta.manager}
          </span>
          {meta.needsRoot && (
            <span
              className="flex items-center gap-1 text-[10px] text-adaptive-400"
              title="Runs in a terminal for the password prompt"
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
          <span className="hidden items-center gap-1 text-[11px] text-sev-ok sm:flex">
            <Check className="size-3" />
            installed
          </span>
          <SplitAction
            id={meta.id}
            label="Upgrade"
            op="upgrade"
            variant="waOutline"
            title={`Upgrade ${meta.label}`}
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
