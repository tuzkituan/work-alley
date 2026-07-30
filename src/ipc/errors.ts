/** Codes mirror AppError::code() in src-tauri/src/error.rs. */
export type IpcErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'PATH_ESCAPE'
  | 'UNKNOWN_REPO'
  | 'UNKNOWN_SCRIPT'
  | 'TOOL_MISSING'
  | 'INTENT_UNKNOWN'
  | 'INTENT_EXPIRED'
  | 'TYPED_CONFIRM_MISMATCH'
  | 'DEV_ALREADY_RUNNING'
  | 'DEV_NOT_RUNNING'
  | 'RUN_UNKNOWN'
  | 'SCRIPT_INTERACTIVE'
  | 'NO_TERMINAL'
  | 'SPAWN_FAILED'
  | 'TIMEOUT'
  | 'INVALID'
  | 'IO'
  | 'JSON'
  | 'NOT_READY'
  | 'UNKNOWN'

export class IpcError extends Error {
  code: IpcErrorCode
  /**
   * The specific subject of the code — for `TOOL_MISSING`, which tool.
   *
   * Carried separately so a handler can act on it. Parsing it out of `message` would
   * be reading prose, which the code exists to avoid.
   */
  detail: string | null
  constructor(code: IpcErrorCode, message: string, detail: string | null = null) {
    super(message)
    this.name = 'IpcError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Rust rejects with `{ code, message, detail }`. Anything else — a panic, a missing
 * command, state not yet managed — arrives as a bare string.
 */
export function normalizeError(e: unknown): IpcError {
  if (e instanceof IpcError) return e

  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const { code, message, detail } = e as {
      code: string
      message: string
      detail?: string | null
    }
    return new IpcError(code as IpcErrorCode, message, detail ?? null)
  }

  const text = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)

  // State is managed only after the async toolchain probe resolves, so an early
  // call can land before it exists. That is a "retry shortly", not a failure.
  if (text.includes('not managed') || text.includes('state()')) {
    return new IpcError('NOT_READY', 'The backend is still starting up.')
  }

  return new IpcError('UNKNOWN', text)
}
