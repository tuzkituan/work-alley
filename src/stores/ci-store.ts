import { create } from 'zustand'
import { repoId, type RepoId, type RepoRef } from '@/domain/types'

/**
 * How many repos are watched for CI at once.
 *
 * Every watched repo is a `gh` process and a REST call whenever the rail refetches,
 * and GitHub has no cross-repo endpoint for workflow runs — so this is the whole
 * cost control. Eight is roughly "the repos you are working in today"; the ninth
 * evicts the one you opened longest ago.
 */
const CAP = 8

interface CiState {
  /** Newest last, so the front of the list is the eviction candidate. */
  watched: RepoRef[]
  /** Starts watching a repo's CI. Idempotent; re-watching moves it to newest. */
  watch(ref: RepoRef): void
  /** Forgets everything. The bridge calls this when the workspace changes. */
  reset(): void
}

/**
 * Which repos the app is keeping an eye on for CI.
 *
 * A repo joins when its Actions tab is opened, and that is the only way in:
 * finding out otherwise would mean asking GitHub about every repo in the
 * workspace on a timer, which is 113 processes a tick for an answer that is
 * usually "nothing is running".
 *
 * The consequence is worth stating plainly, and the rail says it too: an empty CI
 * list means "nothing running in the repos you have looked at", not "nothing
 * running".
 *
 * Session-scoped on purpose — not persisted. A watch is about what you are doing
 * now, and restoring eight of them on launch would fire eight `gh` calls before
 * the window is usable.
 */
export const useCiStore = create<CiState>()((set) => ({
  watched: [],

  watch: (ref) =>
    set((s) => {
      const id = repoId(ref)
      const without = s.watched.filter((r) => repoId(r) !== id)
      return { watched: [...without, ref].slice(-CAP) }
    }),

  reset: () => set({ watched: [] }),
}))

/** Stable ids, for the rail's query list. */
export function watchedIds(watched: RepoRef[]): RepoId[] {
  return watched.map(repoId)
}
