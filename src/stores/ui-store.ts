import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Category, NeedsYouKind, RepoId } from '@/domain/types'

/** Cards read well for a handful of repos; 43 of them need a table. */
export type ViewMode = 'cards' | 'list'

export type ThemeMode = 'light' | 'dark'

/**
 * Top-level views. `toolbox` and `setup` describe the machine rather than the open
 * folder, so both take the whole window and work with no workspace at all.
 */
export type Page = 'repos' | 'activity' | 'toolbox' | 'setup'

interface UiState {
  /** An explicit choice. The app does not follow the OS theme. */
  theme: ThemeMode
  /**
   * The selected folder, or null when none is.
   *
   * Exactly one at a time: the grid shows one folder and only that folder gets
   * scanned, so "which folder" has to be a single answer. Persisted, so reopening
   * the app returns you to what you were working on — which does mean one scan on
   * launch, deliberately.
   */
  expandedCategory: Category | null
  /** Repo whose card is highlighted with the primary border. */
  activeRepoId: RepoId | null
  /** Repo whose detail page replaces the list, or null for the list. */
  detailRepoId: RepoId | null
  filterText: string
  filterChip: NeedsYouKind | null
  view: ViewMode
  /** Which top-level page the centre panel shows. */
  page: Page
  paletteOpen: boolean

  toggleTheme(): void
  setTheme(theme: ThemeMode): void
  toggleCategory(category: Category): void
  setCategory(category: Category | null): void
  setActiveRepo(id: RepoId | null): void
  openDetail(id: RepoId): void
  closeDetail(): void
  setFilterText(text: string): void
  toggleFilterChip(kind: NeedsYouKind): void
  clearFilters(): void
  setView(view: ViewMode): void
  setPage(page: Page): void
  setPaletteOpen(open: boolean): void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'light',
      expandedCategory: null,
      activeRepoId: null,
      detailRepoId: null,
      filterText: '',
      filterChip: null,
      view: 'list',
      page: 'repos',
      paletteOpen: false,

      toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
      setTheme: (theme) => set({ theme }),

      toggleCategory: (category) =>
        set((s) => ({
          expandedCategory: s.expandedCategory === category ? null : category,
          // Selection, detail page and filters belong to the folder that was open.
          activeRepoId: null,
          detailRepoId: null,
          filterChip: null,
        })),

      setCategory: (expandedCategory) => set({ expandedCategory, activeRepoId: null }),
      setActiveRepo: (activeRepoId) => set({ activeRepoId }),
      // Opening a detail page also selects the repo, so the output pane follows.
      openDetail: (id) => set({ detailRepoId: id, activeRepoId: id }),
      closeDetail: () => set({ detailRepoId: null }),
      setFilterText: (filterText) => set({ filterText }),
      toggleFilterChip: (kind) => set((s) => ({ filterChip: s.filterChip === kind ? null : kind })),
      clearFilters: () => set({ filterText: '', filterChip: null }),
      setView: (view) => set({ view }),
      setPage: (page) => set({ page }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    }),
    {
      name: 'work-alley:ui',
      // Durable preferences plus the selected folder, so the app reopens where you
      // left it. The folder is validated on load: a workspace switch or a renamed
      // directory must not leave a selection pointing at a folder that is gone.
      partialize: (s) => ({
        theme: s.theme,
        view: s.view,
        expandedCategory: s.expandedCategory,
      }),
      // `partialize` decides what is *written*, not what is read: a blob saved by
      // an older build is still merged over the defaults on load, keys and all. So
      // the version is bumped whenever the shape changes, and `migrate` rebuilds the
      // state from scratch rather than trusting whatever was stored.
      version: 5,
      migrate: (persisted) => {
        const p = (persisted ?? {}) as {
          theme?: unknown
          view?: unknown
          expandedCategory?: unknown
        }
        return {
          theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'light',
          view: p.view === 'cards' || p.view === 'list' ? p.view : 'list',
          expandedCategory:
            typeof p.expandedCategory === 'string' ? p.expandedCategory : null,
        } as never
      },
    }
  )
)
