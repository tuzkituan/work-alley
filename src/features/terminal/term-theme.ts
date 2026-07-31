import type { ITheme } from '@xterm/xterm'

/**
 * Reads the `--wa-term-*` palette out of the current theme.
 *
 * Isolated here because of one sharp edge: every other colour in this app is
 * `oklch()`, and xterm's colour parser does not understand oklch — it would
 * silently resolve to black and give a black-on-black terminal. So the terminal
 * palette is the one hex block in wa-bridge.css, and this is the only reader.
 *
 * Sampled from a `scope` element rather than from <html>, because the console can
 * be pinned light or dark independently of the app — and then the palette it must
 * read is declared on the pane, not on the root. Defaults to <html>, which is what
 * every caller inside an app-themed pane resolves to anyway.
 */
function v(scope: Element, name: string, fallback: string): string {
  const raw = getComputedStyle(scope).getPropertyValue(name).trim()
  return raw || fallback
}

export function buildTermTheme(scope: Element = document.documentElement): ITheme {
  const read = (name: string, fallback: string) => v(scope, name, fallback)
  return {
    background: read('--wa-term-bg', '#ffffff'),
    foreground: read('--wa-term-fg', '#1f2328'),
    cursor: read('--wa-term-cursor', '#1f2328'),
    cursorAccent: read('--wa-term-cursor-accent', '#ffffff'),
    selectionBackground: read('--wa-term-selection', '#b3d4fc'),
    black: read('--wa-term-black', '#2e3436'),
    red: read('--wa-term-red', '#cc0000'),
    green: read('--wa-term-green', '#4e9a06'),
    yellow: read('--wa-term-yellow', '#c4a000'),
    blue: read('--wa-term-blue', '#3465a4'),
    magenta: read('--wa-term-magenta', '#75507b'),
    cyan: read('--wa-term-cyan', '#06989a'),
    white: read('--wa-term-white', '#d3d7cf'),
    brightBlack: read('--wa-term-bright-black', '#555753'),
    brightRed: read('--wa-term-bright-red', '#ef2929'),
    brightGreen: read('--wa-term-bright-green', '#8ae234'),
    brightYellow: read('--wa-term-bright-yellow', '#fce94f'),
    brightBlue: read('--wa-term-bright-blue', '#729fcf'),
    brightMagenta: read('--wa-term-bright-magenta', '#ad7fa8'),
    brightCyan: read('--wa-term-bright-cyan', '#34e2e2'),
    brightWhite: read('--wa-term-bright-white', '#eeeeec'),
  }
}
