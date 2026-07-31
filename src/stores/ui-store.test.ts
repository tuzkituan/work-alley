import { describe, expect, it } from 'bun:test'
import {
  migrateUiState,
  MONO_FONTS,
  SKINS,
  UI_FONTS,
  useUiStore,
  type Skin,
} from './ui-store'
import { keepRememberedCategory } from '@/features/workspace/remembered-category'

/**
 * `migrateUiState` is the function that can silently corrupt state: it runs
 * against a blob written by an older build, and whatever it returns becomes the
 * store. The skin is the newest key in it, so these cases pin the two failure
 * modes that matter — an old blob that predates the key entirely, and a value
 * that is not a skin at all.
 */
const migrate = migrateUiState

describe('ui store — skin', () => {
  it('defaults to classic, so the metro skin is opt-in', () => {
    expect(useUiStore.getState().skin).toBe('classic')
  })

  it('toggles through every skin and wraps, rather than flipping two', () => {
    // It used to be a binary classic/metro swap, which silently skipped any skin
    // added afterwards — and the command palette's "switch skin" is the only way to
    // reach this without the menu. Asserted against SKINS so adding a fourth does
    // not need this test edited, only its coverage extended for free.
    expect(useUiStore.getState().skin).toBe(SKINS[0])
    for (let i = 1; i < SKINS.length; i++) {
      useUiStore.getState().toggleSkin()
      expect(useUiStore.getState().skin).toBe(SKINS[i]!)
    }
    // Wraps back to the first rather than sticking on the last.
    useUiStore.getState().toggleSkin()
    expect(useUiStore.getState().skin).toBe(SKINS[0])
  })

  it('sets any skin directly', () => {
    for (const s of SKINS) {
      useUiStore.getState().setSkin(s)
      expect(useUiStore.getState().skin).toBe(s)
    }
    useUiStore.getState().setSkin('classic')
  })

  it('migrates a blob from before the skin existed to classic', () => {
    // A real v7 payload: every key it had, and no `skin`. Nobody gets a look they
    // did not choose on upgrade.
    const v7 = {
      theme: 'dark',
      view: 'cards',
      expandedCategory: 'fe',
      termFontSize: 14,
      detailTab: 'commits',
      detailHeaderCollapsed: true,
    }
    const out = migrate(v7)
    expect(out.skin).toBe('classic')
    // The rest of the blob must survive the bump — the whole point of migrating
    // rather than discarding.
    expect(out.theme).toBe('dark')
    expect(out.view).toBe('cards')
    expect(out.termFontSize).toBe(14)
    // `detailTab` is deliberately *not* carried across: every repo now opens on
    // Changes, so a stored tab is a value nothing would ever read.
    expect(out).not.toHaveProperty('detailTab')
  })

  it('rejects a skin that is not one, rather than storing it', () => {
    // A typo, a removed skin, and a value of the wrong type entirely.
    for (const bad of ['Metro', 'metro-ui', 'neumorph', 42, null, {}]) {
      expect(migrate({ skin: bad }).skin).toBe('classic')
    }
  })

  it('keeps a valid skin', () => {
    for (const skin of SKINS) {
      expect(migrate({ skin }).skin).toBe(skin satisfies Skin)
    }
  })
})

describe('ui store — fonts', () => {
  it('defaults to the two families the app has always used', () => {
    expect(useUiStore.getState().uiFont).toBe('archivo')
    expect(useUiStore.getState().monoFont).toBe('jetbrains')
  })

  it('keeps every id the tables offer, so a new family is covered for free', () => {
    for (const f of UI_FONTS) expect(migrate({ uiFont: f.id }).uiFont).toBe(f.id)
    for (const f of MONO_FONTS) expect(migrate({ monoFont: f.id }).monoFont).toBe(f.id)
  })

  it('falls back rather than storing an id with no stack behind it', () => {
    // A label instead of an id, a family this build does not bundle, and values of
    // the wrong type. Any of these stored verbatim writes a --font-sans that
    // resolves to nothing, i.e. Times.
    for (const bad of ['Inter', 'comic-sans', 42, null, {}]) {
      expect(migrate({ uiFont: bad }).uiFont).toBe('archivo')
      expect(migrate({ monoFont: bad }).monoFont).toBe('jetbrains')
    }
  })

  it('carries a whole older payload across the version bumps', () => {
    // Every key still worth keeping. `migrateUiState` drops what it does not
    // return, so a missing branch reads to the user as "the app forgot my
    // settings" — `detailTab` is the one deliberate omission, since every repo
    // now opens on Changes.
    const v9 = {
      theme: 'dark',
      skin: 'adwaita',
      view: 'cards',
      expandedCategory: 'fe',
      allRepos: true,
      termFontSize: 15,
      detailHeaderCollapsed: true,
    }
    const out = migrate(v9)
    expect(out).toMatchObject(v9)
    // And the new keys arrive at their defaults rather than undefined.
    expect(out.uiFont).toBe('archivo')
    expect(out.monoFont).toBe('jetbrains')
    expect(out.expandedCategoryRoot).toBeNull()
  })
})

describe('ui store — a remembered folder belongs to a workspace', () => {
  it('opens every repo on the first tab', () => {
    // Landing on Packages because that is where you were last is a network call
    // for a question you did not ask, about a repo you have not looked at yet.
    useUiStore.getState().setDetailTab('prs')
    useUiStore.getState().openDetail('fe/web')
    expect(useUiStore.getState().detailTab).toBe('changes')
  })

  it('stamps a folder selection with the open workspace', () => {
    useUiStore.getState().setWorkspaceRoot('/home/me/work')
    useUiStore.getState().setCategory('fe')
    expect(useUiStore.getState().expandedCategoryRoot).toBe('/home/me/work')

    useUiStore.getState().setAllRepos(true)
    expect(useUiStore.getState().expandedCategoryRoot).toBeNull()
  })

  it('keeps a selection only when the workspace and the folder both still match', () => {
    const cats = ['fe', 'be']
    expect(keepRememberedCategory('fe', '/a', '/a', cats)).toBe(true)
    // Same folder name, different workspace — the case a bare name cannot catch.
    expect(keepRememberedCategory('fe', '/a', '/b', cats)).toBe(false)
    // Right workspace, folder gone.
    expect(keepRememberedCategory('fe', '/a', '/a', ['be'])).toBe(false)
    // No stamp: from before the key existed, so the folder check alone decides.
    expect(keepRememberedCategory('fe', null, '/a', cats)).toBe(true)
    expect(keepRememberedCategory('fe', null, '/a', ['be'])).toBe(false)
    // Nothing selected is nothing to clear.
    expect(keepRememberedCategory(null, null, '/a', [])).toBe(true)
  })
})

/**
 * Switching folders has to reset what belonged to the old one.
 *
 * `RepoGrid` short-circuits the whole centre panel to the detail page whenever
 * `detailRepoId` is set, so a category action that leaves it alone produces a
 * sidebar click that visibly does nothing. Both actions are covered because the
 * two had already drifted apart once.
 */
describe('ui store — switching folders', () => {
  it('opening a repo points the output pane at it', () => {
    // `openDetail` set activeRepoId alone while claiming the pane followed. Scope is
    // a separate field, so the pane stayed on whatever repo it was already showing.
    const ui = useUiStore.getState()
    ui.setCategory('frontend')
    ui.setActiveRepo('frontend/web')
    ui.openDetail('frontend/api')
    expect(useUiStore.getState().outputScope).toBe('frontend/api')
  })

  it('leaving a folder unscopes the pane along with the selection', () => {
    const ui = useUiStore.getState()
    ui.setCategory('frontend')
    ui.setActiveRepo('frontend/web')
    expect(useUiStore.getState().outputScope).toBe('frontend/web')

    useUiStore.getState().setCategory('mobile')
    // Otherwise the pane is scoped to a repo the table no longer lists.
    expect(useUiStore.getState().outputScope).toBeNull()
  })

  it('setCategory closes an open repo detail page', () => {
    const ui = useUiStore.getState()
    ui.setCategory('frontend')
    ui.openDetail('frontend/web')
    expect(useUiStore.getState().detailRepoId).toBe('frontend/web')

    useUiStore.getState().setCategory('mobile')
    const after = useUiStore.getState()
    expect(after.expandedCategory).toBe('mobile')
    expect(after.detailRepoId).toBeNull()
    expect(after.activeRepoId).toBeNull()
  })

  it('toggleCategory closes it too', () => {
    const ui = useUiStore.getState()
    ui.setCategory('frontend')
    ui.openDetail('frontend/web')

    useUiStore.getState().toggleCategory('mobile')
    expect(useUiStore.getState().detailRepoId).toBeNull()
  })

  it('drops a filter chip that belonged to the folder being left', () => {
    // The chips count repos in the open folder, so one carried across reads as a
    // filter matching nothing.
    const ui = useUiStore.getState()
    ui.setCategory('frontend')
    ui.toggleFilterChip('uncommitted')
    expect(useUiStore.getState().filterChip).toBe('uncommitted')

    useUiStore.getState().setCategory('mobile')
    expect(useUiStore.getState().filterChip).toBeNull()
  })

  it('collapsing the open folder also closes the detail page', () => {
    // toggleCategory on the *current* folder means "close it" — leaving a detail
    // page up over no folder at all.
    const ui = useUiStore.getState()
    ui.setCategory('frontend')
    ui.openDetail('frontend/web')

    useUiStore.getState().toggleCategory('frontend')
    const after = useUiStore.getState()
    expect(after.expandedCategory).toBeNull()
    expect(after.detailRepoId).toBeNull()
  })
})

/**
 * All-repos mode and a selected folder are alternative answers to "which repos am I
 * looking at", so they must never both be set — `RepoGrid` gives all-repos
 * precedence, and a folder click that left the flat list up would read as doing
 * nothing, which is exactly the bug the FOLDER_SCOPED note describes.
 */
describe('ui store — all-repos mode', () => {
  it('is off by default, so no upgrade scans the whole workspace unasked', () => {
    expect(useUiStore.getState().allRepos).toBe(false)
    expect(migrate({}).allRepos).toBe(false)
    // Only an exact `true` opts in.
    for (const bad of ['true', 1, {}, null]) {
      expect(migrate({ allRepos: bad }).allRepos).toBe(false)
    }
    expect(migrate({ allRepos: true }).allRepos).toBe(true)
  })

  it('turning it on clears the selected folder', () => {
    const ui = useUiStore.getState()
    ui.setCategory('frontend')
    ui.setAllRepos(true)
    const after = useUiStore.getState()
    expect(after.allRepos).toBe(true)
    expect(after.expandedCategory).toBeNull()
  })

  it('picking a folder turns it off', () => {
    const ui = useUiStore.getState()
    ui.setAllRepos(true)
    ui.setCategory('mobile')
    const after = useUiStore.getState()
    expect(after.allRepos).toBe(false)
    expect(after.expandedCategory).toBe('mobile')

    // toggleCategory is the other way in, and had already drifted from setCategory
    // once before.
    useUiStore.getState().setAllRepos(true)
    useUiStore.getState().toggleCategory('frontend')
    expect(useUiStore.getState().allRepos).toBe(false)
  })

  it('switching in or out closes the detail page and unscopes the pane', () => {
    const ui = useUiStore.getState()
    ui.setCategory('frontend')
    ui.openDetail('frontend/web')

    useUiStore.getState().setAllRepos(true)
    const after = useUiStore.getState()
    expect(after.detailRepoId).toBeNull()
    expect(after.outputScope).toBeNull()
  })
})
