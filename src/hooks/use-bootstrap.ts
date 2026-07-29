import { useQuery } from '@tanstack/react-query'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import type { Bootstrap } from '@/domain/types'

/**
 * Reads one field out of the bootstrap payload.
 *
 * `select` matters: without it every consumer re-renders whenever anything in the
 * payload changes, and some of these are rendered per repo row.
 */
function useBootstrapField<T>(select: (b: Bootstrap) => T): T | undefined {
  const { data } = useQuery({ queryKey: keys.bootstrap, queryFn: () => api.getBootstrap(), select })
  return data
}

/**
 * The scripts that can run without a terminal, for the quick-action row.
 *
 * Discovered from the workspace's own `scripts/` directory — there is no
 * built-in script this app can assume exists.
 */
export function useHeadlessScripts(limit = 2): Bootstrap['scripts'] {
  return (
    useBootstrapField((b) => b.scripts.filter((s) => s.mode === 'headless').slice(0, limit)) ?? []
  )
}

/**
 * The container runtime this machine actually has, so the button says `podman ps`
 * on a machine with podman rather than advertising a tool that is not installed.
 */
export function useContainerRuntime(): string | null {
  return (
    useBootstrapField((b) => {
      const found = b.tools.find((t) => (t.name === 'docker' || t.name === 'podman') && t.path)
      return found?.name ?? null
    }) ?? null
  )
}

/** The application's own name and version, from the Tauri build — never a literal. */
export function useAppIdentity(): { name: string; version: string } {
  return { name: __APP_NAME__, version: __APP_VERSION__ }
}
