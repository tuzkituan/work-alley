import { useQuery } from '@tanstack/react-query'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'

/**
 * The workspace's shared package, detected by the backend from what the repos
 * actually depend on — `null` in a workspace that has no shared package.
 *
 * `select` keeps this from re-rendering every repo row whenever anything else in
 * the bootstrap payload changes.
 */
export function useTrackedPackage(): string | null {
  const { data } = useQuery({
    queryKey: keys.bootstrap,
    queryFn: () => api.getBootstrap(),
    select: (b) => b.trackedPackage,
  })
  return data ?? null
}

/**
 * Column-header form of a package name: `@acme/design-system` -> `design-system`.
 * The scope is redundant once every row shows the same package.
 */
export function shortPackageName(name: string): string {
  const slash = name.lastIndexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}
