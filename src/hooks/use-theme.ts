import { useEffect } from 'react'
import { useUiStore } from '@/stores/ui-store'
import type { ThemeMode } from '@/stores/ui-store'

/**
 * Applies the theme to <html>, NOT to the app root div.
 *
 * Every Radix portal (Dialog, Popover, DropdownMenu, Tooltip, CommandDialog,
 * Sonner) mounts into document.body — outside the app root. If `.dark` lived on
 * the root, those portals would lose it and resolve the whole --adaptive-* ramp
 * to its light values, producing white dialogs floating over a dark app.
 */
export function useApplyTheme() {
  const theme = useUiStore((s) => s.theme)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    // Keeps native scrollbars, form controls and the webview backdrop in step.
    root.style.colorScheme = theme
  }, [theme])
}

const LABEL: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
}

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
