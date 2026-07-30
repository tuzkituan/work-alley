import { describe, expect, it } from 'bun:test'
import { migrateUiState, SKINS, useUiStore, type Skin } from './ui-store'

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
    expect(out.detailTab).toBe('commits')
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
