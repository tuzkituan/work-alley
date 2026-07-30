import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '@/ipc/commands'
import { useTerminalStore } from '@/stores/terminal-store'

/**
 * xterm instances live here, in a module-level cache outside React.
 *
 * One idea solves three problems at once. The instance and its DOM node are
 * owned by this module; `TerminalView` only re-parents the existing node into
 * whichever container is mounted.
 *
 *  - **StrictMode.** `ensureTerm` is idempotent by id, so the double-invoked
 *    mount effect is a no-op. Subscribing `onData` twice would send every
 *    keystroke twice — the terminal analogue of the duplicated-run-chip bug
 *    documented in ipc/bridge.ts.
 *  - **Hidden tabs.** Switching tabs detaches a node instead of unmounting a
 *    component, so scrollback, cursor position and the running program survive.
 *  - **Remounts.** Bytes that arrive before a container exists are buffered
 *    rather than dropped; `term:opened` and `term:output` can both land before
 *    React has rendered anything.
 *
 * This is the same escape hatch, for the same reason, as `ensureBridge` in
 * ipc/events.ts: an imperative resource that cannot survive effect+cleanup.
 */
interface TermHandle {
  term: Terminal
  fit: FitAddon
  /** Owned here, never by React. Re-parented, never recreated. */
  root: HTMLDivElement
  /** Bytes that arrived before the first mount, or while detached. */
  pending: Uint8Array[]
  disposers: (() => void)[]
}

const cache = new Map<string, TermHandle>()

/** One warning per session, not one per keystroke. */
const warned = new Set<string>()

const FONT_FAMILY = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace"

export function ensureTerm(termId: string, theme: ITheme, fontSize: number): TermHandle {
  const existing = cache.get(termId)
  if (existing) {
    if (existing.term.options.fontSize !== fontSize) existing.term.options.fontSize = fontSize
    return existing
  }

  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme,
    // The default DOM renderer. WebGL under WebKitGTK is the flakiest surface in
    // this stack and a lost context leaves a blank terminal; the grid here is
    // small enough that it buys nothing.
    allowProposedApi: false,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  const root = document.createElement('div')
  root.className = 'h-full w-full'
  // Opened once, on the detached node. The component appends this node; it never
  // calls `open` itself, so the emulator is attached exactly one time.
  term.open(root)

  const handle: TermHandle = { term, fit, root, pending: [], disposers: [] }

  // Wired here rather than in the component so it survives re-parenting.
  handle.disposers.push(
    term.onData((data) => {
      void api.termWrite(termId, data).catch(() => {
        // A dead session would otherwise fire one toast per keystroke.
        if (warned.has(termId)) return
        warned.add(termId)
        term.write('\r\n\x1b[31m[this terminal is gone]\x1b[0m\r\n')
      })
    }).dispose
  )
  // OSC 0/2. Handled entirely client-side; Rust is not involved.
  handle.disposers.push(
    term.onTitleChange((title) => {
      if (title.trim()) useTerminalStore.getState().rename(termId, title)
    }).dispose
  )

  cache.set(termId, handle)
  return handle
}

export function getTerm(termId: string): TermHandle | undefined {
  return cache.get(termId)
}

export function writeToTerm(termId: string, bytes: Uint8Array): void {
  const handle = cache.get(termId)
  if (!handle) {
    // No instance yet — buffer under the id so nothing printed during startup is
    // lost. Drained by `drainPending` on first mount.
    let queued = earlyBytes.get(termId)
    if (!queued) {
      queued = []
      earlyBytes.set(termId, queued)
    }
    queued.push(bytes)
    return
  }
  handle.term.write(bytes)
}

/** Output that arrived before `ensureTerm` ran for that id. */
const earlyBytes = new Map<string, Uint8Array[]>()

export function drainPending(termId: string): void {
  const queued = earlyBytes.get(termId)
  if (!queued) return
  earlyBytes.delete(termId)
  const handle = cache.get(termId)
  if (!handle) return
  for (const chunk of queued) handle.term.write(chunk)
}

/**
 * Destroys an instance. Called **only** from `useTerminalStore.close` — never
 * from an effect cleanup, which must merely detach.
 */
export function disposeTerm(termId: string): void {
  const handle = cache.get(termId)
  if (!handle) return
  cache.delete(termId)
  earlyBytes.delete(termId)
  warned.delete(termId)
  for (const d of handle.disposers) d()
  handle.term.dispose()
  handle.root.remove()
}

/**
 * Repaints every cached instance, including hidden ones — xterm repaints on
 * assignment, so a light/dark toggle applies to tabs the user is not looking at.
 */
export function applyTheme(theme: ITheme): void {
  for (const handle of cache.values()) handle.term.options.theme = theme
}

export function applyFontSize(fontSize: number): void {
  for (const handle of cache.values()) {
    handle.term.options.fontSize = fontSize
    // Only the attached one has a box to measure; the rest re-fit on mount.
    if (handle.root.isConnected) handle.fit.fit()
  }
}
