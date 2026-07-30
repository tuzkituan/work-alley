/**
 * A first guess at the terminal's size, for the `openShell` action.
 *
 * The pty has to be created with *some* geometry, and it is created in Rust
 * before any xterm instance exists to measure. Getting it roughly right matters:
 * a shell that starts at 80x24 and is corrected a frame later reprints its
 * prompt, and anything that drew on the alternate screen in between is mangled.
 * `fit()` supersedes this as soon as the view mounts.
 *
 * The character-cell ratios are xterm's own defaults for a monospace face:
 * advance width is ~0.6em and the line box is `fontSize * lineHeight`.
 */
const CHAR_WIDTH_RATIO = 0.6
const LINE_HEIGHT = 1.2
/** The pane's own padding, which is not available to the grid. */
const PADDING_PX = 12

export function estimateGeometry(
  el: HTMLElement | null,
  fontSize: number
): { cols: number; rows: number } {
  const width = (el?.clientWidth ?? 0) - PADDING_PX
  const height = (el?.clientHeight ?? 0) - PADDING_PX
  if (width <= 0 || height <= 0) return { cols: 80, rows: 24 }
  return {
    cols: Math.max(20, Math.floor(width / (fontSize * CHAR_WIDTH_RATIO))),
    rows: Math.max(6, Math.floor(height / (fontSize * LINE_HEIGHT))),
  }
}
