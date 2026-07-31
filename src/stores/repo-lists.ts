import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { repoId, type RepoId, type RepoRef } from '@/domain/types'

/** Past this, "recent" stops meaning anything and the rail runs out of room. */
const RECENT_CAP = 6

interface Lists {
  pinned: RepoRef[]
  recent: RepoRef[]
}

interface RepoListsState {
  /**
   * Keyed by workspace root, because a repo list is only meaningful inside the
   * workspace that contains it — and two workspaces routinely hold repos with the
   * same name.
   */
  byRoot: Record<string, Lists>
  pinned(root: string): RepoRef[]
  recent(root: string): RepoRef[]
  isPinned(root: string, id: RepoId): boolean
  togglePin(root: string, ref: RepoRef): void
  /** Records a visit. Called when a repo's detail page opens. */
  touch(root: string, ref: RepoRef): void
  /** Drops repos that are no longer in the workspace, after a scan. */
  prune(root: string, present: Set<RepoId>): void
}

const EMPTY: Lists = { pinned: [], recent: [] }

/**
 * Repos worth one click: the ones you pinned, and the ones you were just in.
 *
 * Persisted, unlike the CI watch list, because these *are* durable — a favourite
 * that forgets itself on relaunch is not a favourite. Kept in the frontend rather
 * than in `config.json` because nothing in Rust needs to know: no command takes a
 * pin, and putting it there would mean an IPC round trip to render a rail section.
 *
 * Recent excludes anything pinned. A repo you visit daily would otherwise fill
 * both lists, and the second copy says nothing the first did not.
 */
export const useRepoLists = create<RepoListsState>()(
  persist(
    (set, get) => ({
      byRoot: {},

      pinned: (root) => get().byRoot[root]?.pinned ?? EMPTY.pinned,
      recent: (root) => {
        const lists = get().byRoot[root]
        if (!lists) return EMPTY.recent
        const pinnedIds = new Set(lists.pinned.map(repoId))
        return lists.recent.filter((r) => !pinnedIds.has(repoId(r)))
      },

      isPinned: (root, id) =>
        (get().byRoot[root]?.pinned ?? []).some((r) => repoId(r) === id),

      togglePin: (root, ref) =>
        set((s) => {
          const lists = s.byRoot[root] ?? EMPTY
          const id = repoId(ref)
          const on = lists.pinned.some((r) => repoId(r) === id)
          return {
            byRoot: {
              ...s.byRoot,
              [root]: {
                ...lists,
                // Newest pin last, so the list reads in the order you built it
                // rather than reshuffling under the cursor.
                pinned: on
                  ? lists.pinned.filter((r) => repoId(r) !== id)
                  : [...lists.pinned, ref],
              },
            },
          }
        }),

      prune: (root, present) =>
        set((s) => {
          const lists = s.byRoot[root]
          if (!lists) return s
          const keep = (r: RepoRef) => present.has(repoId(r))
          const pinned = lists.pinned.filter(keep)
          const recent = lists.recent.filter(keep)
          // Nothing changed: return the same state, or every scan re-renders the
          // rail for no reason.
          if (pinned.length === lists.pinned.length && recent.length === lists.recent.length) {
            return s
          }
          return { byRoot: { ...s.byRoot, [root]: { pinned, recent } } }
        }),

      touch: (root, ref) =>
        set((s) => {
          const lists = s.byRoot[root] ?? EMPTY
          const id = repoId(ref)
          const without = lists.recent.filter((r) => repoId(r) !== id)
          // Newest first here, which is the opposite of pinned and deliberately so:
          // this list is ordered *by* recency, and that is the only thing it says.
          return {
            byRoot: {
              ...s.byRoot,
              [root]: { ...lists, recent: [ref, ...without].slice(0, RECENT_CAP) },
            },
          }
        }),
    }),
    {
      name: 'work-alley:repo-lists',
      version: 1,
      // Keyed by root, so a workspace that is gone costs one unread object rather
      // than leaking its repos into the one that is open.
      partialize: (s) => ({ byRoot: s.byRoot }),
    }
  )
)
