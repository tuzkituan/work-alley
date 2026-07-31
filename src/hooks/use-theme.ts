import { monoFontStack, SKINS, uiFontStack, useUiStore } from '@/stores/ui-store'
import type { MonoFont, Skin, ThemeMode, UiFont } from '@/stores/ui-store'

/**
 * Writes the appearance to <html>, NOT to the app root div.
 *
 * Every Radix portal (Dialog, Popover, DropdownMenu, Tooltip, CommandDialog,
 * Sonner) mounts into document.body — outside the app root. If `.dark` or
 * `data-skin` lived on the root, those portals would lose them and resolve the
 * whole --adaptive-* ramp to its light values: white dialogs floating over a dark
 * app, and a rounded one over a squared-off skin.
 *
 * A module-scope subscription rather than an effect in `App`, and that is a fix
 * rather than a style preference. `buildTermTheme()` samples these very
 * attributes through `getComputedStyle`, from an effect in a *descendant* of App
 * — and React flushes child effects before parent effects, so an App-level effect
 * wrote `.dark` only *after* the terminal had already read the previous theme's
 * colours. Writing here, outside React's scheduling entirely, means the DOM is
 * correct before any component can look at it.
 *
 * The fonts are here for the same reason and one more: the terminal's cell metrics
 * depend on the family, so a font written after paint means a reflow rather than a
 * correct first frame.
 */
function applyToDom(theme: ThemeMode, skin: Skin, uiFont: UiFont, monoFont: MonoFont) {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.skin = skin
  // Only ever light|dark: this drives native scrollbars, form controls and the
  // webview backdrop, none of which have any notion of a skin.
  root.style.colorScheme = theme
  // Inline on <html>, which outranks wa-bridge.css's `:root` rule. Tailwind's
  // font-sans/font-mono utilities follow because theme.css declares both with
  // `@theme inline` — see the note there; plain `@theme` would inline the values
  // at build time and none of this would reach the page.
  root.style.setProperty('--font-sans', uiFontStack(uiFont))
  root.style.setProperty('--font-mono', monoFontStack(monoFont))
}

// Eagerly, at import time. `persist` rehydrates from localStorage synchronously,
// so the store is already correct here and there is no frame of the wrong look.
{
  const s = useUiStore.getState()
  applyToDom(s.theme, s.skin, s.uiFont, s.monoFont)
}

useUiStore.subscribe((state, prev) => {
  if (
    state.theme === prev.theme &&
    state.skin === prev.skin &&
    state.uiFont === prev.uiFont &&
    state.monoFont === prev.monoFont
  ) {
    return
  }
  applyToDom(state.theme, state.skin, state.uiFont, state.monoFont)
})

/**
 * Kept as a hook so `App` still declares the dependency, but the work is done by
 * the subscription above.
 */
export function useApplyTheme() {
  // Intentionally empty. See applyToDom's comment for why this is not an effect.
}

const LABEL: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
}

const SKIN_LABEL: Record<Skin, string> = {
  classic: 'Classic',
  metro: 'Metro',
  adwaita: 'Adwaita',
}

/** One phrase for what each skin looks like, for the picker's right-hand column. */
const SKIN_HINT: Record<Skin, string> = {
  classic: 'rounded',
  metro: 'flat tiles',
  adwaita: 'GNOME',
}

/**
 * The skin picker's rows, derived from SKINS rather than written out.
 *
 * The menu used to hardcode one entry per skin, so adding a third left it
 * unreachable from the UI entirely — the same way `toggleSkin` used to skip it.
 * Deriving both from the one list means a fourth skin appears in the picker for
 * free.
 */
export const SKIN_OPTIONS: { id: Skin; label: string; hint: string }[] = SKINS.map((id) => ({
  id,
  label: SKIN_LABEL[id],
  hint: SKIN_HINT[id],
}))

/**
 * The theme is an explicit choice: light or dark. It does not follow the OS.
 *
 * A third "follow the system" mode was removed. It made the current appearance a
 * function of two inputs, so what the toggle did next depended on state the user
 * could not see — and the platform theme signal is unreliable under WebKitGTK in
 * the first place.
 */
export function useTheme() {
  const theme = useUiStore((s) => s.theme)
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const setTheme = useUiStore((s) => s.setTheme)

  return {
    theme,
    /** Kept as an alias: consumers that want a concrete appearance. */
    resolved: theme,
    mode: theme,
    toggleTheme,
    setTheme,
    label: LABEL[theme],
  }
}

/**
 * The other axis. Separate from `useTheme` so a component that only cares about
 * light-vs-dark does not re-render when the skin changes.
 */
export function useSkin() {
  const skin = useUiStore((s) => s.skin)
  const setSkin = useUiStore((s) => s.setSkin)
  const toggleSkin = useUiStore((s) => s.toggleSkin)

  return { skin, setSkin, toggleSkin, label: SKIN_LABEL[skin] }
}
