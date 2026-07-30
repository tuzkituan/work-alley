/**
 * Base64 -> bytes, for terminal output.
 *
 * Runs on every `term:output` event, so it is deliberately a tight loop rather
 * than anything clever. The bytes go straight into xterm's `write(Uint8Array)`,
 * which does its own incremental UTF-8 decoding across chunk boundaries — which
 * is the whole reason Rust sends bytes rather than a String. See pty::flush.
 */
export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
