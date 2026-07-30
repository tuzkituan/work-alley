import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Category, NeedsYouKind, RepoId } from '@/domain/types'

/** Cards read well for a handful of repos; 43 of them need a table. */
export type ViewMode = 'cards' | 'list'

export type ThemeMode = 'light' | 'dark'

/**
 * The skin: which *design language* the app is painted in, independent of the
 * theme's lighting. Two axes, four real looks.
 *
 * `classic` is the look this app has always had and stays the default. `metro` is
 * Microsoft's Metro / Modern UI from Windows 8: square corners, no shadows or
 * gradients at all, solid saturated accent fills for state, real dividers instead
 * of soft edges, and typography doing the work that chrome does elsewhere.
 * Exported as a list so the persisted value can be validated against it; see
 * `migrateUiState`.
 */
export const SKINS = ['classic', 'metro'] as const
export type Skin = (typeof SKINS)[number]

/**
 * Top-level views. `toolbox` and `setup` describe the machine rather than the open
 * folder, so both take the whole window and work with no workspace at all.
 *
 * `repos` no longer has a sibling tab: the old `activity` page held a commit list the
 * detail page already shows per repo, and a container list a `docker ps` already
 * answers, so the strip that switched between them was two clicks to nothing.
 */
export type Page = 'repos' | 'toolbox' | 'setup'

/**
 * The repo detail page's tabs. Exported as a list so the persisted value can be
 * validated against it — see `migrate`.
 *
 * Changes leads: the question you open a repo with is far more often "what have I
 * got here" than "what are the open PRs".
 */
export const DETAIL_TABS = ['changes', 'commits', 'branches', 'prs', 'runs'] as const
export type DetailTab = (typeof DETAIL_TABS)[number]

/**
 * State that belongs to whichever folder is open, and so must not survive a switch
 * to a different one.
 *
 * Shared by both category actions rather than written out twice, because that is
 * exactly how this broke: the rail moved from `toggleCategory` to `setCategory`, and
 * only the former cleared the detail page. Clicking a folder while a repo was open
 * changed `expandedCategory` under a centre panel that `RepoGrid` still short-
 * circuits to the detail view — so the click appeared to do nothing at all.
 */
const FOLDER_SCOPED = {
  activeRepoId: null,
  detailRepoId: null,
  // Paired with `activeRepoId` everywhere else — see `setActiveRepo` — so clearing
  // one without the other would leave the pane scoped to a repo in the folder you
  // just left, with no tab selected to say so.
  outputScope: null,
  filterChip: null,
} as const

interface UiState {
  /** An explicit choice. The app does not follow the OS theme. */
  theme: ThemeMode
  /** Which surface treatment to paint in. Orthogonal to `theme`. */
  skin: Skin
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
  /**
   * Which detail tab is open, remembered across repos and restarts.
   *
   * Persisted because the tab is a working preference, not a property of a repo:
   * someone reviewing PRs opens repo after repo wanting the PR tab every time, and
   * resetting to the default on each one is a click per repo.
   */
  detailTab: DetailTab
  /**
   * Collapses the detail header to just its identity row.
   *
   * Worth a preference because at the centre panel's 420px floor the full header is
   * ~230px of a ~600px panel — more chrome than content for anyone who opened the
   * page to read a file list.
   */
  detailHeaderCollapsed: boolean
  /**
   * A setup step to scroll to and highlight, set by the "Set it up" action on a
   * missing-tool toast.
   *
   * Deliberately **not** persisted: a focus target lives for a few seconds, and
   * putting it in `partialize` would force a version bump and a migrate branch for
   * something meaningless on the next launch.
   */
  setupFocusStepId: string | null
  /**
   * Which scope the output pane shows: a repo id, or null for the workspace.
   *
   * In the store rather than in the pane because the *bridge* has to move it — a run
   * or a terminal that has just spawned should be what you are looking at, and a
   * workspace-level one lives in a scope the pane may not be on. Doing that through
   * `activeRepoId` was not an option: setting it to null to reach the workspace scope
   * would also clear the repo table's selection.
   */
  outputScope: RepoId | null
  filterText: string
  filterChip: NeedsYouKind | null
  view: ViewMode
  /** Which top-level page the centre panel shows. */
  page: Page
  paletteOpen: boolean
  /**
   * Integrated terminal font size. The manual escape hatch for a narrow output
   * pane: at 12px the default width is only ~44 columns and curses apps assume
   * 80, so being able to shrink the type is how you fit one without resizing.
   */
  termFontSize: number

  toggleTheme(): void
  setTheme(theme: ThemeMode): void
  toggleSkin(): void
  setSkin(skin: Skin): void
  setTermFontSize(size: number): void
  toggleCategory(category: Category): void
  setCategory(category: Category | null): void
  setActiveRepo(id: RepoId | null): void
  openDetail(id: RepoId): void
  closeDetail(): void
  setDetailTab(tab: DetailTab): void
  toggleDetailHeader(): void
  setOutputScope(scope: RepoId | null): void
  /** Opens the setup page focused on one step. */
  openSetupAt(stepId: string): void
  clearSetupFocus(): void
  setFilterText(text: string): void
  toggleFilterChip(kind: NeedsYouKind): void
  clearFilters(): void
  setView(view: ViewMode): void
  setPage(page: Page): void
  setPaletteOpen(open: boolean): void
}

/**
 * Rebuilds the persisted slice from whatever an older build wrote.
 *
 * Named and exported rather than inlined into the persist options so it can be
 * tested directly: it is the one function here that can silently corrupt state —
 * it runs against a blob this build never wrote, and whatever it returns *is* the
 * store. Every field is validated, and anything unrecognised falls back rather
 * than being trusted.
 */
export function migrateUiState(persisted: unknown) {
  const p = (persisted ?? {}) as {
    theme?: unknown
    skin?: unknown
    view?: unknown
    expandedCategory?: unknown
    termFontSize?: unknown
    detailTab?: unknown
    detailHeaderCollapsed?: unknown
  }
  return {
    theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'light',
    // Validated against the list, like `detailTab`: a blob from before the skin
    // existed simply has no key, which lands on 'classic' — the right answer for
    // an opt-in look nobody has chosen yet.
    skin: SKINS.includes(p.skin as Skin) ? (p.skin as Skin) : 'classic',
    view: p.view === 'cards' || p.view === 'list' ? p.view : 'list',
    expandedCategory: typeof p.expandedCategory === 'string' ? p.expandedCategory : null,
    termFontSize:
      typeof p.termFontSize === 'number' && p.termFontSize >= 8 && p.termFontSize <= 20
        ? p.termFontSize
        : 12,
    // Validated against the list rather than accepted as any string: a tab removed
    // in a later build would otherwise leave the page with no TabsContent
    // matching, and so blank.
    detailTab: DETAIL_TABS.includes(p.detailTab as DetailTab) ? (p.detailTab as DetailTab) : 'changes',
    detailHeaderCollapsed: p.detailHeaderCollapsed === true,
  }
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'light',
      skin: 'classic',
      expandedCategory: null,
      activeRepoId: null,
      detailRepoId: null,
      detailTab: 'changes',
      detailHeaderCollapsed: false,
      outputScope: null,
      setupFocusStepId: null,
      filterText: '',
      filterChip: null,
      view: 'list',
      page: 'repos',
      paletteOpen: false,
      termFontSize: 12,

      toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
      setTheme: (theme) => set({ theme }),
      toggleSkin: () => set((s) => ({ skin: s.skin === 'classic' ? 'metro' : 'classic' })),
      setSkin: (skin) => set({ skin }),
      setTermFontSize: (size) => set({ termFontSize: Math.min(20, Math.max(8, size)) }),

      toggleCategory: (category) =>
        set((s) => ({
          expandedCategory: s.expandedCategory === category ? null : category,
          ...FOLDER_SCOPED,
        })),

      setCategory: (expandedCategory) => set({ expandedCategory, ...FOLDER_SCOPED }),
      // Selecting a repo also points the pane at it: the two disagreeing is what made
      // "where did my run go" a question.
      setActiveRepo: (activeRepoId) => set({ activeRepoId, outputScope: activeRepoId }),
      // Opening a detail page also selects the repo, so the output pane follows.
      //
      // `outputScope` explicitly: this used to set `activeRepoId` alone and claim the
      // pane followed, but scope is a separate field and only `setActiveRepo` was
      // updating it — so opening a repo left the pane on whatever scope it was on,
      // showing another repo's runs beside this one's detail page.
      openDetail: (id) => set({ detailRepoId: id, activeRepoId: id, outputScope: id }),
      closeDetail: () => set({ detailRepoId: null }),
      setDetailTab: (detailTab) => set({ detailTab }),
      toggleDetailHeader: () =>
        set((s) => ({ detailHeaderCollapsed: !s.detailHeaderCollapsed })),
      setOutputScope: (outputScope) => set({ outputScope }),
      openSetupAt: (stepId) => set({ page: 'setup', setupFocusStepId: stepId }),
      clearSetupFocus: () => set({ setupFocusStepId: null }),
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
        skin: s.skin,
        view: s.view,
        expandedCategory: s.expandedCategory,
        termFontSize: s.termFontSize,
        detailTab: s.detailTab,
        detailHeaderCollapsed: s.detailHeaderCollapsed,
      }),
      // `partialize` decides what is *written*, not what is read: a blob saved by
      // an older build is still merged over the defaults on load, keys and all. So
      // the version is bumped whenever the shape changes, and `migrate` rebuilds the
      // state from scratch rather than trusting whatever was stored.
      version: 8,
      migrate: migrateUiState,
    }
  )
)
