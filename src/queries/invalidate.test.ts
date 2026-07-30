import { describe, expect, it } from 'bun:test'
import { staleKeysFor } from './invalidate'

/** The head of each returned prefix, which is what react-query matches on. */
function heads(kind: string): string[] {
  return staleKeysFor(kind, 'fe/web').map((k) => String(k[0]))
}

describe('staleKeysFor', () => {
  it('invalidates nothing but the run list after a read-only inspection', () => {
    // The whole point of the table: `status` and `diff` cannot have changed
    // anything, so refetching would be pure waste.
    expect(heads('status')).toEqual(['runs'])
    expect(heads('diff')).toEqual(['runs'])
    expect(heads('logGraph')).toEqual(['runs'])
    expect(heads('openShell')).toEqual(['runs'])
  })

  it('invalidates every per-repo view after a pull', () => {
    expect(heads('pull').sort()).toEqual(
      ['branches', 'changedFiles', 'prs', 'repoCommits', 'runs'].sort()
    )
  })

  it('does not refetch pull requests after a fetch', () => {
    // `keys.prs` is a gh network call with a 20s ceiling, and a fetch moves remote
    // refs without touching the PR list or the working tree.
    const h = heads('fetchAll')
    expect(h).not.toContain('prs')
    expect(h).not.toContain('changedFiles')
    expect(h).toContain('branches')
    expect(h).toContain('repoCommits')
  })

  it('invalidates only the file list after stashing or running a script', () => {
    for (const kind of ['stash', 'stashPop', 'discardChanges', 'runScript']) {
      expect(heads(kind).sort()).toEqual(['changedFiles', 'runs'])
    }
  })

  it('scopes keys to the repo it was given', () => {
    expect(staleKeysFor('pull', 'fe/web')).toEqual(
      expect.arrayContaining([['changedFiles', 'fe/web']])
    )
  })

  it('treats an unknown kind as harmless rather than throwing', () => {
    expect(heads('somethingNew')).toEqual(['runs'])
  })
})
