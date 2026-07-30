import { useCallback } from 'react'
import { api } from '@/ipc/commands'
import { useScanStore } from '@/stores/scan-store'
import { useRescanCategory } from './use-category-scan'
import type { RepoRef } from '@/domain/types'

/**
 * Re-reads one repo, falling back to its whole folder.
 *
 * One repo rather than the folder because that is all that changed: a 40-repo scan
 * to learn one repo's new branch is seconds of git for an answer we can get in
 * milliseconds.
 *
 * The fallback matters: `rescan_repo` resolves the repo path, so it fails outright
 * for a repo that has moved or been deleted. Re-scanning the folder is what
 * discovers that, and it is also the only path that removes a stale row.
 */
export function useRescanRepo() {
  const upsert = useScanStore((s) => s.upsertMany)
  const rescanCategory = useRescanCategory()

  return useCallback(
    (repo: RepoRef) =>
      api
        .rescanRepo(repo)
        .then((s) => upsert([s]))
        .catch(() => rescanCategory(repo.category)),
    [upsert, rescanCategory]
  )
}
