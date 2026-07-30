import { api } from '@/ipc/commands'
import { useRunStore } from '@/stores/run-store'

/**
 * Asks the backend to cancel a run, and marks it cancelling until it exits.
 *
 * The single path for cancelling, so the Cancel button and Ctrl+C cannot drift into
 * different behaviour — the button used to fire the IPC and show nothing, which read
 * as a no-op for as long as the process tree took to die.
 *
 * Not a store action: the store does no IPC anywhere else, and keeping that rule means
 * it stays testable without a Tauri host.
 */
export function requestCancel(runId: string): void {
  const { setCancelling } = useRunStore.getState()
  setCancelling(runId, true)
  // On failure there is no `run:exit` coming to clear the flag, so undo it here or
  // the run is stuck reading "cancelling…" forever.
  void api.cancelRun(runId).catch(() => setCancelling(runId, false))
}
