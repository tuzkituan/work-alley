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
      [
        'branches',
        'changedFiles',
        'prs',
        'repoCommits',
        'repoPackages',
        'repoPackageUpdates',
        'runs',
      ].sort()
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

  it('invalidates only the file list after stashing', () => {
    for (const kind of ['stash', 'stashPop', 'discardChanges']) {
      expect(heads(kind).sort()).toEqual(['changedFiles', 'runs'])
    }
  })

  it('refetches the dependency table after a script, which can move a lockfile', () => {
    // Not the outdated answer: a script rewriting a lockfile does not change what
    // the registry considers latest, and that key is a registry round trip.
    const h = heads('runScript')
    expect(h.sort()).toEqual(['changedFiles', 'repoPackages', 'runs'].sort())
    expect(h).not.toContain('repoPackageUpdates')
  })

  it('refetches both dependency keys after an upgrade, and no git views', () => {
    const h = heads('upgradeDep')
    expect(h.sort()).toEqual(
      ['changedFiles', 'repoPackages', 'repoPackageUpdates', 'runs'].sort()
    )
    // Nothing here runs git, so HEAD and the branch cannot have moved.
    expect(h).not.toContain('repoCommits')
    expect(h).not.toContain('branches')
  })

  it('refetches the log and the branch after a commit, but not the PRs', () => {
    // A commit empties the index, moves HEAD and changes the branch's ahead count —
    // so three of the four per-repo views moved. `prs` did not: GitHub cannot know
    // about a local commit, and that key is a network round trip.
    const h = heads('commit')
    expect(h.sort()).toEqual(['branches', 'changedFiles', 'repoCommits', 'runs'].sort())
    expect(h).not.toContain('prs')
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
