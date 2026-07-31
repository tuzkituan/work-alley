import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Bootstrap, Config, ConfigPatch } from '@/domain/types'
import { api } from '@/ipc/commands'
import { IpcError } from '@/ipc/errors'
import { keys } from '@/queries/keys'

/**
 * The persisted backend settings.
 *
 * `staleTime: Infinity` because nothing mutates this behind the UI's back — the
 * only writer is `set_config`, and it returns the new value. The exception is
 * `workspaceRoot`, which `switch_workspace` moves; `bridge.ts` invalidates every
 * query on `workspace:changed`, which covers it.
 */
export function useConfig() {
  return useQuery({
    queryKey: keys.config,
    queryFn: () => api.getConfig(),
    staleTime: Infinity,
  })
}

/**
 * Saves one or more settings.
 *
 * No optimistic update, on purpose: Rust clamps every number, so the field
 * visibly snapping from 99999 to 1440 *is* the feedback, and an optimistic write
 * would show the value it refused. Nor is there a success toast — the control
 * settling on the stored value already says it worked.
 */
export function useSetConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: ConfigPatch) => api.setConfig(patch),
    onSuccess: (cfg: Config) => {
      qc.setQueryData(keys.config, cfg)
      // Bootstrap carries its own copy. Patched in place rather than invalidated:
      // invalidating means re-walking every folder in the workspace to change one
      // number.
      qc.setQueryData<Bootstrap>(keys.bootstrap, (b) => (b ? { ...b, config: cfg } : b))
    },
    onError: (e: unknown) => {
      const msg = e instanceof IpcError || e instanceof Error ? e.message : String(e)
      toast.error('Could not save that setting', { description: msg })
    },
  })
}
