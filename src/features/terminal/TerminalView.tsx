import { useEffect, useRef } from 'react'
import { api } from '@/ipc/commands'
import { b64ToBytes } from '@/lib/b64'
import { useTerminalStore } from '@/stores/terminal-store'
import { monoFontStack, useUiStore } from '@/stores/ui-store'
import { buildTermTheme } from './term-theme'
import { drainPending, ensureTerm } from './xterm-instance'

/**
 * How long to wait after the last resize tick before telling the pty.
 *
 * Not optional. react-resizable-panels fires on every pointer move while the
 * handle is dragged, and one TIOCSWINSZ — and so one SIGWINCH — per pixel makes
 * vim redraw itself into a stutter.
 */
const RESIZE_DEBOUNCE_MS = 60

/**
 * The React surface of a terminal, deliberately thin.
 *
 * The xterm instance itself is owned by xterm-instance.ts; this component only
 * re-parents the existing DOM node in and out. Cleanup detaches — it must never
 * dispose, or switching tabs would destroy the shell.
 */
export function TerminalView({ termId }: { termId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef<() => void>(() => {})
  const fontSize = useUiStore((s) => s.termFontSize)
  const monoFont = useUiStore((s) => s.monoFont)
  // Read through a ref so the effect does not re-run when the flag settles, and does
  // not need it in its dependency list.
  const restored = useTerminalStore((s) => s.tabs.get(termId)?.restored ?? false)
  const restoredRef = useRef(restored)
  restoredRef.current = restored

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handle = ensureTerm(termId, buildTermTheme(), fontSize, monoFontStack(monoFont))
    focusRef.current = () => handle.term.focus()
    container.appendChild(handle.root)
    drainPending(termId)

    let lastCols = 0
    let lastRows = 0
    const syncSize = () => {
      // A zero-height box (a hidden panel, a not-yet-laid-out container) makes
      // fit() compute a garbage geometry, so skip rather than push it to the pty.
      if (container.clientHeight === 0 || container.clientWidth === 0) return
      handle.fit.fit()
      const { cols, rows } = handle.term
      if (cols === lastCols && rows === lastRows) return
      lastCols = cols
      lastRows = rows
      void api.termResize(termId, cols, rows).catch(() => {})
    }

    // One ResizeObserver covers the ResizableHandle drag, the panel collapsing
    // and an OS window resize — all three are just "this box changed size".
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(syncSize, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(container)

    // After layout, so the first fit measures a real box.
    const raf = requestAnimationFrame(() => {
      syncSize()
      handle.term.focus()
    })

    // Only for a session recovered from the backend — one that predates this
    // webview, whose output was emitted to a frontend that no longer exists.
    //
    // The buffer check alone was not enough, and got this wrong in the one case that
    // matters most. A *brand-new* terminal also has an empty buffer, so it asked for
    // the snapshot too; the reply landed a round trip later and was written over the
    // prompt and any keystrokes that had arrived live in the meantime. Typing quickly
    // into a fresh shell duplicated characters.
    if (restoredRef.current && handle.term.buffer.active.length <= 1) {
      api
        .termScrollback(termId)
        .then((b64) => {
          if (!b64) return
          // A hard reset first: the snapshot is trimmed at a newline, best
          // effort, so it can still begin partway through an escape sequence.
          handle.term.write('\x1bc')
          handle.term.write(b64ToBytes(b64))
        })
        .catch(() => {})
    }

    return () => {
      cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
      observer.disconnect()
      // Detach only. Disposing here would kill the terminal every time the user
      // switched tabs; `useTerminalStore.close` is what destroys an instance.
      if (handle.root.parentNode === container) container.removeChild(handle.root)
    }
    // `fontSize` is applied by applyFontSize() on change rather than by
    // remounting; it is read here only to seed a freshly created instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId])

  return (
    <div
      ref={containerRef}
      // The hook a skin uses to frame the console. Anything drawn *over* the
      // canvas has to go on the ::after overlay with pointer-events: none —
      // xterm's own selection and link handlers live on descendants of this box.
      // See wa-skin.css.
      data-slot="term-surface"
      // min-h-0 so it can actually shrink inside the flex column, and a real
      // height for fit() to measure.
      className="min-h-0 flex-1 overflow-hidden bg-[var(--wa-term-bg)] p-1.5"
      // Clicking anywhere in the pane types into *this* terminal, not whichever
      // one the browser last focused.
      onClick={() => focusRef.current()}
    />
  )
}
