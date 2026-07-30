import type { ChoreInfo, DevServer, NeedsYouKind, RepoStatus, SyncState } from './types'

/**
 * One table drives every colour in the app.
 *
 * The same repo state is painted in four places — the rail dot, the card dot,
 * the state pill and the stat-strip values. If each derived its colour
 * independently they would eventually disagree. Everything reads from here.
 */
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'idle'

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-sev-ok',
  warn: 'text-sev-warn',
  err: 'text-sev-err',
  info: 'text-sev-info',
  idle: 'text-sev-idle',
}

export const TONE_BG: Record<Tone, string> = {
  ok: 'bg-sev-ok',
  warn: 'bg-sev-warn',
  err: 'bg-sev-err',
  info: 'bg-sev-info',
  idle: 'bg-sev-idle',
}

/** Pill fill and border tints: the status colour at 12% and 38% opacity. */
export const TONE_TINT: Record<Tone, string> = {
  ok: 'bg-green-500/[0.12] border-green-500/[0.38]',
  warn: 'bg-amber-500/[0.12] border-amber-500/[0.38]',
  err: 'bg-red-500/[0.12] border-red-500/[0.38]',
  info: 'bg-blue-500/[0.12] border-blue-500/[0.38]',
  idle: 'bg-adaptive-200/60 border-adaptive-300',
}

export interface RepoDerived {
  tone: Tone
  /** Right-hand pill on the card: "build failing" / "stale 9d" / "ready". */
  stateLabel: string
  /** Mono flag in the rail: "●7" / "↓2" / "↑3" / "✓". */
  railFlag: string
  syncLabel: string
  syncTone: Tone
  dirtyLabel: string
  dirtyTone: Tone
  staleLabel: string | null
  needsAttention: boolean
  /** Which "Needs you" buckets this repo falls into. */
  kinds: NeedsYouKind[]
}

export function syncLabel(sync: SyncState): string {
  switch (sync.kind) {
    case 'noUpstream':
      return 'no upstream'
    case 'inSync':
      return 'in sync'
    case 'diverged': {
      const parts: string[] = []
      if (sync.ahead) parts.push(`↑${sync.ahead}`)
      if (sync.behind) parts.push(`↓${sync.behind}`)
      return parts.length ? parts.join(' ') : 'in sync'
    }
  }
}

export function ahead(sync: SyncState): number {
  return sync.kind === 'diverged' ? sync.ahead : 0
}

export function behind(sync: SyncState): number {
  return sync.kind === 'diverged' ? sync.behind : 0
}

export function derive(repo: RepoStatus, trackedLatest: string | null): RepoDerived {
  const kinds: NeedsYouKind[] = []
  const b = behind(repo.sync)
  const a = ahead(repo.sync)
  const dirty = repo.dirtyCount + repo.untrackedCount
  const isStale = repo.stale.kind === 'stale'
  const packageDrift =
    !!trackedLatest && !!repo.trackedDep.resolved && repo.trackedDep.resolved !== trackedLatest

  if (repo.error) kinds.push('error')
  if (dirty > 0) kinds.push('uncommitted')
  if (b > 0) kinds.push('behind')
  if (isStale) kinds.push('stale')
  if (packageDrift) kinds.push('packageDrift')
  if (repo.detached) kinds.push('detached')

  // Worst-wins ordering.
  const tone: Tone = repo.error
    ? 'err'
    : repo.conflictCount > 0
      ? 'err'
      : packageDrift || repo.detached
        ? 'err'
        : dirty > 0 || b > 0 || isStale
          ? 'warn'
          : a > 0
            ? 'info'
            : 'ok'

  const staleLabel = repo.stale.kind === 'stale' ? `stale ${repo.stale.days}d` : null

  const stateLabel = repo.error
    ? 'error'
    : repo.conflictCount > 0
      ? `${repo.conflictCount} conflict${repo.conflictCount > 1 ? 's' : ''}`
      : repo.detached
        ? 'detached HEAD'
        : packageDrift
          ? 'ui mismatch'
          : dirty > 0
            ? 'uncommitted'
            : staleLabel
              ? staleLabel
              : b > 0
                ? 'behind'
                : a > 0
                  ? 'ahead'
                  : 'ready'

  const railFlag = repo.error
    ? '!'
    : dirty > 0
      ? `●${dirty}`
      : b > 0
        ? `↓${b}`
        : a > 0
          ? `↑${a}`
          : '✓'

  return {
    tone,
    stateLabel,
    railFlag,
    syncLabel: syncLabel(repo.sync),
    syncTone: b > 0 ? 'warn' : a > 0 ? 'info' : repo.sync.kind === 'noUpstream' ? 'idle' : 'ok',
    dirtyLabel: dirty > 0 ? `${dirty} modified` : 'clean',
    dirtyTone: dirty > 0 ? 'warn' : 'ok',
    staleLabel,
    needsAttention: kinds.length > 0,
    kinds,
  }
}

export const NEEDS_YOU_META: Record<NeedsYouKind, { label: string; tone: Tone }> = {
  uncommitted: { label: 'uncommitted', tone: 'warn' },
  behind: { label: 'behind', tone: 'warn' },
  stale: { label: 'stale', tone: 'warn' },
  error: { label: 'errored', tone: 'err' },
  packageDrift: { label: 'version drift', tone: 'err' },
  detached: { label: 'detached', tone: 'err' },
}

// --- name prefixes ----------------------------------------------------------
//
// Many workspaces name repos with a shared prefix (`acme-service-billing`,
// `acme-service-auth`, …).
//
// Names are shown in full everywhere — an abbreviated name is a name you then have
// to hover to confirm, and the full one is what you type in a terminal or paste
// into a message. The stripped form survives only as a *search alias*, so typing
// `billing` ranks `acme-service-billing` as a prefix match rather than burying it
// among mid-string hits.
//
// The prefixes are *learned from the names in the workspace*, never hardcoded —
// a fixed list only ever describes one organisation's conventions.

/** How many repos must share a prefix before it counts as noise. */
const MIN_SHARED = 3

let learnedFrom = ''
let prefixes: string[] = []

/**
 * Derives the shared prefixes in a set of repo names, longest first.
 *
 * Candidates are whole hyphen-separated token boundaries only, so
 * `acme-billing` and `acme-bank` cannot produce a `acme-b` prefix that cuts a
 * word in half.
 */
export function derivePrefixes(names: string[]): string[] {
  const counts = new Map<string, number>()

  for (const name of names) {
    const tokens = name.split('-')
    // Proper prefixes only: stripping must always leave something behind.
    for (let i = 1; i < tokens.length; i++) {
      const candidate = `${tokens.slice(0, i).join('-')}-`
      counts.set(candidate, (counts.get(candidate) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .filter(([, n]) => n >= MIN_SHARED)
    .map(([p]) => p)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
}

/**
 * Teaches `searchAlias` the naming conventions of the open workspace.
 *
 * Call once per workspace, with every repo name. Cheap and idempotent: it
 * recomputes only when the set of names actually changes, so passing the same
 * list on every render costs a string compare.
 */
export function learnNamePrefixes(names: string[]): void {
  const key = names.join('\n')
  if (key === learnedFrom) return
  learnedFrom = key
  prefixes = derivePrefixes(names)
}

/** Test seam: forget what was learned, so cases cannot leak into each other. */
export function resetNamePrefixes(): void {
  learnedFrom = ''
  prefixes = []
}

/**
 * The name with its shared prefix removed, for *matching only*.
 *
 * Never rendered: repo names are shown in full. This exists so a query can match
 * the distinctive part of a name at prefix position.
 */
export function searchAlias(name: string): string {
  // prefixes is sorted longest-first, so the first match strips the most.
  const hit = prefixes.find((p) => name.startsWith(p) && name.length > p.length)
  return hit ? name.slice(hit.length) : name
}


/** The running instance of a named task, if any. */
export function taskOf(status: RepoStatus | undefined, task: string): DevServer | undefined {
  return status?.tasks.find((t) => t.task === task)
}

export function anyTaskRunning(status: RepoStatus | undefined): boolean {
  return (status?.tasks.length ?? 0) > 0
}

/**
 * What a Run button acts on for this repo.
 *
 * The task id is the repo's own — `bun run dev` for one, `cargo run` or
 * `manage.py runserver` for the next. Every button used to send the literal
 * `'dev'`, so a repo that spells its dev server anything else could not be started
 * at all, and the error blamed a missing `dev` script rather than saying so.
 *
 * `id` is null when nothing here runs. That is a real answer for a library or a
 * docs repo, and callers disable the button rather than sending a guess.
 */
export function runTarget(status: RepoStatus | undefined) {
  const id = status?.primaryTask ?? null
  const server = id ? taskOf(status, id) : undefined
  return {
    id,
    label: status?.runnable.find((t) => t.id === id)?.label ?? id ?? 'dev',
    server,
    // 'starting' counts as up: the button has to offer Stop, or a server stuck
    // starting can never be stopped from here.
    up: server?.state === 'up' || server?.state === 'starting',
  }
}

/**
 * The worst state across every task running in this repo, or null when none is.
 *
 * Worst rather than first, because a crash is the thing you need to see: a repo
 * with dev up and storybook dead is a repo that needs attention.
 */
export function runState(
  status: RepoStatus | undefined
): 'crashed' | 'up' | 'starting' | 'stopping' | null {
  const states = new Set((status?.tasks ?? []).map((t) => t.state))
  if (states.has('crashed')) return 'crashed'
  if (states.has('up')) return 'up'
  if (states.has('starting')) return 'starting'
  if (states.has('stopping')) return 'stopping'
  return null
}

/**
 * A repo's ecosystem commands, bucketed by their group heading.
 *
 * Order is the backend's — `chores` emits ecosystem by ecosystem — so a React
 * Native repo reads Packages, React Native, Gradle, CocoaPods rather than in
 * whatever order a Map happened to hash.
 */
export function choresByGroup(status: RepoStatus | undefined): [string, ChoreInfo[]][] {
  const out = new Map<string, ChoreInfo[]>()
  for (const c of status?.chores ?? []) {
    const list = out.get(c.group)
    if (list) list.push(c)
    else out.set(c.group, [c])
  }
  return [...out.entries()]
}

/** The run whose log holds the failure, for a "view the error" affordance. */
export function crashedRunId(status: RepoStatus | undefined): string | null {
  return (status?.tasks ?? []).find((t) => t.state === 'crashed')?.runId ?? null
}
