/**
 * A first guess at the terminal's size, for the `openShell` action.
 *
 * The pty has to be created with *some* geometry, and it is created in Rust
 * before any xterm instance exists to measure. Getting it roughly right matters:
 * a shell that starts at 80x24 and is corrected a frame later reprints its
 * prompt, and anything that drew on the alternate screen in between is mangled.
 * `fit()` supersedes this as soon as the view mounts.
 *
 * The cell box is **measured**, not extrapolated from the font size. It used to be
 * `fontSize * 1.2`, which is not what a line of text occupies: xterm's row height is
 * `floor(measuredCharHeight * lineHeight)`, and the measured height of a 12px mono
 * face is nearer 15px than 12 — so the old estimate handed the pty about a third
 * more rows than the box could ever show. A shell told it has 32 rows in a 24-row
 * window puts its prompt, and anything that positions by row, where nothing is
 * looking: text drawn over text until something forces a full redraw.
 */

/** Must match the `lineHeight` xterm is constructed with. See xterm-instance.ts. */
const LINE_HEIGHT = 1.2
/** Measuring one glyph rounds badly; xterm uses the same trick with the same count. */
const REPEAT = 32
/** The pane's own padding, which is not available to the grid. */
const PADDING_PX = 12
/** Before anything can be measured — the classic terminal, and xterm's own default. */
const FALLBACK = { cols: 80, rows: 24 }

interface Cell {
  width: number
  height: number
}

/**
 * Keyed by size and family, because measuring forces a synchronous layout and this
 * runs on a click. Only populated once the font is actually loaded: a probe drawn in
 * the fallback face would otherwise pin the wrong metrics for the session.
 */
const cells = new Map<string, Cell>()

function measureCell(fontSize: number, fontFamily: string): Cell | null {
  const key = `${fontSize}px ${fontFamily}`
  const hit = cells.get(key)
  if (hit) return hit

  const probe = document.createElement('span')
  probe.style.cssText =
    'position:absolute;top:-9999px;left:-9999px;visibility:hidden;white-space:pre;line-height:normal'
  probe.style.font = key
  probe.textContent = 'W'.repeat(REPEAT)
  document.body.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()

  const width = rect.width / REPEAT
  const height = Math.floor(rect.height * LINE_HEIGHT)
  if (width <= 0 || height <= 0) return null

  const cell = { width, height }
  // `check` rather than a bare cache write: @fontsource faces are lazy, so the first
  // terminal on a cold start can be measured in the fallback face. That guess is
  // still the best one available *now* — it is just not one to remember.
  if (document.fonts?.check(key)) cells.set(key, cell)
  return cell
}

export function estimateGeometry(
  el: HTMLElement | null,
  fontSize: number,
  fontFamily: string
): { cols: number; rows: number } {
  const width = (el?.clientWidth ?? 0) - PADDING_PX
  const height = (el?.clientHeight ?? 0) - PADDING_PX
  if (width <= 0 || height <= 0) return FALLBACK

  const cell = measureCell(fontSize, fontFamily)
  if (!cell) return FALLBACK

  return {
    cols: Math.max(20, Math.floor(width / cell.width)),
    rows: Math.max(6, Math.floor(height / cell.height)),
  }
}
