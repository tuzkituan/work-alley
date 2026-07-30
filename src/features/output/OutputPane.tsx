import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel, StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import { api } from '@/ipc/commands'
import { runScope, useRunStore, type Run } from '@/stores/run-store'
import { useScanStore } from '@/stores/scan-store'
import { termScope, useTerminalStore, type TermTab } from '@/stores/terminal-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'
import { useContainerRuntime, useHeadlessScripts } from '@/hooks/use-bootstrap'
import { TerminalView } from '@/features/terminal/TerminalView'
import { applyFontSize } from '@/features/terminal/xterm-instance'
import { useTermPalette } from '@/features/terminal/use-term-palette'
import { SEVERITY_CLASS } from './severity-class'
import { estimateGeometry } from './term-geometry'
import type { LogLine, RepoRef } from '@/domain/types'
import type { Tone } from '@/domain/severity'

/**
 * Compact age, for the run chips: `now`, `12s`, `4m`, `2h`.
 *
 * Not a wall-clock time: "started 4m ago" answers "which one did I just start",
 * which is the actual question when several runs of the same command are listed.
 */
function ago(startedUnix: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - startedUnix)
  if (secs < 5) return 'now'
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86_400)}d`
}

/** One 200KB stack-trace line would otherwise measure into a giant row. */
const MAX_LINE_CHARS = 2_000

export function OutputPane() {
  const runs = useRunStore((s) => s.runs)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const setActive = useRunStore((s) => s.setActive)
  const scripts = useHeadlessScripts()
  const runtime = useContainerRuntime()
  const clear = useRunStore((s) => s.clear)
  const dismiss = useRunStore((s) => s.dismiss)
  const run = useRunAction()

  const tabs = useTerminalStore((s) => s.tabs)
  const termOrder = useTerminalStore((s) => s.order)
  const activeTermId = useTerminalStore((s) => s.activeTermId)
  const setActiveTerm = useTerminalStore((s) => s.setActive)
  const closeTerm = useTerminalStore((s) => s.close)
  const termFontSize = useUiStore((s) => s.termFontSize)
  const scanRepos = useScanStore((s) => s.repos)
  const bodyRef = useRef<HTMLDivElement>(null)

  useTermPalette()
  useEffect(() => {
    applyFontSize(termFontSize)
  }, [termFontSize])

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
  // Newest first: with several runs of the same command in one repo, the one you
  // just started is the one you want, and it was previously last in a wrapped grid.
  const recent = useMemo(() => [...scopeIds].reverse(), [scopeIds])
  const finished = useMemo(
    () => recent.filter((id) => runs.get(id)?.summary.status.kind !== 'running'),
    [recent, runs]
  )

  // Terminal tabs are scoped exactly like runs, so one scope toggle governs both.
  const scopeTerms = useMemo(
    () =>
      termOrder.filter((id) => {
        const t = tabs.get(id)
        return t ? termScope(t) === scope : false
      }),
    [termOrder, tabs, scope]
  )
  // Showing a terminal from another repo would contradict the scope button.
  const shownTermId = activeTermId && scopeTerms.includes(activeTermId) ? activeTermId : null
  const shownTerm = shownTermId ? tabs.get(shownTermId) : undefined

  const scopeLabel = scope
    ? (scope.split('/')[1] ?? scope)
    : 'workspace'

  // The `ref` a new terminal should belong to. Looked up rather than parsed out
  // of the scope id, because a category or a repo name can itself contain a
  // slash and splitting would silently open the shell in the wrong folder.
  const scopeRef: RepoRef | null = (scope ? scanRepos.get(scope)?.ref : null) ?? null

  const openTerminal = (external = false) =>
    run({
      kind: 'openShell',
      ref: scopeRef,
      external,
      size: estimateGeometry(bodyRef.current, termFontSize),
    })

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
          {shownTerm ? termStatusLabel(shownTerm) : active ? statusLabel(active) : 'idle'}
        </span>
        <div className="flex-1" />
        {/* Terminal-specific controls replace the run controls wholesale: Cancel,
            Dismiss and Clear all act on a run, and none of them means anything
            while a shell is showing. */}
        {shownTerm ? (
          <>
            <span className="flex items-center rounded-sm border border-adaptive-200 font-mono text-[11px] text-adaptive-500">
              <button
                type="button"
                aria-label="Smaller terminal text"
                className="px-1.5 hover:text-adaptive-900"
                onClick={() => useUiStore.getState().setTermFontSize(termFontSize - 1)}
              >
                −
              </button>
              <button
                type="button"
                aria-label="Larger terminal text"
                className="px-1.5 hover:text-adaptive-900"
                onClick={() => useUiStore.getState().setTermFontSize(termFontSize + 1)}
              >
                +
              </button>
            </span>
            {/* The fallback. Also where the NO_TERMINAL toast still earns its
                keep, for a machine with no emulator installed. */}
            <Button
              variant="waOutline"
              size="waXs"
              title="Open a shell in the system terminal emulator instead"
              onClick={() => openTerminal(true)}
            >
              Externally
            </Button>
            <Button
              variant="waOutline"
              size="waXs"
              title="Close this terminal and hang up its shell"
              onClick={() => closeTerm(shownTerm.termId)}
            >
              {shownTerm.status === 'live' ? 'Kill' : 'Close'}
            </Button>
          </>
        ) : (
          <>
            {active && active.summary.status.kind === 'running' && (
              <Button
                variant="waOutline"
                size="waXs"
                onClick={() => void api.cancelRun(active.runId).catch(() => {})}
              >
                Cancel
              </Button>
            )}
            {finished.length > 1 && (
              <Button
                variant="waOutline"
                size="waXs"
                title={`Dismiss ${finished.length} finished runs in this scope`}
                onClick={() => {
                  // Finished runs accumulate one per start; without this the strip
                  // grows until it is unreadable, which is exactly what it did.
                  for (const id of finished) {
                    dismiss(id)
                    void api.dismissRun(id).catch(() => {})
                  }
                }}
              >
                Dismiss {finished.length}
              </Button>
            )}
            <Button
              variant="waOutline"
              size="waXs"
              disabled={!active}
              title="Clear this run's output"
              onClick={() => active && clear(active.runId)}
            >
              Clear
            </Button>
          </>
        )}
      </div>

      {/* View selector: the run log, then one chip per terminal in this scope.
       *
       * Deliberately not <Tabs> from components/ui. Radix unmounts TabsContent on
       * switch, which would destroy the xterm instance; forceMount instead gives a
       * display:none box, so fit() measures 0x0 and the geometry comes back wrong
       * on re-show. A plain strip plus a conditional render, backed by the module
       * cache in xterm-instance.ts, is both simpler and correct. */}
      <div className="wa-scroll flex flex-none items-center gap-1 overflow-x-auto border-b border-adaptive-200 px-2.5 py-1.5">
        <ViewChip active={shownTermId === null} onClick={() => setActiveTerm(null)}>
          Log
        </ViewChip>
        {scopeTerms.map((id) => {
          const t = tabs.get(id)
          if (!t) return null
          return (
            <span
              key={id}
              className={cn(
                'flex h-[22px] flex-none items-center gap-1.5 rounded-[5px] border pr-0.5 pl-1.5 font-mono text-[10.5px]',
                id === shownTermId
                  ? 'border-adaptive-400 bg-background text-adaptive-900'
                  : 'border-adaptive-200 text-adaptive-500 hover:border-adaptive-400'
              )}
            >
              <button
                type="button"
                onClick={() => setActiveTerm(id)}
                title={`${t.title} — ${t.cwd}`}
                className="flex items-center gap-1.5"
              >
                <StatusDot tone={t.status === 'live' ? 'info' : 'idle'} size={5} />
                <span className="max-w-28 truncate">{t.title}</span>
              </button>
              <button
                type="button"
                aria-label="Close this terminal"
                onClick={() => closeTerm(id)}
                className="flex size-3.5 flex-none items-center justify-center rounded-sm text-adaptive-400 hover:bg-adaptive-200 hover:text-adaptive-900"
              >
                <X className="size-2.5" />
              </button>
            </span>
          )
        })}
        <button
          type="button"
          aria-label={`New terminal in ${scopeLabel}`}
          title={`New terminal in ${scopeLabel}`}
          onClick={() => openTerminal()}
          className="flex size-[22px] flex-none items-center justify-center rounded-[5px] border border-adaptive-200 text-adaptive-400 hover:border-adaptive-400 hover:text-adaptive-900"
        >
          <Plus className="size-3" />
        </button>
      </div>

      {/* One chip per run in this scope.
       *
       * A single scrolling row, not a wrapping grid: every run in one repo has the
       * same `kind`, so a grid of a dozen identical "devStart" chips over four rows
       * was impossible to read. Each chip now carries how long ago it started —
       * within one scope that is the only thing that tells them apart — and can be
       * dismissed individually. */}
      {shownTermId === null && recent.length > 1 && (
        <div className="wa-scroll flex flex-none items-center gap-1 overflow-x-auto border-b border-adaptive-200 px-2.5 py-1.5">
          {recent.map((id) => {
            const r = runs.get(id)
            if (!r) return null
            const running = r.summary.status.kind === 'running'
            return (
              <span
                key={id}
                className={cn(
                  'flex h-[22px] flex-none items-center gap-1.5 rounded-[5px] border pl-1.5 font-mono text-[10.5px]',
                  running ? 'pr-1.5' : 'pr-0.5',
                  id === activeRunId
                    ? 'border-adaptive-400 bg-background text-adaptive-900'
                    : 'border-adaptive-200 text-adaptive-500 hover:border-adaptive-400'
                )}
              >
                <button
                  type="button"
                  onClick={() => setActive(id)}
                  title={`${r.summary.title} — ${statusLabel(r)}`}
                  className="flex items-center gap-1.5"
                >
                  <StatusDot tone={runTone(r)} size={5} />
                  <span className="max-w-28 truncate">{r.summary.kind}</span>
                  <span className="wa-num text-adaptive-400">{ago(r.summary.startedUnix)}</span>
                </button>
                {/* Only finished runs: dismissing a live one would orphan it. */}
                {!running && (
                  <button
                    type="button"
                    aria-label="Dismiss this run"
                    onClick={() => {
                      dismiss(id)
                      void api.dismissRun(id).catch(() => {})
                    }}
                    className="flex size-3.5 flex-none items-center justify-center rounded-sm text-adaptive-400 hover:bg-adaptive-200 hover:text-adaptive-900"
                  >
                    <X className="size-2.5" />
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}

      {/* `bodyRef` is what `estimateGeometry` measures, so a new shell starts at
          roughly the right size instead of reprinting its prompt a frame later. */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {shownTermId !== null ? (
          <TerminalView key={shownTermId} termId={shownTermId} />
        ) : active ? (
          <LogView run={active} />
        ) : (
          <EmptyLog scope={scopeLabel} />
        )}
      </div>

      {/* Quick actions. The script chips come from whatever this workspace has in
          scripts/ — there is no built-in script to hardcode.
          Hidden while a terminal is showing: their output goes to the log anyway,
          and 60px of height is worth a lot in a pane this narrow. */}
      {shownTermId === null && (
        <div className="flex flex-none flex-wrap gap-1.5 border-t border-adaptive-200 px-2.5 py-2.5">
          <Button variant="waDashed" size="waChip" onClick={() => run({ kind: 'prList' })}>
            gh pr list
          </Button>
          {runtime && (
            <Button variant="waDashed" size="waChip" onClick={() => run({ kind: 'dockerPs' })}>
              {runtime} ps
            </Button>
          )}
          <Button
            variant="waDashed"
            size="waChip"
            onClick={() => run({ kind: 'fetchAll', ref: null })}
          >
            fetch --all
          </Button>
          {scripts.map((s) => (
            <Button
              key={s.id}
              variant="waDashed"
              size="waChip"
              title={s.description}
              onClick={() => run({ kind: 'script', script: s.id, args: [] })}
            >
              {s.id}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The `Log` entry in the view strip; terminal chips carry a status dot instead. */
function ViewChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[22px] flex-none items-center rounded-[5px] border px-2 font-mono text-[10.5px]',
        active
          ? 'border-adaptive-400 bg-background text-adaptive-900'
          : 'border-adaptive-200 text-adaptive-500 hover:border-adaptive-400'
      )}
    >
      {children}
    </button>
  )
}

function termStatusLabel(t: TermTab): string {
  if (t.status === 'live') return 'shell'
  return t.exitCode === 0 ? 'exited' : `exit ${t.exitCode ?? '?'}`
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
