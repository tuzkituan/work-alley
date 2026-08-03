import { describe, expect, it } from 'bun:test'
import { COLUMNS, DEFAULT_COLUMNS, fit, requiredWidth, template, type ColumnId } from './columns'

const ALL = Object.fromEntries(COLUMNS.map((c) => [c.id, true])) as Record<ColumnId, boolean>

describe('fit', () => {
  it('keeps every chosen column when there is room', () => {
    expect(fit(ALL, 2000)).toEqual(COLUMNS.map((c) => c.id))
  })

  it('never re-adds a column the user turned off', () => {
    // The whole point of the chooser. A table that puts a column back because the
    // window grew is one nobody can rely on.
    const off = { ...ALL, sync: false }
    expect(fit(off, 4000)).not.toContain('sync')
  })

  it('drops the least useful first, and only as far as it must', () => {
    const width = requiredWidth(['branch', 'changes', 'sync', 'dev'])
    const on = fit(DEFAULT_COLUMNS, width)
    // `fetched` goes before anything that describes the repo itself.
    expect(on).toEqual(['branch', 'changes', 'sync', 'dev'])
  })

  it('keeps a column the user turned on against the default, and drops another', () => {
    // The reported bug: ticking `tracked` on a table too narrow for six columns did
    // nothing, because it was also the first thing given up for width.
    const chosen = { ...DEFAULT_COLUMNS, tracked: true }
    const width = requiredWidth(['branch', 'changes', 'sync', 'tracked', 'dev'])
    const on = fit(chosen, width)
    expect(on).toContain('tracked')
    expect(on).not.toContain('fetched')
  })

  it('still gives up an opted-in column before the row stops making sense', () => {
    const chosen = { ...DEFAULT_COLUMNS, tracked: true }
    // Room for one column. `tracked` is promoted over `sync`, `dev` and `fetched`,
    // never over the two the list is read for.
    expect(fit(chosen, requiredWidth(['branch']))).toEqual(['branch'])
    expect(fit(chosen, requiredWidth(['changes', 'branch']))).toEqual(['branch', 'changes'])
  })

  it('keeps the name and actions at any width', () => {
    // Both are outside the column set on purpose: a row with no name says nothing,
    // and a row with no actions is a report rather than a control.
    const on = fit(ALL, 200)
    expect(on).toEqual([])
    expect(template(on)).toBe('18px minmax(200px, 2.6fr) 124px')
  })

  it('assumes the widest layout before the table has been measured', () => {
    // One frame too wide is invisible; one frame of a stripped table is a flinch.
    expect(fit(ALL, 0)).toEqual(COLUMNS.map((c) => c.id))
  })
})

describe('requiredWidth', () => {
  it('is what the template actually needs, padding and gaps included', () => {
    // 18 + 200 + 124, three tracks so two 8px gaps, plus the row's 24px of padding.
    expect(requiredWidth([])).toBe(18 + 200 + 124 + 16 + 24)
  })

  it('grows by a column plus its gap', () => {
    const sync = COLUMNS.find((c) => c.id === 'sync')!
    expect(requiredWidth(['sync']) - requiredWidth([])).toBe(sync.min + 8)
  })

  it('never exceeds the width fit was given', () => {
    // The bug this file replaces: the CSS declared a template needing 926px and
    // applied it from 901px up, so the actions column fell off the clipped edge.
    for (let w = 300; w <= 1600; w += 37) {
      expect(requiredWidth(fit(ALL, w))).toBeLessThanOrEqual(Math.max(w, requiredWidth([])))
    }
  })
})

describe('template', () => {
  it('lists the tracks in column order', () => {
    expect(template(['changes', 'dev'])).toBe(
      '18px minmax(200px, 2.6fr) 96px 96px 124px'
    )
  })

  it('lets the branch flex, since branch names have no useful maximum', () => {
    expect(template(['branch'])).toContain('minmax(80px, 1fr)')
  })
})

describe('defaults', () => {
  it('has the tracked-package column off', () => {
    // Most workspaces have no shared package, and the column is then 84px of
    // dashes with a header nobody can explain.
    expect(DEFAULT_COLUMNS.tracked).toBe(false)
  })

  it('covers every column', () => {
    for (const c of COLUMNS) expect(DEFAULT_COLUMNS[c.id]).toBeDefined()
  })
})
