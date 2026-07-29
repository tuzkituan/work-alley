import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Category, NeedsYouKind, RepoId } from '@/domain/types'

/** Cards read well for a handful of repos; 43 of them need a table. */
export type ViewMode = 'cards' | 'list'

export type ThemeMode = 'light' | 'dark' | 'system'

interface UiState {
  /** 'system' follows the OS setting; the other two pin it. */
  theme: ThemeMode
  /**
   * The one expanded folder, or null when everything is collapsed.
   *
   * An accordion rather than independent toggles: the card grid shows exactly one
   * folder, and only that folder's repos get scanned, so "which folder" has to be
   * a single answer. Starts null — nothing is expanded and nothing is scanned
   * until the user picks a folder.
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
  page: 'repos' | 'toolbox'
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
  setPage(page: 'repos' | 'toolbox'): void
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

      // Cycles light -> dark -> system, so every mode is reachable from one control.
      toggleTheme: () =>
        set((s) => ({
          theme: s.theme === 'light' ? 'dark' : s.theme === 'dark' ? 'system' : 'light',
        })),
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
      // Only durable preferences persist. expandedCategory is deliberately NOT
      // persisted: every launch starts fully collapsed, so no git runs until the
      // user asks for a folder.
      partialize: (s) => ({ theme: s.theme, view: s.view }),
    }
  )
)
