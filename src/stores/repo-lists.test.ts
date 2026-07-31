import { beforeEach, describe, expect, it } from 'bun:test'
import { useRepoLists } from './repo-lists'
import { repoId, type RepoRef } from '@/domain/types'

const ROOT = '/home/me/work'
const OTHER = '/home/me/other'
const ref = (name: string, category = 'fe'): RepoRef => ({ category, name })

const s = () => useRepoLists.getState()

describe('pinned and recent repos', () => {
  beforeEach(() => useRepoLists.setState({ byRoot: {} }))

  it('pins and unpins, keeping the order you built', () => {
    s().togglePin(ROOT, ref('web'))
    s().togglePin(ROOT, ref('api', 'be'))
    expect(s().pinned(ROOT).map((r) => r.name)).toEqual(['web', 'api'])

    s().togglePin(ROOT, ref('web'))
    expect(s().pinned(ROOT).map((r) => r.name)).toEqual(['api'])
    expect(s().isPinned(ROOT, repoId(ref('api', 'be')))).toBe(true)
  })

  it('orders recents newest first and never repeats one', () => {
    s().touch(ROOT, ref('a'))
    s().touch(ROOT, ref('b'))
    s().touch(ROOT, ref('a'))
    expect(s().recent(ROOT).map((r) => r.name)).toEqual(['a', 'b'])
  })

  it('caps recents rather than growing a second folder list', () => {
    for (const n of ['1', '2', '3', '4', '5', '6', '7']) s().touch(ROOT, ref(n))
    expect(s().recent(ROOT)).toHaveLength(6)
    expect(s().recent(ROOT)[0]!.name).toBe('7')
  })

  it('leaves a pinned repo out of recents', () => {
    // It would otherwise appear twice, and the second copy says nothing the first
    // did not.
    s().touch(ROOT, ref('web'))
    s().togglePin(ROOT, ref('web'))
    expect(s().recent(ROOT)).toEqual([])
  })

  it('keeps each workspace to its own lists', () => {
    // Two workspaces routinely hold repos with the same name.
    s().togglePin(ROOT, ref('web'))
    expect(s().pinned(OTHER)).toEqual([])
  })

  it('drops repos the workspace no longer has', () => {
    s().togglePin(ROOT, ref('web'))
    s().touch(ROOT, ref('gone'))
    s().prune(ROOT, new Set([repoId(ref('web'))]))

    expect(s().pinned(ROOT).map((r) => r.name)).toEqual(['web'])
    expect(s().recent(ROOT)).toEqual([])
  })
})
