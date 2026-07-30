import type { ITheme } from '@xterm/xterm'

/**
 * Reads the `--wa-term-*` palette out of the current theme.
 *
 * Isolated here because of one sharp edge: every other colour in this app is
 * `oklch()`, and xterm's colour parser does not understand oklch — it would
 * silently resolve to black and give a black-on-black terminal. So the terminal
 * palette is the one hex block in wa-bridge.css, and this is the only reader.
 */
function v(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw || fallback
}

export function buildTermTheme(): ITheme {
  return {
    background: v('--wa-term-bg', '#ffffff'),
    foreground: v('--wa-term-fg', '#1f2328'),
    cursor: v('--wa-term-cursor', '#1f2328'),
    cursorAccent: v('--wa-term-cursor-accent', '#ffffff'),
    selectionBackground: v('--wa-term-selection', '#b3d4fc'),
    black: v('--wa-term-black', '#2e3436'),
    red: v('--wa-term-red', '#cc0000'),
    green: v('--wa-term-green', '#4e9a06'),
    yellow: v('--wa-term-yellow', '#c4a000'),
    blue: v('--wa-term-blue', '#3465a4'),
    magenta: v('--wa-term-magenta', '#75507b'),
    cyan: v('--wa-term-cyan', '#06989a'),
    white: v('--wa-term-white', '#d3d7cf'),
    brightBlack: v('--wa-term-bright-black', '#555753'),
    brightRed: v('--wa-term-bright-red', '#ef2929'),
    brightGreen: v('--wa-term-bright-green', '#8ae234'),
    brightYellow: v('--wa-term-bright-yellow', '#fce94f'),
    brightBlue: v('--wa-term-bright-blue', '#729fcf'),
    brightMagenta: v('--wa-term-bright-magenta', '#ad7fa8'),
    brightCyan: v('--wa-term-bright-cyan', '#34e2e2'),
    brightWhite: v('--wa-term-bright-white', '#eeeeec'),
  }
}
