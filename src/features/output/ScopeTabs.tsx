import { StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import type { RepoId } from '@/domain/types'

export interface ScopeOption {
  id: RepoId | null
  label: string
  runs: number
  terms: number
}

/**
 * Which scope the pane is showing, as tabs.
 *
 * Was a dropdown, which cost two clicks and — worse — hid the whole list behind a
 * trigger that only ever showed one name. The scopes on offer are the ones with
 * something happening in them, so they are exactly what you want visible at rest:
 * "workspace · web · api" tells you where the activity is without opening anything,
 * and switching is one click.
 *
 * Its own row rather than inline in the header: the header already holds a label, a
 * status line and up to five controls, and N repo names in there would push those
 * off the end of a 372px pane.
 */
export function ScopeTabs({
  scope,
  options,
  onSelect,
}: {
  scope: RepoId | null
  options: ScopeOption[]
  onSelect: (id: RepoId | null) => void
}) {
  return (
    <div
      // A skin handle, and the scroll container. Horizontal scroll rather than
      // wrap, so the pane's header height never changes with the number of scopes
      // — and with the bar hidden, because a 10px scrollbar in a 28px row is drawn
      // over the labels rather than under them.
      data-slot="scope-tabs"
      role="tablist"
      aria-label="Output scope"
      className="wa-scroll-hidden flex h-7 flex-none items-stretch overflow-x-auto border-b border-adaptive-200"
    >
      {options.map((o) => {
        const selected = o.id === scope
        return (
          <button
            key={o.id ?? ' workspace'}
            type="button"
            role="tab"
            aria-selected={selected}
            data-slot="scope-tab"
            // The full name, since the label above may be cut.
            title={
              o.id
                ? `Runs and terminals in ${o.label}`
                : 'Runs that belong to no single repo'
            }
            onClick={() => onSelect(o.id)}
            className={cn(
              // Capped, or a repo called `blazeup-subapp-sa-user-groups-permissions`
              // takes the whole row and every other scope is off-screen. `truncate`
              // on the label alone did nothing: the button is `flex-none`, so it
              // simply grew to fit.
              'flex max-w-[11rem] flex-none items-center gap-1 border-r border-adaptive-200 px-2 font-mono text-[11px] whitespace-nowrap',
              // The selected tab is marked by an inset bottom edge rather than a
              // background, so it stays legible under the metro skin — which fills
              // pressed controls solid and would otherwise fight a tint here.
              selected
                ? 'bg-adaptive-100 text-adaptive-900 shadow-[inset_0_-2px_0_0_var(--color-primary-600)]'
                : 'text-adaptive-500 hover:bg-adaptive-100/60 hover:text-adaptive-700'
            )}
          >
            <span className="min-w-0 truncate">{o.label}</span>
            {/* Counts on the tab, so activity in a scope you are not looking at is
                visible without switching to it — the one thing the old toggle could
                never show. */}
            {o.runs > 0 && (
              <span className="flex flex-none items-center gap-1 text-[10px] text-adaptive-400">
                <StatusDot
                  tone="info"
                  size={5}
                  style={{ animation: 'wa-blink 1.4s step-end infinite' }}
                />
                {o.runs}
              </span>
            )}
            {o.terms > 0 && (
              <span className="flex-none text-[10px] text-adaptive-400">{o.terms}⌨</span>
            )}
          </button>
        )
      })}

      {/* Only the workspace tab exists, so the row would otherwise read as a
          control with nothing to control. */}
      {options.length === 1 && (
        <span className="flex flex-none items-center px-2 text-[10.5px] text-adaptive-400">
          Select a repo to see its own runs and terminals.
        </span>
      )}
    </div>
  )
}
