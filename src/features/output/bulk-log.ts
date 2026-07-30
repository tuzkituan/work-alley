import type { Tone } from '@/domain/severity'
import type { LogLine } from '@/domain/types'

/**
 * Per-repo results for a bulk run, parsed out of its log.
 *
 * Every generated bulk script already brackets each repo with `[..] / [OK] / [FAIL]
 * / [SKIP] {key}` markers — that is how `ansi::classify` colours them — so the log
 * is the only place per-repo outcome exists, and it is interleaved with git's noise.
 * Attributing each line to the repo in flight is what makes "2 failed" answer *which
 * two, and why*.
 *
 * This started as the clone wizard's parser and is now the engine for pull, fetch and
 * checkout too. `clone-log.ts` is a thin wrapper over it.
 */

export type BulkState = 'queued' | 'active' | 'ok' | 'skipped' | 'failed' | 'unknown'

export interface BulkResult {
  /** The repo key exactly as the script printed it: `category/name`, or a bare name. */
  name: string
  state: BulkState
  /** Everything the command said while this repo was in flight. */
  detail: string[]
  /** A short, actionable reading of `detail`, when the caller can recognise one. */
  hint: string | null
}

export interface BulkOptions {
  /**
   * The keys to expect, from `summary.targets`.
   *
   * Two jobs. It renders repos that have not started yet as `queued`, so a 40-repo
   * run shows 40 rows from the first frame instead of growing one at a time. And it
   * is matched longest-first against a marker's remainder, which is how a suffix is
   * stripped safely: checkout prints `[OK]   fe/web -> main` and `[SKIP] fe/web — 3
   * local change(s)`, and splitting on a delimiter would break a repo name that
   * contains one.
   */
  expected?: string[]
  /**
   * Success is implicit: an entry the log has moved past succeeded.
   *
   * True only for `pullMany`, whose script echoes `[..] {key}` and then *only*
   * `[FAIL] {key}` — there is no per-repo `[OK]`. Without this every pulled repo
   * stays "in progress" forever.
   */
  implicitOk?: boolean
  /** The run has ended, so a still-open entry has to be resolved one way or another. */
  finished?: boolean
  /** The run ended cleanly. A cancel mid-repo must never be reported as success. */
  ok?: boolean
}

const START = '[..]   '
const OK = '[OK]   '
const FAIL = '[FAIL] '
const SKIP = '[SKIP] '

export const BULK_TONE: Record<BulkState, Tone> = {
  queued: 'idle',
  active: 'info',
  ok: 'ok',
  skipped: 'warn',
  failed: 'err',
  // Started and never resolved — a cancel, or output we could not attribute. Not
  // green: claiming success for work that may not have happened is the one failure
  // mode that matters here.
  unknown: 'warn',
}

export function parseBulkLog(lines: LogLine[], opts: BulkOptions = {}): BulkResult[] {
  const { implicitOk = false, finished = false, ok = false } = opts
  // Longest first, so `fe/web-admin` wins over `fe/web` on a line naming the former.
  const expected = [...(opts.expected ?? [])].sort((a, b) => b.length - a.length)

  const results: BulkResult[] = []
  const byName = new Map<string, BulkResult>()
  let current: BulkResult | null = null

  const entry = (name: string): BulkResult => {
    let r = byName.get(name)
    if (!r) {
      r = { name, state: 'queued', detail: [], hint: null }
      byName.set(name, r)
      results.push(r)
    }
    return r
  }

  /** Resolves whatever was in flight before a different repo's marker arrives. */
  const closeCurrent = () => {
    if (!current || current.state !== 'active') return
    current.state = implicitOk ? 'ok' : 'unknown'
    current = null
  }

  for (const l of lines) {
    const t = l.text
    const marked = marker(t)

    if (marked) {
      const name = keyOf(marked.rest, expected)
      // The script's own closing line — "clone finished", "bulk pull finished",
      // "checkout finished" — is not a repo.
      if (name === null) {
        if (marked.kind === 'ok') closeCurrent()
        continue
      }
      const why = marked.rest.slice(name.length).replace(/^\s*(—|->|-)\s*/, '').trim()

      if (marked.kind === 'start') {
        closeCurrent()
        current = entry(name)
        current.state = 'active'
        if (why) current.detail.push(why)
        continue
      }

      if (current && current.name !== name) closeCurrent()
      const r = entry(name)
      r.state = marked.kind === 'ok' ? 'ok' : marked.kind === 'fail' ? 'failed' : 'skipped'
      if (why) r.detail.push(why)
      if (current?.name === name) current = null
      continue
    }

    // Ordinary output belongs to whichever repo is in flight.
    if (current && t.trim()) current.detail.push(t)
  }

  // Anything still open when the run ended. Only a clean end *and* implicit success
  // may call it done; otherwise it is genuinely unknown.
  if (finished) {
    for (const r of results) {
      if (r.state === 'active') r.state = implicitOk && ok ? 'ok' : 'unknown'
    }
  }

  // Repos the log never mentioned are queued, not missing.
  for (const name of opts.expected ?? []) entry(name)

  return results
}

/** Splits a marker line into its kind and the text after it. */
function marker(text: string): { kind: 'start' | 'ok' | 'fail' | 'skip'; rest: string } | null {
  if (text.startsWith(START)) return { kind: 'start', rest: text.slice(START.length).trim() }
  if (text.startsWith(OK)) return { kind: 'ok', rest: text.slice(OK.length).trim() }
  if (text.startsWith(FAIL)) return { kind: 'fail', rest: text.slice(FAIL.length).trim() }
  if (text.startsWith(SKIP)) return { kind: 'skip', rest: text.slice(SKIP.length).trim() }
  return null
}

/**
 * The repo key at the head of a marker's remainder.
 *
 * With `expected` this is exact — a longest-first prefix match, so suffixes cannot be
 * mistaken for part of a name. Without it (the clone path, which has no `targets`) it
 * falls back to the old behaviour of splitting on the em dash.
 */
function keyOf(rest: string, expected: string[]): string | null {
  for (const key of expected) {
    if (rest === key || rest.startsWith(`${key} `)) return key
  }
  if (expected.length > 0) {
    // A remainder that matches nothing expected is the script's own status line.
    return null
  }
  const head = (rest.split(' — ')[0] ?? rest).trim()
  // Guard the no-expected case too: "clone finished" is not a repo.
  return head === '' || /\bfinished$/.test(head) ? null : head
}

export function tallyBulk(results: BulkResult[]) {
  const by = (s: BulkState) => results.filter((r) => r.state === s)
  return {
    ok: by('ok').length,
    failed: by('failed'),
    skipped: by('skipped').length,
    active: by('active').length,
    queued: by('queued').length,
    unknown: by('unknown').length,
    total: results.length,
  }
}

/**
 * Which run kinds have per-repo markers worth parsing, and how each behaves.
 *
 * Per-command quirks in one named place rather than scattered through the view:
 * `pullMany` has no per-repo `[OK]`, and `fetchMany`/`fetchAll` emit no `[..]` at
 * all, so a fetch has no in-flight state to show.
 */
const BULK_KINDS: Record<string, { implicitOk: boolean; verb: string }> = {
  pullMany: { implicitOk: true, verb: 'pulled' },
  fetchMany: { implicitOk: false, verb: 'fetched' },
  fetchAll: { implicitOk: false, verb: 'fetched' },
  checkout: { implicitOk: false, verb: 'switched' },
  cloneUrls: { implicitOk: false, verb: 'cloned' },
}

export function bulkKind(kind: string): { implicitOk: boolean; verb: string } | null {
  return BULK_KINDS[kind] ?? null
}

export function isBulkKind(kind: string): boolean {
  return kind in BULK_KINDS
}
