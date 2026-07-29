import type { DevServer, NeedsYouKind, RepoStatus, SyncState } from './types'

/**
 * One table drives every colour in the app.
 *
 * The design paints the same repo state in four places — the rail dot, the card
 * dot, the state pill and the stat-strip values. If each derived its colour
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

/** The design's rgba(…, 0.12) fill / rgba(…, 0.38) border tints, as tokens. */
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

export function derive(repo: RepoStatus, uiLatest: string | null): RepoDerived {
  const kinds: NeedsYouKind[] = []
  const b = behind(repo.sync)
  const a = ahead(repo.sync)
  const dirty = repo.dirtyCount + repo.untrackedCount
  const isStale = repo.stale.kind === 'stale'
  const uiMismatch =
    !!uiLatest && !!repo.uiDep.resolved && repo.uiDep.resolved !== uiLatest

  if (repo.error) kinds.push('error')
  if (dirty > 0) kinds.push('uncommitted')
  if (b > 0) kinds.push('behind')
  if (isStale) kinds.push('stale')
  if (uiMismatch) kinds.push('uiMismatch')
  if (repo.detached) kinds.push('detached')

  // Worst-wins ordering.
  const tone: Tone = repo.error
    ? 'err'
    : repo.conflictCount > 0
      ? 'err'
      : uiMismatch || repo.detached
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
        : uiMismatch
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
  uiMismatch: { label: 'ui mismatch', tone: 'err' },
  detached: { label: 'detached', tone: 'err' },
}

/** Strips the shared prefixes 43 of 63 repo names carry, for display. */
const PREFIXES = [
  'blazeup-subapp-sa-',
  'blazeup-subapp-',
  'blazeup-hostapp-',
  'blazeup-microservice-',
  'blazeup-lib-',
  'blazeup-mobile-',
  'blazeup-',
]

export function displayName(name: string): { short: string; prefix: string | null } {
  for (const p of PREFIXES) {
    if (name.startsWith(p) && name.length > p.length) {
      return { short: name.slice(p.length), prefix: p.replace(/-$/, '') }
    }
  }
  return { short: name, prefix: null }
}


/** The running instance of a named task, if any. */
export function taskOf(status: RepoStatus | undefined, task: string): DevServer | undefined {
  return status?.tasks.find((t) => t.task === task)
}

export function anyTaskRunning(status: RepoStatus | undefined): boolean {
  return (status?.tasks.length ?? 0) > 0
}
