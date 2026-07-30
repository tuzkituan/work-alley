import { useMemo } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel, StatusDot } from '@/components/wa/primitives'
import { useTerminalStore, type TermTab } from '@/stores/terminal-store'
import { useUiStore } from '@/stores/ui-store'
import { cn } from '@/lib/utils'
import { TerminalView } from './TerminalView'
import { useTermPalette } from './use-term-palette'

/**
 * The terminal for the machine pages — Toolbox and first-run setup.
 *
 * Those two are full-window pages with no output pane, so an install had nowhere
 * to show itself: root operations were thrown at whatever terminal emulator the
 * machine happened to have, and everything else streamed into a run log that is
 * only rendered on the workspace view. Both now open a `package` terminal
 * session, and this is where it appears.
 *
 * Filtered by kind rather than by scope: a repo's shell has no business on a page
 * that is about the machine, and a package install belongs to no repo.
 */
export function MachineTerminalDock() {
  const tabs = useTerminalStore((s) => s.tabs)
  const order = useTerminalStore((s) => s.order)
  const activeTermId = useTerminalStore((s) => s.activeTermId)
  const setActive = useTerminalStore((s) => s.setActive)
  const close = useTerminalStore((s) => s.close)
  const termFontSize = useUiStore((s) => s.termFontSize)
  // The output pane is not mounted on these pages, so the palette is this
  // component's job here.
  useTermPalette()

  const ids = useMemo(
    () => order.filter((id) => tabs.get(id)?.kind === 'package'),
    [order, tabs]
  )

  // The active tab when it is one of ours, else the newest: after an install the
  // interesting tab is always the one that just opened.
  const shownId = (activeTermId && ids.includes(activeTermId) ? activeTermId : ids.at(-1)) ?? null
  const shown = shownId ? tabs.get(shownId) : undefined

  // Nothing installed yet this session: the dock is not a placeholder, it is the
  // output of an operation, and an empty box would just cost the list height.
  if (!shownId || !shown) return null

  return (
    <div
      // Carved out of the page rather than sitting on it, under the neumorph skin.
      data-slot="terminal-dock"
      className="flex h-full min-h-0 flex-col border-t border-adaptive-200 bg-adaptive-50"
    >
      <div className="flex h-10 flex-none items-center gap-2 border-b border-adaptive-200 px-2.5">
        <SectionLabel>Terminal</SectionLabel>
        <span className="wa-num truncate font-mono text-[11px] text-adaptive-400">
          {statusLabel(shown)}
        </span>
        <div className="flex-1" />
        <span className="flex items-center rounded-sm border border-adaptive-200 font-mono text-[11px] text-adaptive-500">
          <button
            type="button"
            aria-label="Smaller terminal text"
            className="px-1.5 hover:text-adaptive-900"
            onClick={() => useUiStore.getState().setTermFontSize(termFontSize - 1)}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Larger terminal text"
            className="px-1.5 hover:text-adaptive-900"
            onClick={() => useUiStore.getState().setTermFontSize(termFontSize + 1)}
          >
            +
          </button>
        </span>
        <Button
          variant="waOutline"
          size="waXs"
          title={
            shown.status === 'live'
              ? 'Stop this command and close its terminal'
              : 'Close this terminal'
          }
          onClick={() => close(shown.termId)}
        >
          {shown.status === 'live' ? 'Kill' : 'Close'}
        </Button>
      </div>

      {/* One chip per session, and no "Log" chip: on these pages there is no run
          log to switch back to. Shown even for a single tab, so the command that
          is running is named somewhere. */}
      <div className="wa-scroll flex flex-none items-center gap-1 overflow-x-auto border-b border-adaptive-200 px-2.5 py-1.5">
        {ids.map((id) => {
          const t = tabs.get(id)
          if (!t) return null
          return (
            <span
              key={id}
              className={cn(
                'flex h-[22px] flex-none items-center gap-1.5 rounded-[5px] border pr-0.5 pl-1.5 font-mono text-[10.5px]',
                id === shownId
                  ? 'border-adaptive-400 bg-background text-adaptive-900'
                  : 'border-adaptive-200 text-adaptive-500 hover:border-adaptive-400'
              )}
            >
              <button
                type="button"
                onClick={() => setActive(id)}
                // Which chip is showing was expressed only through border colour,
                // which the skin collapses; this is the hook for its pressed state.
                aria-pressed={id === shownId}
                title={`${t.title} — ${t.argv.join(' ')}`}
                className="flex items-center gap-1.5"
              >
                <StatusDot tone={tone(t)} size={5} />
                <span className="max-w-40 truncate">{t.title}</span>
              </button>
              <button
                type="button"
                aria-label="Close this terminal"
                onClick={() => close(id)}
                className="flex size-3.5 flex-none items-center justify-center rounded-sm text-adaptive-400 hover:bg-adaptive-200 hover:text-adaptive-900"
              >
                <X className="size-2.5" />
              </button>
            </span>
          )
        })}
      </div>

      {/* `key` on the id, like the output pane: the xterm instance itself lives in
          xterm-instance.ts, so this only re-parents an existing DOM node. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalView key={shownId} termId={shownId} />
      </div>
    </div>
  )
}

/** Any live package session, so a page can keep the dock mounted while one runs. */
export function useHasMachineTerminals() {
  const tabs = useTerminalStore((s) => s.tabs)
  return useMemo(() => [...tabs.values()].some((t) => t.kind === 'package'), [tabs])
}

function statusLabel(t: TermTab): string {
  if (t.status === 'live') return 'running — this is a real terminal, type in it'
  return t.exitCode === 0 ? 'finished' : `exited with code ${t.exitCode ?? '?'}`
}

function tone(t: TermTab) {
  if (t.status === 'live') return 'info' as const
  return t.exitCode === 0 ? ('ok' as const) : ('warn' as const)
}
