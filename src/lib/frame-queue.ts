/**
 * Coalesces a burst of events into one commit per animation frame.
 *
 * `scan:repo` fires once per repo in a burst and `run:output` delivers arrays
 * hundreds of times during an install. Committing each one separately means a
 * store write and a render per event; this collapses that to ~1 per frame.
 */
export function createFrameQueue<T>(flush: (items: T[]) => void) {
  let pending: T[] = []
  let raf: number | null = null

  const commit = () => {
    raf = null
    if (pending.length === 0) return
    const items = pending
    pending = []
    flush(items)
  }

  return {
    push(item: T) {
      pending.push(item)
      if (raf === null) raf = requestAnimationFrame(commit)
    },
    pushAll(items: T[]) {
      if (items.length === 0) return
      pending.push(...items)
      if (raf === null) raf = requestAnimationFrame(commit)
    },
    /** Commits immediately — used when a stream ends so nothing is left waiting. */
    flushNow() {
      if (raf !== null) cancelAnimationFrame(raf)
      commit()
    },
  }
}
