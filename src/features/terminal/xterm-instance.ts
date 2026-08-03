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
  /** Live bytes arriving while a scrollback restore is in flight. See `holdWrites`. */
  pending: Uint8Array[]
  /** True while those are being held rather than written. */
  holding: boolean
  /** Whether anything has ever been written to this instance. See `hasOutput`. */
  wrote: boolean
  disposers: (() => void)[]
}

const cache = new Map<string, TermHandle>()

/** One warning per session, not one per keystroke. */
const warned = new Set<string>()

// The family is a parameter rather than a constant here, and not read from the
// computed CSS var either: xterm needs a concrete string *and* a re-fit when it
// changes, and sampling `getComputedStyle` at construction would make a terminal's
// cell metrics depend on paint order.
export function ensureTerm(
  termId: string,
  theme: ITheme,
  fontSize: number,
  fontFamily: string
): TermHandle {
  const existing = cache.get(termId)
  if (existing) {
    if (existing.term.options.fontSize !== fontSize) existing.term.options.fontSize = fontSize
    if (existing.term.options.fontFamily !== fontFamily) {
      existing.term.options.fontFamily = fontFamily
    }
    return existing
  }

  const term = new Terminal({
    fontFamily,
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

  const handle: TermHandle = {
    term,
    fit,
    root,
    pending: [],
    holding: false,
    wrote: false,
    disposers: [],
  }

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
  if (handle.holding) {
    handle.pending.push(bytes)
    return
  }
  handle.wrote = true
  handle.term.write(bytes)
}

/** Whether anything has ever reached this instance — live, buffered or restored. */
export function hasOutput(termId: string): boolean {
  return cache.get(termId)?.wrote ?? false
}

/**
 * Holds live output while a scrollback snapshot is fetched.
 *
 * The snapshot is a round trip, and the shell does not stop talking during it. Its
 * reply then began with a hard reset and was written wholesale — so anything that
 * arrived in between was wiped, and the restored screen was a picture of the session
 * as it had been some milliseconds ago with live output stitched around it. That is
 * the "two things overlapping in one terminal" you see after a reload.
 *
 * Holding the live bytes and replaying them *after* the snapshot puts the two in the
 * only order that reads correctly: history, then what happened since.
 */
export function holdWrites(termId: string): void {
  const handle = cache.get(termId)
  if (handle) handle.holding = true
}

/** Writes the held bytes, in arrival order, and goes back to writing live. */
export function releaseWrites(termId: string): void {
  const handle = cache.get(termId)
  if (!handle) return
  handle.holding = false
  const queued = handle.pending
  handle.pending = []
  for (const chunk of queued) {
    handle.wrote = true
    handle.term.write(chunk)
  }
}

/** Marks a restore as written, so `hasOutput` covers the snapshot too. */
export function writeRestored(termId: string, bytes: Uint8Array): void {
  const handle = cache.get(termId)
  if (!handle) return
  // A hard reset first: the snapshot is trimmed at a newline, best effort, so it can
  // still begin partway through an escape sequence.
  handle.term.write('\x1bc')
  handle.wrote = true
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
  for (const chunk of queued) {
    handle.wrote = true
    handle.term.write(chunk)
  }
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

/**
 * Retypes every open terminal.
 *
 * The re-fit is not optional: a different family means different cell width, so
 * the column count the pty was told about is now wrong.
 */
export function applyFontFamily(fontFamily: string): void {
  for (const handle of cache.values()) {
    handle.term.options.fontFamily = fontFamily
    if (handle.root.isConnected) handle.fit.fit()
  }
}
