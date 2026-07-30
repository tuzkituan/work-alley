import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { TONE_BG, TONE_TEXT } from '@/domain/severity'
import { repoId } from '@/domain/types'
import type { Run } from '@/stores/run-store'
import { failureHint } from '@/features/workspace/clone-log'
import { BULK_TONE, bulkKind, parseBulkLog, tallyBulk, type BulkResult } from './bulk-log'

/**
 * Per-repo progress for a bulk run — the answer to "how many repos".
 *
 * A 40-repo pull used to be one chip and a wall of interleaved git output: the only
 * way to learn that two repos had failed was to read all of it. Every bulk script
 * already brackets each repo with `[..]/[OK]/[FAIL]/[SKIP]` markers, so this is
 * parsed from the log the run already produced — no backend involvement.
 *
 * Collapsed to the interesting rows by default. `CloneProgress` shows every repo
 * because it owns a full window; here the log is the point and a 40-row list would
 * bury it in a 372px pane.
 */
export function BulkProgress({
  run,
  onSelectRepo,
  selected,
}: {
  run: Run
  /** Filters the log below to one repo — see `LogLine.repo`. */
  onSelectRepo?: (key: string | null) => void
  selected?: string | null
}) {
  const [showAll, setShowAll] = useState(false)
  const { summary } = run
  const meta = bulkKind(summary.kind)

  const results = useMemo(() => {
    if (!meta) return []
    const status = summary.status
    return parseBulkLog(run.lines, {
      expected: (summary.targets ?? []).map(repoId),
      implicitOk: meta.implicitOk,
      finished: status.kind !== 'running',
      // A cancel or a failure must not let the parser call an unresolved repo done.
      ok: status.kind === 'exited' && status.code === 0,
    })
    // `meta` already carries everything derived from `summary.kind`.
  }, [run.lines, summary.targets, summary.status, meta])

  if (!meta || (summary.targets?.length ?? 0) < 2) return null

  const t = tallyBulk(results)
  const done = t.ok + t.skipped + t.failed.length + t.unknown
  // Determinate because `targets` gives a real denominator — the reason that field
  // is the linchpin of this whole panel.
  const pct = t.total > 0 ? (done / t.total) * 100 : 0

  const interesting = results.filter(
    (r) => r.state === 'failed' || r.state === 'active' || r.state === 'unknown'
  )
  const rows = showAll ? results : interesting

  return (
    <div className="flex-none border-b border-adaptive-200 bg-adaptive-100/50">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5 font-mono text-[11px]">
        <span className="text-sev-ok">
          {t.ok} {meta.verb}
        </span>
        {t.active > 0 && <span className="text-sev-info">{t.active} active</span>}
        {t.queued > 0 && <span className="text-adaptive-400">{t.queued} queued</span>}
        {t.skipped > 0 && <span className="text-sev-warn">{t.skipped} skipped</span>}
        {t.failed.length > 0 && <span className="text-sev-err">{t.failed.length} failed</span>}
        {/* Started and never resolved — a cancel, most often. Not folded into either
            success or failure, because we genuinely do not know. */}
        {t.unknown > 0 && <span className="text-sev-warn">{t.unknown} unknown</span>}
        <span className="wa-num ml-auto text-adaptive-400">
          {done}/{t.total}
        </span>
      </div>

      <Progress
        value={pct}
        className="h-[2px] rounded-none bg-adaptive-200"
        aria-label={`${done} of ${t.total} repos done`}
      />

      {rows.length > 0 && (
        <div className="wa-scroll max-h-40 overflow-y-auto">
          {rows.map((r) => (
            <BulkRow
              key={r.name}
              result={r}
              selected={selected === r.name}
              onSelect={
                onSelectRepo
                  ? () => onSelectRepo(selected === r.name ? null : r.name)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {/* Only offered when there is something hidden. */}
      {results.length > interesting.length && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="w-full px-2.5 py-1 text-left text-[10.5px] text-adaptive-400 hover:text-adaptive-800"
        >
          {showAll ? 'Show only failures and active' : `Show all ${results.length}`}
        </button>
      )}
    </div>
  )
}

/** One repo. Failures open by default — a collapsed failure is one nobody reads. */
function BulkRow({
  result,
  selected,
  onSelect,
}: {
  result: BulkResult
  selected: boolean
  onSelect?: () => void
}) {
  const [open, setOpen] = useState(result.state === 'failed')
  const hasDetail = result.detail.length > 0
  const tone = BULK_TONE[result.state]
  // The same recogniser the clone wizard uses; these are git transport errors either
  // way, and a pull fails for the same handful of reasons a clone does.
  const hint = result.state === 'failed' ? failureHint(result.detail) : null

  return (
    <div className={cn('border-t border-adaptive-200/60', selected && 'bg-adaptive-200/60')}>
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1 text-left"
      >
        <span
          className={cn('size-1.5 flex-none rounded-full', TONE_BG[tone])}
          style={result.state === 'active' ? { animation: 'wa-blink 1.4s step-end infinite' } : undefined}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-adaptive-800">
          {result.name}
        </span>
        {hint && (
          <span className="wa-o-narrow max-w-[50%] truncate text-[10.5px] text-sev-err">{hint}</span>
        )}
        <span className={cn('flex-none text-[10.5px]', TONE_TEXT[tone])}>{result.state}</span>
        {/* Filters the log to this repo, which is what the per-line attribution from
            Rust is for. A second control rather than the row itself, so expanding the
            captured output and narrowing the log stay separate. */}
        {onSelect && (
          <span
            role="button"
            tabIndex={0}
            title={selected ? 'Show every repo again' : `Show only ${result.name} in the log`}
            onClick={(e) => {
              e.stopPropagation()
              onSelect()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onSelect()
              }
            }}
            className={cn(
              'flex-none rounded-sm px-1 text-[10.5px]',
              selected ? 'text-adaptive-900' : 'text-adaptive-400 hover:text-adaptive-900'
            )}
          >
            log
          </span>
        )}
        {hasDetail &&
          (open ? (
            <ChevronDown className="size-3 flex-none text-adaptive-400" />
          ) : (
            <ChevronRight className="size-3 flex-none text-adaptive-400" />
          ))}
      </button>
      {open && hasDetail && (
        <pre className="wa-scroll max-h-32 overflow-auto px-2.5 pb-1.5 font-mono text-[10.5px] whitespace-pre-wrap text-adaptive-500">
          {result.detail.join('\n')}
        </pre>
      )}
    </div>
  )
}
