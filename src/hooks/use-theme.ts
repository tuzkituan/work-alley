import { useEffect } from 'react'
import { isTauri } from '@/ipc/guard'
import { monoFontStack, SKINS, uiFontStack, useUiStore, ZOOM_MAX, ZOOM_MIN } from '@/stores/ui-store'
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
function applyToDom(
  theme: ThemeMode,
  skin: Skin,
  uiFont: UiFont,
  monoFont: MonoFont,
  zoom: number
) {
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
  // The *webview's* zoom, not CSS.
  //
  // CSS `zoom` on <html> was the first attempt and it is subtly broken for this
  // app: Radix positions every portal — menus, popovers, tooltips — by measuring a
  // trigger with getBoundingClientRect and writing a transform onto an element in
  // <body>. Both are inside the zoomed subtree, so the offset is applied twice and
  // the appearance menu drifted further off the right edge the further from the
  // origin its trigger sat.
  //
  // Webview zoom is the browser's own, applied above the document: measurement and
  // positioning agree because neither knows it is happening. It also scales the
  // xterm canvas correctly, which a CSS transform would have resampled.
  //
  // Fire-and-forget: this is a display preference, the store already holds the
  // value, and a rejected promise here (no Tauri, permission denied) must not take
  // the theme write down with it.
  void setWebviewZoom(zoom)
}

/**
 * `Webview.setZoom`, guarded.
 *
 * Imported lazily so the module graph stays loadable in a plain browser — this
 * file runs its DOM write at import time, and a top-level `@tauri-apps/api/webview`
 * import would throw there rather than in the one call that needs it.
 */
async function setWebviewZoom(zoom: number): Promise<void> {
  if (!isTauri()) return
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    await getCurrentWebview().setZoom(zoom)
  } catch {
    // An older webview, or a capability that was not granted. The app is entirely
    // usable at 100%; a toast for a zoom that did not take is noise.
  }
}

// Eagerly, at import time. `persist` rehydrates from localStorage synchronously,
// so the store is already correct here and there is no frame of the wrong look.
{
  const s = useUiStore.getState()
  applyToDom(s.theme, s.skin, s.uiFont, s.monoFont, s.zoom)
}

useUiStore.subscribe((state, prev) => {
  if (
    state.theme === prev.theme &&
    state.skin === prev.skin &&
    state.uiFont === prev.uiFont &&
    state.monoFont === prev.monoFont &&
    state.zoom === prev.zoom
  ) {
    return
  }
  applyToDom(state.theme, state.skin, state.uiFont, state.monoFont, state.zoom)
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
 * ⌘/Ctrl with `+`, `-` and `0`, because that is what every window does.
 *
 * The webview's built-in accelerators are not wired up under Tauri, so these drive
 * the store — which is where the value has to live anyway, since it is persisted
 * and shown in two menus.
 *
 * `e.code` for the two steppers, not `e.key`: with Ctrl held, `-` and `=` arrive as
 * themselves on most layouts but the numpad and AZERTY do not agree, and `code` is
 * about the physical key. `e.key` is still accepted, so `Ctrl+Shift+=` (which is
 * how "+" is actually typed) works too.
 */
export function useZoomKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const { nudgeZoom, setZoom } = useUiStore.getState()
      if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault()
        nudgeZoom(1)
      } else if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
        e.preventDefault()
        nudgeZoom(-1)
      } else if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') {
        e.preventDefault()
        setZoom(1)
      }
    }
    // On window, not the app root: the terminal swallows most keys, and Ctrl+- is
    // not one a shell has any use for.
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * The console's lighting, and the class that paints it.
 *
 * Returns '' when the pane agrees with the app, which is the default and costs
 * nothing: the subtree simply inherits. Otherwise it is `dark` — the same class the
 * whole app uses, which works at any depth because both stylesheets select it by
 * class — or `wa-pane-light`, which exists because there is no `.light` to pair
 * with it. See the note in wa-bridge.css.
 */
export function usePaneTheme() {
  const theme = useUiStore((s) => s.theme)
  const paneTheme = useUiStore((s) => s.paneTheme)
  const setPaneTheme = useUiStore((s) => s.setPaneTheme)

  const resolved: ThemeMode = paneTheme === 'app' ? theme : paneTheme
  const className =
    resolved === theme ? '' : resolved === 'dark' ? 'dark wa-pane-dark' : 'wa-pane-light'

  return { paneTheme, setPaneTheme, resolved, className }
}

/**
 * Interface scale. Its own hook for the same reason `useSkin` is: the topbar's
 * zoom control must not re-render on a theme flip, and vice versa.
 */
export function useZoom() {
  const zoom = useUiStore((s) => s.zoom)
  const setZoom = useUiStore((s) => s.setZoom)
  const nudgeZoom = useUiStore((s) => s.nudgeZoom)

  return {
    zoom,
    setZoom,
    nudgeZoom,
    /** "100%" — the only form this is ever shown in. */
    label: `${Math.round(zoom * 100)}%`,
    canGrow: zoom < ZOOM_MAX,
    canShrink: zoom > ZOOM_MIN,
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
