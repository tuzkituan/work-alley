import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useUiStore } from '@/stores/ui-store'
import type { ThemeMode } from '@/stores/ui-store'

/**
 * Tracks the OS theme preference.
 *
 * Deliberately NOT `matchMedia('(prefers-color-scheme: dark)')`: WebKitGTK does
 * not reflect the desktop setting there, so on GNOME with `color-scheme:
 * prefer-dark` the media query still reports light. Tauri reads the real platform
 * value, and `onThemeChanged` fires when it is switched live.
 */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined
    let cancelled = false

    void win
      .theme()
      .then((t) => {
        if (!cancelled) setDark(t === 'dark')
      })
      .catch(() => {
        // Fall back to the media query if the platform cannot tell us.
        if (!cancelled) {
          setDark(window.matchMedia?.('(prefers-color-scheme: dark)').matches === true)
        }
      })

    void win
      .onThemeChanged(({ payload }) => setDark(payload === 'dark'))
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return dark
}

/** The mode setting resolved to an actual appearance. */
export function useResolvedTheme(): { mode: ThemeMode; resolved: 'light' | 'dark' } {
  const mode = useUiStore((s) => s.theme)
  const systemDark = useSystemDark()
  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
  return { mode, resolved }
}

/**
 * Applies the theme to <html>, NOT to the app root div.
 *
 * Every Radix portal (Dialog, Popover, DropdownMenu, Tooltip, CommandDialog,
 * Sonner) mounts into document.body — outside the app root. If `.dark` lived on
 * the root, those portals would lose it and resolve the whole --adaptive-* ramp
 * to its light values, producing white dialogs floating over a dark app.
 */
export function useApplyTheme() {
  const { resolved } = useResolvedTheme()

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolved === 'dark')
    // Keeps native scrollbars, form controls and the webview backdrop in step.
    root.style.colorScheme = resolved
  }, [resolved])
}

const NEXT_LABEL: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'Auto',
}

export function useTheme() {
  const { mode, resolved } = useResolvedTheme()
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const setTheme = useUiStore((s) => s.setTheme)

  return {
    mode,
    resolved,
    toggleTheme,
    setTheme,
    /** The *current* mode, since the control now cycles through three. */
    label: NEXT_LABEL[mode],
    /** Sonner needs a concrete appearance, never "system". */
    theme: resolved,
  }
}
