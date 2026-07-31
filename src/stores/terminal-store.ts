import { create } from 'zustand'
import { repoId, type RepoRef, type TermInfo } from '@/domain/types'
import { api } from '@/ipc/commands'
import { disposeTerm } from '@/features/terminal/xterm-instance'
import { WORKSPACE_KEY } from './run-store'

export interface TermTab {
  termId: string
  /** 'shell' | 'script' | 'package'. See TermInfo.kind. */
  kind: string
  title: string
  cwd: string
  ref: RepoRef | null
  argv: string[]
  /** The only thing that tells two `zsh` tabs in the same repo apart. */
  pid: number
  startedUnix: number
  status: 'live' | 'exited'
  exitCode: number | null
  /**
   * This tab was recovered from the backend's pty registry, not opened live.
   *
   * Which decides one thing: whether the view replays the session's scrollback.
   * Replaying is right for a session that predates this webview — its output was
   * emitted to a frontend that no longer exists — and wrong for one opened just now,
   * whose output is already arriving through `term:output`. Doing both wrote the
   * prompt and the first keystrokes twice.
   */
  restored: boolean
}

interface TerminalState {
  tabs: Map<string, TermTab>
  order: string[]
  /**
   * Which view the output pane is showing. `null` means the run log — this is
   * the pane's view selector, not just "which terminal".
   */
  activeTermId: string | null
  /**
   * scope key -> live terminals, maintained incrementally and keyed exactly like
   * `runningByScope`.
   *
   * Exists so "what is busy here" can be answered honestly. Two places used to
   * label a count of *runs* as terminals — the repo row's tooltip and the top bar's
   * terminals menu — because there was no per-scope terminal count to read.
   */
  liveByScope: Record<string, number>

  open(info: TermInfo, opts?: { restored?: boolean }): void
  /**
   * The next terminal to open was asked for by name, so show it.
   *
   * A one-shot flag rather than a rule in the bridge, because "was this session
   * opened deliberately" is knowledge only the caller has: a session restored on
   * reload, or one a chore spawned in another repo, must not move the pane — that
   * is the whole reason the pane stopped following runs around. Pressing the
   * terminal button is the opposite: the shell *is* the request.
   */
  requestFocus(): void
  /** Reads and clears the flag. Called once, by the `term:opened` handler. */
  takeFocusRequest(): boolean
  exit(termId: string, code: number): void
  rename(termId: string, title: string): void
  close(termId: string): void
  setActive(termId: string | null): void
}

// Module scope, not store state: nothing renders from it, and a `set` here would
// re-render every subscriber of the terminal store to carry a boolean that lives
// for one round trip.
let focusRequested = false

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  tabs: new Map(),
  order: [],
  activeTermId: null,
  liveByScope: {},

  requestFocus: () => {
    focusRequested = true
  },
  takeFocusRequest: () => {
    const was = focusRequested
    focusRequested = false
    return was
  },

  open: (info, opts) =>
    set((s) => {
      const tabs = new Map(s.tabs)
      tabs.set(info.termId, {
        termId: info.termId,
        kind: info.kind,
        title: info.title,
        cwd: info.cwd,
        ref: info.repo,
        argv: info.argv,
        pid: info.pid,
        startedUnix: info.startedUnix,
        status: info.alive ? 'live' : 'exited',
        exitCode: null,
        // Idempotent in both directions: a live `term:opened` racing the rehydration
        // must not turn a live tab into a restored one, or the view would replay over
        // output it already has.
        restored: (s.tabs.get(info.termId)?.restored ?? true) && (opts?.restored ?? false),
      })
      // Guarded on `already`, because `open` is idempotent and a replay of a live
      // session must not count it twice.
      const already = s.tabs.has(info.termId)
      const key = info.repo ? repoId(info.repo) : WORKSPACE_KEY
      const liveByScope =
        already || !info.alive
          ? s.liveByScope
          : { ...s.liveByScope, [key]: (s.liveByScope[key] ?? 0) + 1 }
      return {
        tabs,
        liveByScope,
        // Idempotent, for the same reason `run-store.start` is: a duplicated
        // listener or a replay overlapping a live event would otherwise render
        // two tabs — and two identical React keys — for one session.
        order: s.order.includes(info.termId) ? s.order : [...s.order, info.termId],
      }
    }),

  exit: (termId, code) =>
    set((s) => {
      const tab = s.tabs.get(termId)
      if (!tab) return s
      const tabs = new Map(s.tabs)
      tabs.set(termId, { ...tab, status: 'exited', exitCode: code })
      return { tabs, liveByScope: release(s.liveByScope, tab) }
    }),

  rename: (termId, title) =>
    set((s) => {
      const tab = s.tabs.get(termId)
      if (!tab || tab.title === title) return s
      const tabs = new Map(s.tabs)
      tabs.set(termId, { ...tab, title })
      return { tabs }
    }),

  close: (termId) => {
    // The one place an xterm instance is destroyed. Effect cleanup only ever
    // detaches the DOM node — see xterm-instance.ts.
    disposeTerm(termId)
    void api.termClose(termId).catch(() => {})
    set((s) => {
      const tab = s.tabs.get(termId)
      const tabs = new Map(s.tabs)
      tabs.delete(termId)
      const order = s.order.filter((id) => id !== termId)
      return {
        tabs,
        order,
        // Closing a live tab releases its count; closing an exited one already did.
        liveByScope: tab ? release(s.liveByScope, tab) : s.liveByScope,
        // Fall back to another tab in the same scope if there is one, otherwise
        // to the run log rather than to a tab the user cannot see.
        activeTermId:
          s.activeTermId === termId ? (order[order.length - 1] ?? null) : s.activeTermId,
      }
    })
  },

  setActive: (activeTermId) => {
    if (get().activeTermId === activeTermId) return
    set({ activeTermId })
  },
}))

/**
 * Decrements a tab's scope, deleting the key at zero so the map stays the size of
 * what is actually live. A no-op for a tab that was already exited, which is what
 * makes exit-then-close safe to call in either order.
 */
function release(
  liveByScope: Record<string, number>,
  tab: TermTab
): Record<string, number> {
  if (tab.status !== 'live') return liveByScope
  const key = termScope(tab) ?? WORKSPACE_KEY
  const next = Math.max(0, (liveByScope[key] ?? 0) - 1)
  const out = { ...liveByScope }
  if (next === 0) delete out[key]
  else out[key] = next
  return out
}

/**
 * The scope a terminal belongs to: a repo key, or `null` for workspace-level
 * sessions. Mirrors `runScope`, so the output pane's scope filter applies to
 * tabs and runs identically.
 */
export function termScope(tab: TermTab): string | null {
  return tab.ref ? repoId(tab.ref) : null
}
