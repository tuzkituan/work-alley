/**
 * "22m" / "4h" / "9d", matching what Rust's `relative_time` produces.
 *
 * A second implementation only because some values arrive as a bare unix timestamp
 * with no pre-rendered string alongside them — branch dates, run durations. Anything
 * the backend already formats should keep using that field: it was computed against
 * the backend's clock, and recomputing here would disagree by the IPC round trip.
 */
export function relativeFromUnix(unix: number | null | undefined): string {
  if (!unix) return '—'
  const d = Math.max(0, Math.floor(Date.now() / 1000) - unix)
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86_400) return `${Math.floor(d / 3600)}h`
  if (d < 2_592_000) return `${Math.floor(d / 86_400)}d`
  if (d < 31_536_000) return `${Math.floor(d / 2_592_000)}mo`
  return `${Math.floor(d / 31_536_000)}y`
}

/** `1m 12s` / `340ms`, for a run's elapsed time. */
export function formatDuration(seconds: number): string {
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}
