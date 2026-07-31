import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Layers } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import type { StackInfo } from '@/domain/types'

/**
 * Which languages and frameworks this machine is set up for.
 *
 * The Toolbox is 44 tools and Guided setup is a dozen steps, and most of both is
 * irrelevant to any one person: a web developer scrolls past kubectl, a Flutter
 * developer past NestJS. Filtering by what you actually work in is the difference
 * between a catalogue and a list of things to do.
 *
 * **Choosing nothing shows everything.** The empty set means "no opinion", never
 * "nothing" — a fresh machine must not open a Toolbox with eight rows in it. Only
 * an explicit choice narrows, and "Everything" is how you get back.
 *
 * Each row carries the two facts that make the question answerable: how many repos
 * in this workspace look like it, and how many of its tools are already installed.
 * "Flutter — 6 repos here" is a fact; "Flutter" is a quiz.
 */
export function StackPicker() {
  const qc = useQueryClient()
  const { data: stacks, isPending } = useQuery({
    queryKey: keys.stacks,
    queryFn: () => api.listStacks(),
    staleTime: 30_000,
  })

  const save = useMutation({
    mutationFn: (ids: string[]) => api.setConfig({ stacks: ids }),
    // Applied to the cache before the round trip. Without it a tick took as long as
    // a config write plus a re-read, and ticking three boxes felt like the app had
    // stopped — the checkbox is a statement of intent, not a report from the disk.
    onMutate: (ids) => {
      const previous = qc.getQueryData<StackInfo[]>(keys.stacks)
      qc.setQueryData<StackInfo[]>(keys.stacks, (old) =>
        (old ?? []).map((s) => ({ ...s, chosen: ids.includes(s.id) }))
      )
      return { previous }
    },
    onError: (e: Error, _ids, ctx) => {
      // Put the ticks back: the optimistic state was a claim about what the config
      // now says, and it turned out not to.
      if (ctx?.previous) qc.setQueryData(keys.stacks, ctx.previous)
      toast.error('Could not save that', { description: e.message })
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.config }),
  })

  /**
   * The expensive half, deferred to when the menu closes.
   *
   * `list_packages` probes every tool in the catalog and `list_setup_plan` probes
   * again and reads git config, so invalidating both on each tick meant three
   * backend round trips per checkbox — with a menu open, over a list the user is
   * still editing. Nothing behind the menu is visible while it is open, so there is
   * nothing to keep current until it is not.
   */
  const commit = (open: boolean) => {
    if (open || !save.isSuccess) return
    // `reset`, not `invalidate`: this changes *which rows exist*, and refetching in
    // place leaves the old list on screen — a Flutter machine still reading kubectl
    // — until the probe returns, then swaps it silently. Resetting drops the data,
    // so both pages fall back to the skeleton they already render while pending,
    // which is the honest picture: this list is being worked out again.
    for (const key of [keys.packages, keys.setupPlan, keys.stacks]) {
      void qc.resetQueries({ queryKey: key })
    }
    save.reset()
  }

  const chosen = useMemo(() => (stacks ?? []).filter((s) => s.chosen).map((s) => s.id), [stacks])
  const byFamily = useMemo(() => groupByFamily(stacks ?? []), [stacks])

  const toggle = (id: string, on: boolean) =>
    save.mutate(on ? [...chosen, id] : chosen.filter((x) => x !== id))

  const label =
    chosen.length === 0
      ? 'All stacks'
      : chosen.length === 1
        ? (stacks?.find((s) => s.id === chosen[0])?.label ?? '1 stack')
        : `${chosen.length} stacks`

  return (
    <DropdownMenu onOpenChange={commit}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="waOutline"
          size="waXs"
          title="Which languages and frameworks to show tools and setup steps for"
        >
          <Layers className={cn('size-3', save.isPending && 'animate-pulse')} />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="wa-scroll max-h-[70vh] w-72 overflow-y-auto">
        {/* The list is one IPC call away on first open, and an empty menu that
            grows is worse than a menu that says it is coming. */}
        {isPending &&
          [0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="px-2 py-1.5">
              <Skeleton className="h-3.5 w-full" />
            </div>
          ))}
        {byFamily.map(([family, items]) => (
          <div key={family}>
            <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
              {family}
            </DropdownMenuLabel>
            {items.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.id}
                checked={s.chosen}
                // Kept open: picking three stacks is one gesture, not three trips
                // back to the trigger.
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => toggle(s.id, on)}
                title={s.hint}
              >
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {/* The two facts, in the order they matter: what is here, then what
                    is installed for it. */}
                {s.repos > 0 && (
                  <span className="ml-auto flex-none font-mono text-[10px] text-primary-600">
                    {s.repos} here
                  </span>
                )}
                {s.repos === 0 && s.toolsTotal > 0 && (
                  <span className="ml-auto flex-none font-mono text-[10px] text-adaptive-400">
                    {s.toolsInstalled}/{s.toolsTotal}
                  </span>
                )}
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => save.mutate([])}>
          Everything
          <span className="ml-auto text-[10px] text-adaptive-400">no filter</span>
        </DropdownMenuItem>
        {/* One click for the common case, and the only one that uses the scan: the
            stacks this workspace is actually made of. */}
        <DropdownMenuItem
          disabled={!stacks?.some((s) => s.repos > 0)}
          onClick={() =>
            save.mutate((stacks ?? []).filter((s) => s.repos > 0).map((s) => s.id))
          }
        >
          Just what is in this folder
          <span className="ml-auto text-[10px] text-adaptive-400">
            {(stacks ?? []).filter((s) => s.repos > 0).length}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Grouped, in the backend's order — which is the order the registry declares. */
function groupByFamily(stacks: StackInfo[]): [string, StackInfo[]][] {
  const out = new Map<string, StackInfo[]>()
  for (const s of stacks) {
    const list = out.get(s.familyLabel)
    if (list) list.push(s)
    else out.set(s.familyLabel, [s])
  }
  return [...out]
}
