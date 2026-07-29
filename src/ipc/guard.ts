/**
 * There is deliberately no mock layer. The data is real by requirement, and a
 * mock would quietly become the thing people develop against.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
