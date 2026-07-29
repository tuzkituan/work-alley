import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel, StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import { api } from '@/ipc/commands'
import { runScope, useRunStore, type Run } from '@/stores/run-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'
import { displayName } from '@/domain/severity'
import type { LogLine, Severity } from '@/domain/types'
import type { Tone } from '@/domain/severity'

const SEVERITY_CLASS: Record<Severity, string> = {
  cmd: 'text-primary-600 font-semibold',
  ok: 'text-sev-ok',
  warn: 'text-sev-warn',
  err: 'text-sev-err',
  info: 'text-sev-info',
  out: 'text-adaptive-800',
}

/** One 200KB stack-trace line would otherwise measure into a giant row. */
const MAX_LINE_CHARS = 2_000

export function OutputPane() {
  const runs = useRunStore((s) => s.runs)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const setActive = useRunStore((s) => s.setActive)
  const clear = useRunStore((s) => s.clear)
  const run = useRunAction()

  // The pane is scoped: the selected repo's own terminal, or the workspace scope
  // for runs that belong to no single repo (scripts, bulk pull, gh pr list).
  const activeRepoId = useUiStore((s) => s.activeRepoId)
  const [scope, setScope] = useState<string | null>(activeRepoId)

  // Follow the selection, but let an explicit scope switch stick until the
  // selection actually changes again.
  useEffect(() => {
    setScope(activeRepoId)
  }, [activeRepoId])

  // Computed, not selected: a selector returning a fresh array on every call
  // breaks useSyncExternalStore's snapshot caching.
  const order = useRunStore((s) => s.order)
  const scopeIds = useMemo(
    () =>
      order.filter((id) => {
        const r = runs.get(id)
        return r ? runScope(r) === scope : false
      }),
    [order, runs, scope]
  )

  // Keep the shown run inside the current scope.
  const activeInScope = activeRunId && scopeIds.includes(activeRunId) ? activeRunId : null
  const shownId = activeInScope ?? scopeIds[scopeIds.length - 1] ?? null
  const active = shownId ? runs.get(shownId) : undefined
  const recent = scopeIds.slice(-6)

  const scopeLabel = scope
    ? displayName(scope.split('/')[1] ?? scope).short
    : 'workspace'

  return (
    <div className="flex h-full flex-col border-l border-adaptive-200 bg-adaptive-50">
      <div className="flex h-10 flex-none items-center gap-2 border-b border-adaptive-200 px-2.5">
        <SectionLabel>Output</SectionLabel>
        <button
          type="button"
          onClick={() => setScope(scope === null ? activeRepoId : null)}
          title={
            scope === null
              ? 'Showing workspace-level runs. Click to switch to the selected repo.'
              : 'Showing this repo. Click to switch to workspace-level runs.'
          }
          className="max-w-[130px] truncate rounded-sm border border-adaptive-200 px-1.5 py-0.5 font-mono text-[11px] text-adaptive-700 hover:border-adaptive-400"
        >
          {scopeLabel}
        </button>
        <span className="wa-num truncate font-mono text-[11px] text-adaptive-400">
          {active ? statusLabel(active) : 'idle'}
        </span>
        <div className="flex-1" />
        {active && active.summary.status.kind === 'running' && (
          <Button
            variant="waOutline"
            size="waXs"
            onClick={() => void api.cancelRun(active.runId).catch(() => {})}
          >
            Cancel
          </Button>
        )}
        <Button
          variant="waOutline"
          size="waXs"
          disabled={!active}
          onClick={() => active && clear(active.runId)}
        >
          Clear
        </Button>
      </div>

      {/* One chip per concurrent run. */}
      {recent.length > 1 && (
        <div className="flex flex-none flex-wrap gap-1 border-b border-adaptive-200 px-2.5 py-1.5">
          {recent.map((id) => {
            const r = runs.get(id)
            if (!r) return null
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActive(id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 font-mono text-[10.5px]',
                  id === activeRunId
                    ? 'border-adaptive-400 bg-background text-adaptive-900'
                    : 'border-adaptive-200 text-adaptive-500 hover:border-adaptive-400'
                )}
              >
                <StatusDot tone={runTone(r)} size={5} />
                <span className="max-w-24 truncate">{r.summary.kind}</span>
              </button>
            )
          })}
        </div>
      )}

      {active ? <LogView run={active} /> : <EmptyLog scope={scopeLabel} />}

      <div className="flex flex-none flex-wrap gap-1.5 border-t border-adaptive-200 px-2.5 py-2.5">
        <Button variant="waDashed" size="waChip" onClick={() => run({ kind: 'prList' })}>
          gh pr list
        </Button>
        <Button variant="waDashed" size="waChip" onClick={() => run({ kind: 'dockerPs' })}>
          docker ps
        </Button>
        <Button
          variant="waDashed"
          size="waChip"
          onClick={() => run({ kind: 'script', script: 'verify-repos', args: [] })}
        >
          verify-repos
        </Button>
        <Button variant="waDashed" size="waChip" onClick={() => run({ kind: 'fetchAll', ref: null })}>
          fetch --all
        </Button>
      </div>
    </div>
  )
}

function EmptyLog({ scope }: { scope: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 p-2.5 font-mono text-[11.5px] leading-[1.65]">
      <div className="text-adaptive-500">Nothing has run for {scope} yet.</div>
      <Prompt />
    </div>
  )
}

function LogView({ run }: { run: Run }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const setFollow = useRunStore((s) => s.setFollow)
  const append = useRunStore((s) => s.append)

  const lines = run.lines

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 19,
    overscan: 20,
    measureElement: (el) => el.getBoundingClientRect().height,
  })

  // Replay after a remount: fill any gap from the ring buffer, deduped by seq.
  useEffect(() => {
    if (lines.length > 0) return
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
  }, [run.runId, lines.length, append])

  // Tail only while following.
  useLayoutEffect(() => {
    if (!run.follow || lines.length === 0) return
    virtualizer.scrollToIndex(lines.length - 1, { align: 'end' })
  }, [lines.length, run.follow, virtualizer])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
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
        {run.droppedHead > 0 && (
          <div className="pb-1 text-adaptive-400 italic">
            … {run.droppedHead.toLocaleString()} earlier lines dropped
          </div>
        )}

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const line = lines[vi.index]!
            return (
              <div
                key={line.seq}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0"
                style={{ top: vi.start }}
              >
                <LogRow line={line} />
              </div>
            )
          })}
        </div>

        {run.summary.status.kind === 'running' && <Prompt />}
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

function LogRow({ line }: { line: LogLine }) {
  const truncated = line.text.length > MAX_LINE_CHARS
  const text = truncated ? `${line.text.slice(0, MAX_LINE_CHARS)}…` : line.text
  return (
    <div className={cn('break-words whitespace-pre-wrap', SEVERITY_CLASS[line.severity])}>
      {line.repo && line.severity !== 'cmd' && (
        <span className="mr-1.5 text-adaptive-400">{line.repo.split('/')[0]}</span>
      )}
      {text}
      {truncated && <span className="text-adaptive-400"> [line truncated]</span>}
    </div>
  )
}

function Prompt() {
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

function statusLabel(run: Run): string {
  const s = run.summary.status
  switch (s.kind) {
    case 'running':
      return `running ${run.summary.kind}…`
    case 'exited':
      return s.code === 0 ? 'done' : `exit ${s.code}`
    case 'signaled':
      return `signal ${s.signal}`
    case 'cancelled':
      return 'cancelled'
    case 'failed':
      return 'failed'
  }
}

function runTone(run: Run): Tone {
  const s = run.summary.status
  if (s.kind === 'running') return 'info'
  if (s.kind === 'exited') return s.code === 0 ? 'ok' : 'warn'
  if (s.kind === 'failed') return 'err'
  return 'idle'
}
