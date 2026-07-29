import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Check, Download, RefreshCw, Terminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SectionLabel } from '@/components/wa/primitives'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'
import type { PackageStatus } from '@/domain/types'

/**
 * Install / upgrade / remove developer tooling.
 *
 * Deliberately a curated list rather than a package browser: the value is knowing
 * which tools this workspace needs and having one obvious way to get each.
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
      <div className="flex flex-col gap-3.5">
        <div className="flex items-center gap-2">
          <Button variant="waGhost" size="waIcon" onClick={() => setPage('repos')} title="Back">
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold tracking-[-0.01em]">Toolbox</h1>
          {total > 0 && (
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {installed}/{total} installed
            </span>
          )}
          <div className="flex-1" />
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

        <p className="text-xs text-adaptive-500">
          System packages open a terminal so you can enter your password — a desktop
          app cannot ask for root. Everything else streams into the output pane.
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

function PackageRow({ pkg }: { pkg: PackageStatus }) {
  const run = useRunAction()
  const { package: meta, installed, version, managerAvailable, path } = pkg

  return (
    <div className="flex items-center gap-3 border-b border-adaptive-200 px-3 py-2.5 last:border-b-0">
      <span
        className={cn(
          'size-1.5 flex-none rounded-full',
          installed ? 'bg-sev-ok' : 'bg-adaptive-300'
        )}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
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
        <span className="flex-none text-[11px] text-sev-warn" title={`${meta.manager} is missing`}>
          {meta.manager} missing
        </span>
      ) : installed ? (
        <div className="flex flex-none items-center gap-1.5">
          <span className="flex items-center gap-1 text-[11px] text-sev-ok">
            <Check className="size-3" />
            installed
          </span>
          <Button
            variant="waOutline"
            size="waXs"
            onClick={() => run({ kind: 'package', id: meta.id, op: 'upgrade' })}
          >
            Upgrade
          </Button>
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
        <Button
          variant="waPrimary"
          size="waXs"
          className="flex-none"
          onClick={() => run({ kind: 'package', id: meta.id, op: 'install' })}
        >
          <Download className="size-3" />
          Install
        </Button>
      )}
    </div>
  )
}
