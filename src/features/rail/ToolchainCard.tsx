import { useState } from 'react'
import { ChevronDown, TriangleAlert } from 'lucide-react'
import { SectionLabel } from '@/components/wa/primitives'
import type { Bootstrap, ToolInfo } from '@/domain/types'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui-store'

/**
 * The tools the app found, and the ones it did not.
 *
 * Every command this app runs is invoked by *absolute path* from this probe —
 * never through PATH — because a GUI-launched app inherits none of the shell
 * state a version manager lives in. So "which node is it actually using" is a
 * question with real consequences, and this card is the only place that answers
 * it: each row carries the resolved path in its tooltip.
 *
 * Three rows at rest, because the rail is 214px and this is pinned below a
 * scrolling list. It was five, and the other two were `gh` and a container
 * runtime reporting a version number every day of their lives — a card that is
 * always the same is a card you stop reading. The rest is one click away rather
 * than absent: a missing `gradle` is exactly what you want to see when a chore
 * fails, and hunting for it in the Toolbox is the long way round.
 *
 * "Three" is a floor, not a cap. Any of the five that is *missing* stays on the
 * card, because that is the one state worth the row — see `resting`.
 */
export function ToolchainCard({ boot }: { boot: Bootstrap | undefined }) {
  const [open, setOpen] = useState(false)
  const setPage = useUiStore((s) => s.setPage)

  const tools = boot?.tools ?? []
  const find = (n: string) => tools.find((t) => t.name === n)

  // Resolved by the backend, not re-derived here: the rule is the Settings choice
  // when it is installed, else the fastest that is, and a second copy of that
  // would eventually disagree about what is really being run.
  const pmName = boot?.packageManager ?? 'npm'
  const chosen = boot?.config.preferredPackageManager
  const docker = find('docker')
  const podman = find('podman')
  const runtime = docker?.path ? docker : podman

  // The five that decide whether this app can do anything at all: clone, run,
  // install, talk to GitHub, and start a container. The first three are the ones
  // nothing works without, which is why the resting list is cut there.
  const primary: { tool: ToolInfo | undefined; label: string; note?: string }[] = [
    { tool: find('git'), label: 'git' },
    { tool: find('node'), label: 'node' },
    {
      tool: find(pmName),
      label: pmName,
      note: chosen
        ? `Chosen in Settings${chosen !== pmName ? ` (${chosen} is not installed)` : ''}`
        : 'Detected — the fastest one installed',
    },
    { tool: find('gh'), label: 'gh' },
    { tool: runtime, label: runtime?.name ?? 'docker' },
  ]

  // `gh` and the container runtime earn their row only by being absent. Everything
  // present and past the cut moves under the chevron with the other 25.
  const RESTING = 3
  const resting = primary.filter((p, i) => i < RESTING || !p.tool?.path)

  const shown = new Set(resting.map((p) => p.label))
  const rest = tools
    .filter((t) => !shown.has(t.name))
    // Found first, then missing; alphabetical within each. A list that reshuffles
    // as tools appear is one you cannot learn the shape of.
    .sort(
      (a, b) => Number(!!b.path) - Number(!!a.path) || a.name.localeCompare(b.name)
    )

  const found = tools.filter((t) => t.path).length
  const warnings = boot?.warnings ?? []

  return (
    <div className="flex flex-none flex-col gap-[7px] rounded-lg border border-adaptive-200 bg-background p-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-left"
        title={open ? 'Show fewer tools' : `Show all ${tools.length} tools`}
      >
        <SectionLabel className="flex-1">Toolchain</SectionLabel>
        {!boot?.toolsReady ? (
          <span className="font-mono text-[10px] text-adaptive-400">probing…</span>
        ) : (
          <span className="wa-num font-mono text-[10px] text-adaptive-400">
            {found}/{tools.length}
          </span>
        )}
        <ChevronDown
          className={cn(
            'size-3 flex-none text-adaptive-400 transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      {resting.map((p) => (
        <ToolRow key={p.label} label={p.label} tool={p.tool} note={p.note} />
      ))}

      {/* Animated by grid rows rather than by height: the list is 23 rows and
          `height: auto` cannot be transitioned, so the alternative is measuring it
          in JS. `0fr -> 1fr` is the same effect with nothing to keep in sync.
          The inner element owns the overflow, or the rows spill while collapsed. */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-[7px] pt-[7px]">
            <span className="h-px bg-adaptive-200" />
            {rest.map((t) => (
              <ToolRow key={t.name} label={t.name} tool={t} />
            ))}
          </div>
        </div>
      </div>

      {/* The probe's own complaints — a shell that took too long, a tool that
          answered but not with a version. They explain an empty row above. */}
      {warnings.length > 0 && (
        <button
          type="button"
          onClick={() => setPage('setup')}
          title={warnings.join('\n')}
          className="flex items-center gap-1.5 text-left text-[10px] text-sev-warn hover:underline"
        >
          <TriangleAlert className="size-3 flex-none" />
          <span className="truncate">
            {warnings.length} probe warning{warnings.length === 1 ? '' : 's'}
          </span>
        </button>
      )}
    </div>
  )
}

function ToolRow({
  label,
  tool,
  note,
}: {
  label: string
  tool: ToolInfo | undefined
  note?: string
}) {
  const missing = !tool?.path
  return (
    <div
      className="flex justify-between text-xs"
      // The resolved path, which is the whole point of the probe: two `node`s on
      // a machine is the normal case, and this says which one won.
      title={[tool?.path ?? `${label} was not found on PATH`, note].filter(Boolean).join('\n')}
    >
      <span className={missing ? 'text-adaptive-400' : 'text-adaptive-500'}>{label}</span>
      <span
        className={cn(
          'wa-num truncate pl-2 font-mono',
          missing ? 'text-adaptive-400' : 'text-adaptive-800'
        )}
      >
        {tool?.path ? (tool.version ?? 'present') : 'not found'}
      </span>
    </div>
  )
}
