import { create } from 'zustand'
import type { RepoId } from '@/domain/types'

interface ManagerState {
  /** Repo id -> the manager chosen for it. Absent means "whatever the repo says". */
  byRepo: Record<RepoId, string>
  /** `null` clears the override. */
  set(id: RepoId, manager: string | null): void
  reset(): void
}

/**
 * A per-repo "run everything with this manager instead" choice.
 *
 * In a store rather than in the action bar's own state because it has to reach
 * every surface that runs something: the scripts strip, the Run button on a row
 * or a card, the Build menu, the row menu's script submenu. Choosing bun in one
 * place and getting pnpm from another would be worse than not offering the choice.
 * `useRunAction` is where it is applied, so no call site has to remember.
 *
 * Session-scoped, and deliberately not persisted. "Run this with npm just now" is
 * a different statement from "this repo uses npm" — the second belongs in the
 * repo's own `packageManager` field, or in the app-wide default in Settings, and
 * a persisted per-repo override would quietly become a third source of truth that
 * nothing displays.
 */
export const useManagerStore = create<ManagerState>()((set) => ({
  byRepo: {},

  set: (id, manager) =>
    set((s) => {
      const next = { ...s.byRepo }
      if (manager) next[id] = manager
      else delete next[id]
      return { byRepo: next }
    }),

  reset: () => set({ byRepo: {} }),
}))
