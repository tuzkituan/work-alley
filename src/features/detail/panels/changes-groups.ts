import type { ChangedFile } from '@/domain/types'

export type ChangeGroup = {
  id: 'conflicts' | 'staged' | 'unstaged' | 'untracked'
  label: string
  files: ChangedFile[]
}

/**
 * Splits changed files into what is staged and what is not — independently.
 *
 * The porcelain-v2 code is two characters: the *index* status then the *worktree*
 * status, with `.` meaning "unchanged in this half". So `MM` is a file that was
 * edited, staged, and then edited again. The backend collapses that to one boolean
 * (`staged = code[0] !== '.'`), which reports such a file as staged and hides the
 * fact that it also has unstaged work — a genuinely misleading answer to "what will
 * my next commit contain?".
 *
 * Reading each half separately fixes it, and means a file can legitimately appear in
 * two groups. Conflicts and untracked files are exclusive: git reports them with
 * their own record types, not as index/worktree pairs.
 *
 * Pure, and its own module, so all of the above is actually testable.
 */
export function groupChanges(files: ChangedFile[]): ChangeGroup[] {
  const conflicts: ChangedFile[] = []
  const staged: ChangedFile[] = []
  const unstaged: ChangedFile[] = []
  const untracked: ChangedFile[] = []

  for (const f of files) {
    if (f.conflicted) {
      conflicts.push(f)
      continue
    }
    if (f.untracked) {
      untracked.push(f)
      continue
    }
    const index = f.code[0] ?? '.'
    const worktree = f.code[1] ?? '.'
    if (index !== '.' && index !== ' ') staged.push(f)
    if (worktree !== '.' && worktree !== ' ') unstaged.push(f)
    // Neither half set is not a state git reports, but if it ever happens the file
    // must not vanish silently.
    if ((index === '.' || index === ' ') && (worktree === '.' || worktree === ' ')) {
      unstaged.push(f)
    }
  }

  // Conflicts first: they block everything else.
  return [
    { id: 'conflicts', label: 'Conflicts', files: conflicts },
    { id: 'staged', label: 'Staged', files: staged },
    { id: 'unstaged', label: 'Not staged', files: unstaged },
    { id: 'untracked', label: 'Untracked', files: untracked },
  ].filter((g) => g.files.length > 0) as ChangeGroup[]
}
