/**
 * The repo table's columns, as data.
 *
 * They used to be a `grid-template-columns` in CSS with a container query per
 * breakpoint, and two things broke that arrangement for good.
 *
 * The first is user choice. A column the user turns off has to leave the *template*,
 * not just stop rendering: hiding the cell alone shifts every later cell one track
 * left and strands the last one, which is how the actions group ended up floating
 * 120px short of the right edge.
 *
 * The second is that the CSS was quietly wrong. Each breakpoint declared both when a
 * template applies and what it costs, in two different places — and the widest one
 * needed 926px of minimums while claiming to apply down to 901px. Between those
 * numbers the grid was simply wider than the table, and since the table clips (it has
 * rounded corners), what fell off the end was the actions column: the one thing on
 * the row you cannot do without.
 *
 * Here the width is derived from the columns instead. `fit` drops the least useful
 * ones until the rest fit, so a template can never be too wide for the box it is in.
 */

/** Every optional column, in the order it appears. */
export const COLUMNS = [
  {
    id: 'branch',
    label: 'Branch',
    /** Track width. `null` means it flexes — see `template`. */
    width: null,
    /** Smallest it may be squeezed to before it is dropped instead. */
    min: 80,
    hint: 'Which branch is checked out. Click to switch.',
  },
  {
    id: 'changes',
    label: 'Changes',
    width: 96,
    min: 96,
    hint: 'Uncommitted and untracked files.',
  },
  { id: 'sync', label: 'Sync', width: 76, min: 76, hint: 'Commits ahead of and behind the remote.' },
  {
    id: 'fetched',
    label: 'Fetched',
    width: 64,
    min: 64,
    hint: 'How old the sync numbers are — they come from local refs.',
  },
  {
    id: 'tracked',
    label: 'Tracked package',
    width: 84,
    min: 84,
    hint: 'The shared package’s version in each repo. Off by default: most workspaces have no shared package, and in the ones that do it is a specialist question.',
  },
  { id: 'dev', label: 'Dev', width: 96, min: 96, hint: 'Dev server state and port.' },
] as const

export type ColumnId = (typeof COLUMNS)[number]['id']

/** The two that are never columns in this sense: they cannot be turned off. */
const DOT = 18
const NAME_MIN = 200
const ACTIONS = 124
const GAP = 8
/** `px-3` on both sides of every row. */
const ROW_PADDING = 24

/**
 * Which columns are on when nothing has been chosen.
 *
 * `tracked` is off. It is the only column whose *question* is workspace-specific —
 * most workspaces have no shared package at all, and the column then reads as a
 * mystery 84px of dashes — whereas every other column here describes any git repo.
 */
export const DEFAULT_COLUMNS: Record<ColumnId, boolean> = {
  branch: true,
  changes: true,
  sync: true,
  fetched: true,
  tracked: false,
  dev: true,
}

/**
 * The order columns are given up in when the table is too narrow.
 *
 * Least useful first, and the reasoning is the same one the old breakpoints
 * encoded: `tracked` is a specialist question; `fetched` qualifies `sync` rather
 * than saying anything alone; `sync` and `dev` are both on the row's own status dot
 * and in the detail pane; `changes` and `branch` are the last to go because they are
 * the two facts you scan the list *for*.
 */
const SACRIFICE: ColumnId[] = ['tracked', 'fetched', 'sync', 'dev', 'changes', 'branch']

/** The width a row needs with these columns on. */
export function requiredWidth(on: ColumnId[]): number {
  const cols = COLUMNS.filter((c) => on.includes(c.id))
  const tracks = 2 + cols.length + 1 // dot, name, …columns, actions
  const fixed = cols.reduce((sum, c) => sum + c.min, 0)
  return DOT + NAME_MIN + fixed + ACTIONS + GAP * (tracks - 1) + ROW_PADDING
}

/**
 * The columns that actually fit in `width`, given what the user asked for.
 *
 * Returns the user's choice untouched when it fits, so this only ever *removes* —
 * a column that is off stays off however wide the window gets, because the user
 * said so and a table that re-adds columns on resize is a table nobody trusts.
 *
 * A width of 0 (the first render, before the table has been measured) yields the
 * user's full choice rather than the narrowest layout: one frame too wide is
 * invisible, whereas one frame of a stripped-down table is a visible flinch.
 */
export function fit(chosen: Record<ColumnId, boolean>, width: number): ColumnId[] {
  let on = COLUMNS.map((c) => c.id).filter((id) => chosen[id])
  if (width <= 0) return on

  for (const victim of SACRIFICE) {
    if (requiredWidth(on) <= width) break
    on = on.filter((id) => id !== victim)
  }
  return on
}

/**
 * `grid-template-columns` for a set of columns.
 *
 * The name column takes the slack. Branch is the only other flexible one — a branch
 * called `feature/PROJ-1421-rewrite-the-thing` is common and a fixed track would
 * ellipsize all of them equally, whether or not there is room to spare.
 */
export function template(on: ColumnId[]): string {
  const middle = COLUMNS.filter((c) => on.includes(c.id)).map((c) =>
    c.width === null ? `minmax(${c.min}px, 1fr)` : `${c.width}px`
  )
  return [`${DOT}px`, `minmax(${NAME_MIN}px, 2.6fr)`, ...middle, `${ACTIONS}px`].join(' ')
}
