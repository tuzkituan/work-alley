import { monoFontStack, useUiStore } from '@/stores/ui-store'
import { applyFontFamily, applyFontSize } from './xterm-instance'

/**
 * Pushes terminal typography changes into every open xterm.
 *
 * Module scope, not an effect in `OutputPane` — which is where the font-size half
 * used to live. That component is not mounted on the Toolbox, setup or settings
 * pages, so a change made from Settings never reached the install terminal running
 * in `MachinePage`'s dock: the one terminal most likely to be open at the moment
 * someone is choosing a font.
 *
 * Imported for its side effect. Both `applyFont*` walk a cache of live handles, so
 * this costs nothing until something is actually open.
 */
useUiStore.subscribe((state, prev) => {
  if (state.termFontSize !== prev.termFontSize) applyFontSize(state.termFontSize)
  if (state.monoFont !== prev.monoFont) applyFontFamily(monoFontStack(state.monoFont))
})
