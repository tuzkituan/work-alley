import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, Check, CircleSlash, Loader2, X } from 'lucide-react'
import { openUrl } from '@/lib/open-url'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/time'
import { api } from '@/ipc/commands'
import { shouldReplay, useRunStore, type Run } from '@/stores/run-store'
import { runStatusLabel, runTone } from '@/domain/run-status'
import { TONE_TEXT } from '@/domain/severity'
import type { LogLine } from '@/domain/types'
import { SEVERITY_CLASS } from './severity-class'
import { linkify } from './linkify'

/** One 200KB stack-trace line would otherwise measure into a giant row. */
const MAX_LINE_CHARS = 2_000

export function EmptyLog({ scope }: { scope: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 p-2.5 font-mono text-[11.5px] leading-[1.65]">
      <div className="text-adaptive-500">Nothing has run for {scope} yet.</div>
      <Prompt />
    </div>
  )
}

export function LogView({
  run,
  repoFilter,
  onClearFilter,
}: {
  run: Run
  /** Show only lines attributed to this repo key. Set by the bulk progress rows. */
  repoFilter?: string | null
  onClearFilter?: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const setFollow = useRunStore((s) => s.setFollow)
  const append = useRunStore((s) => s.append)

  // Filtering is a plain filter rather than a second store: the lines are already in
  // memory, and per-line attribution now arrives from Rust on every bulk run.
  const lines = repoFilter ? run.lines.filter((l) => l.repo === repoFilter) : run.lines

  // Rows are *measured* here, because a long line wraps to two or three, and the
  // measurement cache is keyed by whatever this returns. With the default — the
  // index — switching to another run left row 12's 57px cached against row 12 of
  // the new log, so a one-line row was given three lines of space and its
  // neighbours were drawn on top of each other.
  //
  // `droppedHead + i` rather than `i`: past 20k lines the head is trimmed and
  // every index shifts, which is the same bug arriving a different way.
  //
  // `logId`, not `runId`: this key must change exactly when the line at an index
  // changes, and no more often. A run that continues a finished one keeps its lines
  // and takes the new process's id, and keying on that id threw away the heights of
  // rows that were still on screen — react-virtual only measures on mount or on a
  // resize, so nothing put them back and every wrapped line collapsed to the 19px
  // estimate under its neighbour. That is the overlap after "fetch all, then check
  // out a branch".
  const getItemKey = useCallback(
    (i: number) => `${run.logId}:${repoFilter ?? ''}:${run.droppedHead + i}`,
    [run.logId, run.droppedHead, repoFilter]
  )

  const virtualizer = useVirtualizer({
    count: lines.length,
    getItemKey,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 19,
    overscan: 20,
    measureElement: (el) => el.getBoundingClientRect().height,
  })

  // Replay after a remount: fill any gap from the ring buffer, deduped by seq.
  // `shouldReplay`, not `lines.length === 0`, so an explicit Clear stays cleared —
  // this effect used to undo it on the next remount.
  useEffect(() => {
    if (!shouldReplay(run)) return
    let cancelled = false
    api
      .getRunLog(run.runId, 0)
      .then((page) => {
        if (!cancelled && page.lines.length) append(run.runId, page.lines)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [run, append])

  // Tail only while following.
  useLayoutEffect(() => {
    if (!run.follow || lines.length === 0) return
    virtualizer.scrollToIndex(lines.length - 1, { align: 'end' })
  }, [lines.length, run.follow, virtualizer])

  // `scrollToIndex` stops at the last *row*, so the footer below the virtual list
  // stays just off-screen — the one line you were waiting for. Scroll past it.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !run.follow) return
    el.scrollTop = el.scrollHeight
  }, [run.summary.status.kind, run.cancelling, run.follow])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {repoFilter && (
        <div className="flex flex-none items-center gap-2 border-b border-adaptive-200 bg-adaptive-100/60 px-2.5 py-1 font-mono text-[10.5px]">
          <span className="truncate text-adaptive-600">showing {repoFilter}</span>
          <span className="wa-num text-adaptive-400">{lines.length} lines</span>
          <button
            type="button"
            onClick={onClearFilter}
            className="ml-auto flex items-center gap-0.5 text-adaptive-400 hover:text-adaptive-900"
          >
            <X className="size-2.5" />
            all repos
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          // Auto-disengage tail the moment the user scrolls away, or reading a
          // failure becomes impossible.
          if (atBottom !== run.follow) setFollow(run.runId, atBottom)
        }}
        className="wa-scroll min-h-0 flex-1 overflow-y-auto p-2.5 font-mono text-[11.5px] leading-[1.65]"
      >
        {run.droppedHead > 0 && !repoFilter && (
          <div className="pb-1 text-adaptive-400 italic">
            … {run.droppedHead.toLocaleString()} earlier lines dropped
          </div>
        )}

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const line = lines[vi.index]!
            return (
              <div
                // The virtualizer's own key, so React's identity for a row and the
                // measurement cache's identity for it are the same thing. `line.seq`
                // is not unique: each process numbers its lines from zero, and a
                // continued run holds the lines of both — duplicate keys, and React
                // reconciled two different lines onto one node.
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0"
                style={{ top: vi.start }}
              >
                {/* No repo prefix while filtered — every line is that repo's. */}
                <LogRow line={line} showRepo={!repoFilter} />
              </div>
            )
          })}
        </div>

        <RunFooter run={run} />
      </div>

      {!run.follow && (
        <Button
          variant="waOutline"
          size="waXs"
          className="absolute right-3 bottom-3 shadow-md"
          onClick={() => setFollow(run.runId, true)}
        >
          <ArrowDown className="size-3" />
          Jump to latest
        </Button>
      )}
    </div>
  )
}

/**
 * How the log ends: the blinking prompt while it runs, and a terminating line once it
 * is over.
 *
 * The log had no end marker at all. A command that printed nothing looked identical
 * whether it was still working or had finished a minute ago, and the only report of
 * how it went was a toast that had already gone away and a chip in the strip above.
 * A shell prints a prompt again when it is done; this is the same signal.
 */
function RunFooter({ run }: { run: Run }) {
  const status = run.summary.status

  if (status.kind === 'running') {
    if (!run.cancelling) return <Prompt />
    // Still running, so still a live log — but say that a cancel is in flight, because
    // between the signal and the exit a big process tree keeps printing and it looks
    // like the cancel was ignored.
    return (
      <div className="flex items-center gap-1.5 pt-0.5 text-sev-warn">
        <Loader2 className="size-3 animate-spin" />
        cancelling…
      </div>
    )
  }

  const { startedUnix, endedUnix } = run.summary
  const elapsed = endedUnix === null ? null : formatDuration(Math.max(0, endedUnix - startedUnix))
  const ok = status.kind === 'exited' && status.code === 0

  return (
    <div className={cn('flex items-center gap-1.5 pt-1', TONE_TEXT[runTone(status)])}>
      {ok ? <Check className="size-3 shrink-0" /> : <CircleSlash className="size-3 shrink-0" />}
      {/* Upper case and spelled out, because this is the line the eye lands on when it
          scrolls to the bottom of 5000 lines to find out what happened. */}
      <span className="font-semibold tracking-wide uppercase">{runStatusLabel(status)}</span>
      {elapsed && <span className="wa-num text-adaptive-400">· {elapsed}</span>}
    </div>
  )
}

function LogRow({ line, showRepo }: { line: LogLine; showRepo: boolean }) {
  const truncated = line.text.length > MAX_LINE_CHARS
  const text = truncated ? `${line.text.slice(0, MAX_LINE_CHARS)}…` : line.text
  return (
    <div className={cn('break-words whitespace-pre-wrap', SEVERITY_CLASS[line.severity])}>
      {/* The repo this line came from. Real data now: the backend field it reads was
          previously always null, and this printed only the category when it was not. */}
      {showRepo && line.repo && line.severity !== 'cmd' && (
        <span className="mr-1.5 text-adaptive-400">{line.repo}</span>
      )}
      {/* Linkified, because the reason you start a dev server is the URL it prints —
          and selecting it out of a virtualized log to paste elsewhere was the only way
          to use it. Cheap despite running per row: only visible rows render. */}
      {linkify(text).map((seg, i) =>
        seg.href ? (
          <button
            key={i}
            type="button"
            // Not an <a>: this is a webview, and a real navigation would replace the
            // app. `openUrl` hands it to the desktop browser.
            onClick={() => openUrl(seg.href!)}
            title={`Open ${seg.href}`}
            className="cursor-pointer underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {seg.text}
          </button>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
      {truncated && <span className="text-adaptive-400"> [line truncated]</span>}
    </div>
  )
}

export function Prompt() {
  return (
    <div className="flex gap-1.5 text-adaptive-500">
      <span className="text-primary-600">›</span>
      <span
        className="inline-block h-[14px] w-[7px] bg-adaptive-600"
        style={{ animation: 'wa-blink 1.1s step-end infinite' }}
      />
    </div>
  )
}
