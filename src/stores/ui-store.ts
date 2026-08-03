import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Category, NeedsYouKind, RepoId } from '@/domain/types'
import { COLUMNS, DEFAULT_COLUMNS, type ColumnId } from '@/features/repos/columns'

/** Cards read well for a handful of repos; 43 of them need a table. */
export type ViewMode = 'cards' | 'list'

export type ThemeMode = 'light' | 'dark'

/** The console's lighting: follow the app, or pin it. See `UiState.paneTheme`. */
export const PANE_THEMES = ['app', 'light', 'dark'] as const
export type PaneTheme = (typeof PANE_THEMES)[number]

/**
 * The skin: which *design language* the app is painted in, independent of the
 * theme's lighting. Two axes, four real looks.
 *
 * `classic` is the look this app has always had and stays the default. `metro` is
 * Microsoft's Metro / Modern UI from Windows 8: square corners, no shadows or
 * gradients at all, solid saturated accent fills for state, real dividers instead
 * of soft edges, and typography doing the work that chrome does elsewhere.
 * `adwaita` is GNOME's, from libadwaita: two radii (12px containers, 6px controls),
 * soft elevation, and chrome that sits *darker* than the content in light mode.
 *
 * Exported as a list so the persisted value can be validated against it; see
 * `migrateUiState`.
 */
export const SKINS = ['classic', 'metro', 'adwaita'] as const
export type Skin = (typeof SKINS)[number]

/**
 * Top-level views. `toolbox` and `setup` describe the machine rather than the open
 * folder, so both take the whole window and work with no workspace at all.
 *
 * `repos` no longer has a sibling tab: the old `activity` page held a commit list the
 * detail page already shows per repo, and a container list a `docker ps` already
 * answers, so the strip that switched between them was two clicks to nothing.
 */
export type Page = 'repos' | 'toolbox' | 'setup' | 'settings' | 'accounts' | 'projects'

/**
 * The UI font choices, and the stack each one resolves to.
 *
 * A curated list, not a font manager: the webview cannot enumerate installed
 * fonts, and the CSP blocks anything not bundled — so the honest offer is the
 * families this app ships, plus whatever the OS calls its own UI face.
 *
 * Each stack keeps the full fallback chain from `wa-bridge.css`. An override that
 * drops it renders as Times the moment a glyph is missing.
 */
export const UI_FONTS = [
  { id: 'geist', label: 'Geist', stack: "'Geist Variable', ui-sans-serif, system-ui, sans-serif" },
  {
    id: 'archivo',
    label: 'Archivo',
    stack: "'Archivo Variable', ui-sans-serif, system-ui, sans-serif",
  },
  { id: 'inter', label: 'Inter', stack: "'Inter Variable', ui-sans-serif, system-ui, sans-serif" },
  { id: 'system', label: 'System', stack: 'ui-sans-serif, system-ui, sans-serif' },
] as const
export type UiFont = (typeof UI_FONTS)[number]['id']

export const MONO_FONTS = [
  {
    id: 'jetbrains',
    label: 'JetBrains Mono',
    stack:
      "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  {
    id: 'fira-code',
    label: 'Fira Code',
    stack: "'Fira Code Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  {
    id: 'source-code-pro',
    label: 'Source Code Pro',
    stack:
      "'Source Code Pro Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  {
    id: 'system',
    label: 'System',
    stack: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
] as const
export type MonoFont = (typeof MONO_FONTS)[number]['id']

/** Find-or-default, so a stale persisted id can never yield `undefined`. */
export function uiFontStack(id: UiFont): string {
  return (UI_FONTS.find((f) => f.id === id) ?? UI_FONTS[0]).stack
}

export function monoFontStack(id: MonoFont): string {
  return (MONO_FONTS.find((f) => f.id === id) ?? MONO_FONTS[0]).stack
}

/* Interface scale.
 *
 * The floor is 80%: the table's narrowest breakpoint already drops columns at
 * ~1000px, and below 0.8 the 9.5px metadata type stops being legible on a 1x
 * display. The ceiling is 150%, where the repo row's five columns still fit a
 * 1280px window — past that the layout is fighting itself rather than helping.
 * 10% steps, because 5% is a change you cannot see and 25% overshoots. */
export const ZOOM_MIN = 0.8
export const ZOOM_MAX = 1.5
export const ZOOM_STEP = 0.1

/** Clamped and snapped to the step, so the stored value is always one of the stops. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1
  const snapped = Math.round(z / ZOOM_STEP) * ZOOM_STEP
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(snapped * 100) / 100))
}

/**
 * The repo detail page's tabs. Exported as a list so the persisted value can be
 * validated against it — see `migrate`.
 *
 * Changes leads: the question you open a repo with is far more often "what have I
 * got here" than "what are the open PRs".
 */
export const DETAIL_TABS = [
  'commits',
  'changes',
  'branches',
  'packages',
  'prs',
  'actions',
  'runs',
] as const
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
  /**
   * Show every repo in the workspace at once, ignoring folders.
   *
   * Mutually exclusive with `expandedCategory` and takes precedence over it. Exists
   * because the one-folder-at-a-time model makes any workspace-wide question — "what
   * is running right now?" — a matter of opening each folder in turn and remembering
   * what you saw.
   */
  allRepos: boolean
  /** Repo whose card is highlighted with the primary border. */
  activeRepoId: RepoId | null
  /** Repo whose detail page replaces the list, or null for the list. */
  detailRepoId: RepoId | null
  /**
   * Which detail tab is open. Reset to the first one every time a repo is opened.
   *
   * It used to be a persisted preference, on the theory that someone reviewing
   * PRs wants that tab on every repo in turn. In practice the opposite reads as a
   * bug: opening a repo and landing on Packages — a network call for a question
   * you did not ask, about a repo you have not looked at yet — is not what
   * "open this repo" means. Changes is what it means, and it is free.
   *
   * Not persisted, because nothing survives to read it: `detailRepoId` is not
   * persisted either, so a launch never starts on a detail page.
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
  /**
   * Repos the output pane keeps a tab for.
   *
   * The tabs used to be derived purely from activity, so a scope disappeared the
   * moment its last run finished and was dismissed — the tab you were reading
   * closed itself and the pane jumped back to the workspace. A tab now stays until
   * it is closed by hand: opened by selecting a scope or by activity appearing in
   * one, removed only by `closeScope`.
   *
   * Not persisted. Runs and shells are restored from the backend on launch, and
   * that restoration is what re-opens the tabs — a saved list would otherwise offer
   * tabs for scopes with nothing left in them.
   */
  openScopes: RepoId[]
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
  /**
   * Interface scale, 1 = 100%. Written to `<html>`'s `zoom`; see `applyToDom`.
   *
   * A separate axis from the font choice, and it has to be: this app's chrome is
   * sized in px (11px labels, 22px chips, a 214px rail), so a bigger typeface alone
   * gives you larger text in boxes that did not grow. Zoom scales the whole layout,
   * which is what "this window is too small to read" actually asks for — and it is
   * per app, unlike the OS display scale.
   */
  zoom: number
  /**
   * Light or dark for the output pane and terminals, independent of the app.
   *
   * A real preference rather than a gimmick: a dark console under a light app is
   * how most terminals are set up, and the pane is the one surface here whose
   * content is a *program's* output — with its own ANSI colours, tuned by whoever
   * wrote the tool for a dark background. `'app'` follows the app theme and is the
   * default, so nobody who does not want this has to know it exists.
   */
  paneTheme: PaneTheme
  /**
   * Which repo-table columns the user wants. See `features/repos/columns.ts`.
   *
   * A wish, not the truth: a narrow table drops columns from this set to make the
   * row fit, and never adds one back. Stored as a full record rather than a list of
   * enabled ids so a build that adds a column can give it a default without a
   * migration — an unknown key is simply ignored, a missing one falls back.
   */
  columns: Record<ColumnId, boolean>
  /** UI typeface. Written to `--font-sans`; see `applyToDom`. */
  uiFont: UiFont
  /** Monospace typeface, for the output pane, the terminal and every numeric column. */
  monoFont: MonoFont
  /**
   * The workspace `expandedCategory` was chosen in.
   *
   * Persisted alongside it, because a bare folder name means nothing without the
   * workspace that contains it: two workspaces both having a `frontend/` is normal,
   * and restoring one's selection into the other is how the app appears to pick a
   * folder at random.
   */
  expandedCategoryRoot: string | null
  /**
   * The open workspace root, mirrored from bootstrap.
   *
   * NOT persisted: it is a fact about the backend, and a stale copy would stamp the
   * next folder selection with a workspace that is no longer open.
   */
  workspaceRoot: string

  toggleTheme(): void
  setTheme(theme: ThemeMode): void
  toggleSkin(): void
  setSkin(skin: Skin): void
  setTermFontSize(size: number): void
  /** Clamped to ZOOM_MIN..ZOOM_MAX and rounded to the step. */
  setPaneTheme(theme: PaneTheme): void
  setColumn(id: ColumnId, on: boolean): void
  resetColumns(): void
  setZoom(zoom: number): void
  /** One step out or in. `dir` is +1 or -1. */
  nudgeZoom(dir: 1 | -1): void
  setUiFont(font: UiFont): void
  setMonoFont(font: MonoFont): void
  setWorkspaceRoot(root: string): void
  toggleCategory(category: Category): void
  setCategory(category: Category | null): void
  setAllRepos(on: boolean): void
  setActiveRepo(id: RepoId | null): void
  openDetail(id: RepoId): void
  closeDetail(): void
  setDetailTab(tab: DetailTab): void
  toggleDetailHeader(): void
  setOutputScope(scope: RepoId | null): void
  /** Adds scopes to the pane's tab strip, ignoring the ones already there. */
  rememberScopes(ids: RepoId[]): void
  /** The only thing that removes a tab. Falls back to the workspace scope. */
  closeScope(id: RepoId): void
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
    zoom?: unknown
    paneTheme?: unknown
    columns?: unknown
    detailHeaderCollapsed?: unknown
    allRepos?: unknown
    uiFont?: unknown
    monoFont?: unknown
    expandedCategoryRoot?: unknown
  }
  return {
    theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'light',
    // Validated against the list, like `detailTab`: a blob from before the skin
    // existed simply has no key, which lands on 'classic' — the right answer for
    // an opt-in look nobody has chosen yet.
    skin: SKINS.includes(p.skin as Skin) ? (p.skin as Skin) : 'classic',
    view: p.view === 'cards' || p.view === 'list' ? p.view : 'list',
    expandedCategory: typeof p.expandedCategory === 'string' ? p.expandedCategory : null,
    // Only an exact `true` opts in: a blob from before this key existed has no
    // opinion, and defaulting to the flat list would scan the whole workspace on
    // first launch after an upgrade.
    allRepos: p.allRepos === true,
    termFontSize:
      typeof p.termFontSize === 'number' && p.termFontSize >= 8 && p.termFontSize <= 20
        ? p.termFontSize
        : 12,
    // Through the same clamp the setter uses, so a blob written by a build with a
    // different range — or hand-edited — cannot pin the window at 300%.
    zoom: typeof p.zoom === 'number' ? clampZoom(p.zoom) : 1,
    // Validated against the list like `skin`. A blob with no key lands on 'app',
    // which is the behaviour every build before this one had.
    paneTheme: PANE_THEMES.includes(p.paneTheme as PaneTheme) ? (p.paneTheme as PaneTheme) : 'app',
    // Merged over the defaults rather than trusted: a blob written before a column
    // existed has no key for it, and one written after it was removed has a key
    // nothing reads. Both are normal across an upgrade.
    columns: { ...DEFAULT_COLUMNS, ...pickColumns(p.columns) },
    detailHeaderCollapsed: p.detailHeaderCollapsed === true,
    // Validated against the tables, exactly like `skin`: an id from a build that
    // shipped a family this one does not lands on the default rather than on a
    // stack the CSS never declared.
    // Geist is the default now, and 'archivo' was the old one — so a stored
    // 'archivo' is almost always a value nobody chose. Moved rather than kept: the
    // alternative is that every existing install keeps a font it never picked and
    // the new default only ever reaches fresh machines. Deliberately reversible in
    // one click, which is why this is a fair trade for the handful of people who
    // did choose it.
    uiFont: p.uiFont === 'archivo'
      ? 'geist'
      : UI_FONTS.some((f) => f.id === p.uiFont)
        ? (p.uiFont as UiFont)
        : 'geist',
    monoFont: MONO_FONTS.some((f) => f.id === p.monoFont) ? (p.monoFont as MonoFont) : 'jetbrains',
    // No stamp means the selection predates this key. Kept rather than discarded:
    // the App-level check also verifies the folder still exists, so the worst case
    // is one restored selection that has to prove itself.
    expandedCategoryRoot:
      typeof p.expandedCategoryRoot === 'string' ? p.expandedCategoryRoot : null,
  }
}

/** Only known ids, only booleans. Everything else in the blob is dropped. */
function pickColumns(raw: unknown): Partial<Record<ColumnId, boolean>> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<Record<ColumnId, boolean>> = {}
  for (const c of COLUMNS) {
    const v = (raw as Record<string, unknown>)[c.id]
    if (typeof v === 'boolean') out[c.id] = v
  }
  return out
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'light',
      skin: 'classic',
      expandedCategory: null,
      allRepos: false,
      activeRepoId: null,
      detailRepoId: null,
      detailTab: DETAIL_TABS[0],
      detailHeaderCollapsed: false,
      outputScope: null,
      openScopes: [],
      setupFocusStepId: null,
      filterText: '',
      filterChip: null,
      view: 'list',
      page: 'repos',
      paletteOpen: false,
      termFontSize: 12,
      zoom: 1,
      paneTheme: 'app',
      columns: DEFAULT_COLUMNS,
      uiFont: 'geist',
      monoFont: 'jetbrains',
      expandedCategoryRoot: null,
      workspaceRoot: '',

      toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
      setTheme: (theme) => set({ theme }),
      // Cycles the list rather than flipping two values. It was a binary
      // classic/metro swap, which silently skipped any third skin — and the command
      // palette's "switch skin" is the only way to reach this without the menu.
      toggleSkin: () =>
        set((s) => ({ skin: SKINS[(SKINS.indexOf(s.skin) + 1) % SKINS.length]! })),
      setSkin: (skin) => set({ skin }),
      setTermFontSize: (size) => set({ termFontSize: Math.min(20, Math.max(8, size)) }),
      setPaneTheme: (paneTheme) => set({ paneTheme }),
      setColumn: (id, on) => set((s) => ({ columns: { ...s.columns, [id]: on } })),
      resetColumns: () => set({ columns: DEFAULT_COLUMNS }),
      setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
      nudgeZoom: (dir) => set((s) => ({ zoom: clampZoom(s.zoom + dir * ZOOM_STEP) })),
      setUiFont: (uiFont) => set({ uiFont }),
      setMonoFont: (monoFont) => set({ monoFont }),
      setWorkspaceRoot: (workspaceRoot) => set({ workspaceRoot }),

      // Both category actions leave all-repos mode: the two are alternative answers
      // to "which repos am I looking at", and a folder click that left the flat list
      // up would read as doing nothing — the same bug the FOLDER_SCOPED note
      // describes.
      toggleCategory: (category) =>
        set((s) => ({
          expandedCategory: s.expandedCategory === category ? null : category,
          // Stamped with the workspace it was chosen in, so a launch into a
          // different one does not inherit it.
          expandedCategoryRoot: s.workspaceRoot,
          allRepos: false,
          ...FOLDER_SCOPED,
        })),

      setCategory: (expandedCategory) =>
        set((s) => ({
          expandedCategory,
          expandedCategoryRoot: s.workspaceRoot,
          allRepos: false,
          ...FOLDER_SCOPED,
        })),

      // Clears the folder rather than remembering it. Coming back out of all-repos
      // mode lands on the workspace picker, which is honest about the fact that no
      // folder is selected — quietly restoring one would make the toggle asymmetric.
      setAllRepos: (allRepos) =>
        set({ allRepos, expandedCategory: null, expandedCategoryRoot: null, ...FOLDER_SCOPED }),
      // Selecting a repo also points the pane at it: the two disagreeing is what made
      // "where did my run go" a question.
      setActiveRepo: (activeRepoId) => set({ activeRepoId, outputScope: activeRepoId }),
      // Opening a detail page also selects the repo, so the output pane follows.
      //
      // `outputScope` explicitly: this used to set `activeRepoId` alone and claim the
      // pane followed, but scope is a separate field and only `setActiveRepo` was
      // updating it — so opening a repo left the pane on whatever scope it was on,
      // showing another repo's runs beside this one's detail page.
      openDetail: (id) =>
        set({
          detailRepoId: id,
          activeRepoId: id,
          outputScope: id,
          // Every repo opens on Changes. See the field.
          detailTab: DETAIL_TABS[0],
        }),
      closeDetail: () => set({ detailRepoId: null }),
      setDetailTab: (detailTab) => set({ detailTab }),
      toggleDetailHeader: () =>
        set((s) => ({ detailHeaderCollapsed: !s.detailHeaderCollapsed })),
      setOutputScope: (outputScope) => set({ outputScope }),

      rememberScopes: (ids) =>
        set((s) => {
          const missing = ids.filter((id) => !s.openScopes.includes(id))
          // The same array when nothing is new: this is called from an effect on
          // every activity change, and a fresh array each time would re-render the
          // tab strip on every log line.
          return missing.length ? { openScopes: [...s.openScopes, ...missing] } : s
        }),

      closeScope: (id) =>
        set((s) => ({
          openScopes: s.openScopes.filter((x) => x !== id),
          // Closing the tab you are on has to land somewhere, and the workspace is
          // the one scope that always exists. `activeRepoId` is deliberately left
          // alone — closing a pane tab is not deselecting the repo row.
          outputScope: s.outputScope === id ? null : s.outputScope,
        })),
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
        expandedCategoryRoot: s.expandedCategoryRoot,
        allRepos: s.allRepos,
        termFontSize: s.termFontSize,
        zoom: s.zoom,
        paneTheme: s.paneTheme,
        columns: s.columns,
        uiFont: s.uiFont,
        monoFont: s.monoFont,
        detailHeaderCollapsed: s.detailHeaderCollapsed,
      }),
      // `partialize` decides what is *written*, not what is read: a blob saved by
      // an older build is still merged over the defaults on load, keys and all. So
      // the version is bumped whenever the shape changes, and `migrate` rebuilds the
      // state from scratch rather than trusting whatever was stored.
      version: 15,
      migrate: migrateUiState,
    }
  )
)
