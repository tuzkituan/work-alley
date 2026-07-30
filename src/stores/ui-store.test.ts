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

  it('toggles and sets', () => {
    useUiStore.getState().toggleSkin()
    expect(useUiStore.getState().skin).toBe('metro')
    useUiStore.getState().toggleSkin()
    expect(useUiStore.getState().skin).toBe('classic')

    useUiStore.getState().setSkin('metro')
    expect(useUiStore.getState().skin).toBe('metro')
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
