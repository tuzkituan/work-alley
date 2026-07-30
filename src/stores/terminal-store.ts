import { create } from 'zustand'
import { repoId, type RepoRef, type TermInfo } from '@/domain/types'
import { api } from '@/ipc/commands'
import { disposeTerm } from '@/features/terminal/xterm-instance'

export interface TermTab {
  termId: string
  title: string
  cwd: string
  ref: RepoRef | null
  argv: string[]
  startedUnix: number
  status: 'live' | 'exited'
  exitCode: number | null
}

interface TerminalState {
  tabs: Map<string, TermTab>
  order: string[]
  /**
   * Which view the output pane is showing. `null` means the run log — this is
   * the pane's view selector, not just "which terminal".
   */
  activeTermId: string | null

  open(info: TermInfo): void
  exit(termId: string, code: number): void
  rename(termId: string, title: string): void
  close(termId: string): void
  setActive(termId: string | null): void
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  tabs: new Map(),
  order: [],
  activeTermId: null,

  open: (info) =>
    set((s) => {
      const tabs = new Map(s.tabs)
      tabs.set(info.termId, {
        termId: info.termId,
        title: info.title,
        cwd: info.cwd,
        ref: info.repo,
        argv: info.argv,
        startedUnix: info.startedUnix,
        status: info.alive ? 'live' : 'exited',
        exitCode: null,
      })
      return {
        tabs,
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
      return { tabs }
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
      const tabs = new Map(s.tabs)
      tabs.delete(termId)
      const order = s.order.filter((id) => id !== termId)
      return {
        tabs,
        order,
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
 * The scope a terminal belongs to: a repo key, or `null` for workspace-level
 * sessions. Mirrors `runScope`, so the output pane's scope filter applies to
 * tabs and runs identically.
 */
export function termScope(tab: TermTab): string | null {
  return tab.ref ? repoId(tab.ref) : null
}
