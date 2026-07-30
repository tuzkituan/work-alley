import { Logs, Plus, Terminal, X } from 'lucide-react'
import { StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import { TONE_TINT } from '@/domain/severity'
import { isShown, type OutputTab, type OutputView } from './output-view'

/**
 * Everything the pane can show, as chips.
 *
 * There used to be three selector surfaces — a `Log` chip, a strip of terminal
 * chips, and a second strip of run chips that appeared only with two or more runs
 * and vanished whenever a terminal was showing. So a single run had no chip at all,
 * and switching to a shell hid every run.
 *
 * The two classes are deliberately unmistakable, because they were previously
 * identical in every respect — same geometry, same border, same 5px dot, and the
 * same blue for "live shell" as for "running command":
 *
 *   run log      square, a Logs glyph, dot BLINKS while running
 *   terminal     pill,   a Terminal glyph, dot always steady
 *
 * Blinking means work is happening on its own; steady means it is waiting for you.
 *
 * Deliberately not <Tabs> from components/ui. Radix unmounts TabsContent on switch,
 * which would destroy the xterm instance; forceMount instead gives a display:none
 * box, so fit() measures 0x0 and the geometry comes back wrong on re-show. A plain
 * strip plus a conditional render, backed by the module cache in xterm-instance.ts,
 * is both simpler and correct. Do not "fix" this into <Tabs>.
 */
export function TabStrip({
  runTabs,
  termTabs,
  shown,
  scopeLabel,
  onSelect,
  onClose,
  onNewTerminal,
}: {
  runTabs: OutputTab[]
  termTabs: OutputTab[]
  shown: OutputView | null
  scopeLabel: string
  onSelect: (view: OutputView) => void
  onClose: (view: OutputView) => void
  onNewTerminal: () => void
}) {
  return (
    <div className="flex flex-none items-start border-b border-adaptive-200">
      {/* Wraps, up to three rows, then scrolls vertically.
          A single horizontal row meant that past four or five tabs the rest were
          simply off-screen behind a sideways scroll nobody thinks to try. Three rows
          is the cap because the pane's real job is below this. */}
      <div className="wa-scroll wa-tabwrap flex min-w-0 flex-1 flex-wrap content-start items-center gap-1 overflow-y-auto px-2.5 py-1.5">
        {runTabs.map((t) => (
          <Chip
            key={`run:${t.view.id}`}
            tab={t}
            shown={shown}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}

        {/* A hairline, so the two groups read as two kinds of thing even at a
            glance and even when one group has a single member. */}
        {runTabs.length > 0 && termTabs.length > 0 && (
          <span className="mx-0.5 h-4 w-px flex-none bg-adaptive-200" />
        )}

        {termTabs.map((t) => (
          <Chip
            key={`term:${t.view.id}`}
            tab={t}
            shown={shown}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}

        {runTabs.length === 0 && termTabs.length === 0 && (
          <span className="font-mono text-[10.5px] text-adaptive-400">nothing here yet</span>
        )}
      </div>

      {/* Outside the scroller, not inside it: with four terminals open the + used to
          scroll out of reach, and the one control that creates a tab has to stay
          reachable. */}
      <button
        type="button"
        aria-label={`New terminal in ${scopeLabel}`}
        title={`New terminal in ${scopeLabel}`}
        onClick={onNewTerminal}
        className="mt-1.5 mr-2.5 flex size-[22px] flex-none items-center justify-center rounded-full border border-adaptive-200 text-adaptive-400 hover:border-adaptive-400 hover:text-adaptive-900"
      >
        <Plus className="size-3" />
      </button>
    </div>
  )
}

function Chip({
  tab,
  shown,
  onSelect,
  onClose,
}: {
  tab: OutputTab
  shown: OutputView | null
  onSelect: (view: OutputView) => void
  onClose: (view: OutputView) => void
}) {
  const active = isShown(tab, shown)
  const isTerm = tab.view.kind === 'term'
  const Glyph = isTerm ? Terminal : Logs

  return (
    <span
      className={cn(
        'flex h-[22px] flex-none items-center gap-1.5 border pl-1.5 font-mono text-[10.5px]',
        tab.closable ? 'pr-0.5' : 'pr-1.5',
        // Shape is the primary signal, because it survives colour blindness, a dark
        // theme and a 260px pane.
        isTerm ? 'rounded-full' : 'rounded-[5px]',
        active
          ? isTerm
            ? cn('text-adaptive-900', TONE_TINT[tab.tone])
            : 'border-adaptive-400 bg-background text-adaptive-900'
          : 'border-adaptive-200 text-adaptive-500 hover:border-adaptive-400'
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(tab.view)}
        title={tab.title}
        className="flex min-w-0 items-center gap-1.5"
      >
        <StatusDot
          tone={tab.tone}
          size={5}
          // The rule: only work happening on its own animates.
          style={tab.blink ? { animation: 'wa-blink 1.4s step-end infinite' } : undefined}
        />
        <Glyph className="size-2.5 flex-none text-adaptive-400" />
        {/* The open tab gets room to be read; the rest stay tight so several fit.
            A uniform cap ellipsed the one you were actually looking at. */}
        <span className={cn('truncate', active ? 'max-w-56' : 'max-w-32')}>{tab.label}</span>
        {/* The repo count for a bulk run. Never hidden at any width — it is the
            answer to "how many repos is this touching". */}
        {tab.detail && <span className="flex-none text-adaptive-400">{tab.detail}</span>}
        <span className="wa-o-age wa-num flex-none text-adaptive-400">{tab.age}</span>
      </button>
      {tab.closable && (
        <button
          type="button"
          aria-label={isTerm ? 'Close this terminal' : 'Dismiss this run'}
          onClick={() => onClose(tab.view)}
          className="flex size-3.5 flex-none items-center justify-center rounded-sm text-adaptive-400 hover:bg-adaptive-200 hover:text-adaptive-900"
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  )
}
