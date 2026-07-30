import { useEffect } from 'react'
import { useUiStore } from '@/stores/ui-store'
import { buildTermTheme } from './term-theme'
import { applyTheme } from './xterm-instance'

/**
 * Keeps every open terminal's palette in step with the appearance *and* the skin.
 *
 * Both axes move `--wa-term-*`: the skin repaints the terminal in the same colour
 * as the panel around it, so a skin change with a terminal open used to leave it
 * on the old background until the next light/dark toggle.
 *
 * A hook rather than an effect in one component, because there are two mount
 * points and they are never both present: the output pane owns terminals on the
 * workspace view, and MachineTerminalDock owns them on the Toolbox and setup
 * pages, where the output pane is not rendered at all.
 *
 * Safe to read computed styles from here, which was not always true. The DOM
 * write used to live in an effect in `App`, and React flushes child effects
 * before parent effects — so this one sampled `getComputedStyle` before `.dark`
 * had been applied and was a toggle behind. It is now a module-scope
 * subscription in use-theme.ts, outside React's scheduling entirely.
 */
export function useTermPalette() {
  const theme = useUiStore((s) => s.theme)
  const skin = useUiStore((s) => s.skin)

  useEffect(() => {
    // xterm repaints on assignment, so this reaches hidden tabs too — nothing
    // needs remounting on a toggle.
    applyTheme(buildTermTheme())
  }, [theme, skin])
}
