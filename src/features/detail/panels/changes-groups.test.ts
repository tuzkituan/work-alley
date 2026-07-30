import { describe, expect, it } from 'bun:test'
import { groupChanges } from './changes-groups'
import type { ChangedFile } from '@/domain/types'

function file(path: string, code: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    code,
    // Deliberately set to what the backend would say, so the tests prove the
    // splitter reads the code rather than trusting this flag.
    staged: code[0] !== '.',
    untracked: false,
    conflicted: false,
    added: 0,
    deleted: 0,
    ...extra,
  }
}

/** The groups a path landed in, by group id. */
function groupsOf(files: ChangedFile[], path: string): string[] {
  return groupChanges(files)
    .filter((g) => g.files.some((f) => f.path === path))
    .map((g) => g.id)
}

describe('groupChanges', () => {
  it('puts a staged-and-then-modified file in BOTH staged and unstaged', () => {
    // The bug this module exists for: MM means "edited, staged, edited again". The
    // backend's single `staged` boolean calls it staged and hides the rest.
    const files = [file('a.ts', 'MM')]
    expect(groupsOf(files, 'a.ts')).toEqual(['staged', 'unstaged'])
  })

  it('separates index-only from worktree-only changes', () => {
    const files = [file('staged.ts', 'M.'), file('dirty.ts', '.M')]
    expect(groupsOf(files, 'staged.ts')).toEqual(['staged'])
    expect(groupsOf(files, 'dirty.ts')).toEqual(['unstaged'])
  })

  it('treats a conflict as a conflict and nothing else', () => {
    const files = [file('c.ts', 'UU', { conflicted: true, staged: true })]
    expect(groupsOf(files, 'c.ts')).toEqual(['conflicts'])
  })

  it('treats an untracked file as untracked and nothing else', () => {
    const files = [file('new.ts', '??', { untracked: true, staged: false })]
    expect(groupsOf(files, 'new.ts')).toEqual(['untracked'])
  })

  it('orders groups with conflicts first and drops empty ones', () => {
    const groups = groupChanges([
      file('new.ts', '??', { untracked: true }),
      file('c.ts', 'UU', { conflicted: true }),
      file('s.ts', 'M.'),
    ])
    expect(groups.map((g) => g.id)).toEqual(['conflicts', 'staged', 'untracked'])
  })

  it('accepts a space as an unchanged half, as older porcelain writes it', () => {
    // porcelain=v2 uses '.', but ' ' is what v1 emitted and is worth tolerating.
    expect(groupsOf([file('a.ts', ' M')], 'a.ts')).toEqual(['unstaged'])
    expect(groupsOf([file('b.ts', 'M ')], 'b.ts')).toEqual(['staged'])
  })

  it('never loses a file, whatever the code says', () => {
    const files = [file('weird.ts', '..')]
    expect(groupsOf(files, 'weird.ts').length).toBeGreaterThan(0)
  })

  it('returns nothing for a clean tree', () => {
    expect(groupChanges([])).toEqual([])
  })
})
