import { useMemo } from 'react'
import { Star, X } from 'lucide-react'
import { StatusDot } from '@/components/wa/primitives'
import { derive } from '@/domain/severity'
import { repoId, type RepoRef } from '@/domain/types'
import { cn } from '@/lib/utils'
import { useRepoLists } from '@/stores/repo-lists'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'

/** One frozen array, so an empty list is not a new reference every render. */
const EMPTY: RepoRef[] = []

/**
 * Pinned and recent repos, as two short lists at the top of the rail.
 *
 * The rail is otherwise organised by *folder*, which is the right shape for
 * finding a repo you have not thought about — and the wrong one for the four you
 * work in every day, which is three clicks and a scan away. These two lists are
 * the shortcut: one you curate, one that curates itself.
 *
 * Both are per workspace and both stay hidden until they have something in them,
 * so a fresh workspace's rail is exactly as it was.
 */
export function RepoShortcuts() {
  const root = useUiStore((s) => s.workspaceRoot)
  // Subscribed to the stored object, then derived here. Deriving *in* the selector
  // would return a new array each call, and zustand compares by reference.
  const lists = useRepoLists((s) => s.byRoot[root])
  const pinned = lists?.pinned ?? EMPTY
  const recent = useMemo(() => {
    if (!lists) return EMPTY
    const pinnedIds = new Set(lists.pinned.map(repoId))
    return lists.recent.filter((r) => !pinnedIds.has(repoId(r)))
  }, [lists])

  if (pinned.length === 0 && recent.length === 0) return null

  return (
    <div className="flex flex-col gap-1">
      {pinned.length > 0 && <ShortcutList title="Pinned" repos={pinned} pinned />}
      {recent.length > 0 && <ShortcutList title="Recent" repos={recent} />}
    </div>
  )
}

function ShortcutList({
  title,
  repos,
  pinned = false,
}: {
  title: string
  repos: RepoRef[]
  pinned?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1.5 pb-1">
        <span className="text-[11px] font-bold tracking-[0.06em] text-adaptive-500 uppercase">
          {title}
        </span>
        <span className="wa-num font-mono text-[11px] text-adaptive-400">{repos.length}</span>
      </div>
      {repos.map((r) => (
        <ShortcutRow key={repoId(r)} repo={r} pinned={pinned} />
      ))}
    </div>
  )
}

function ShortcutRow({ repo, pinned }: { repo: RepoRef; pinned: boolean }) {
  const id = repoId(repo)
  const openDetail = useUiStore((s) => s.openDetail)
  const root = useUiStore((s) => s.workspaceRoot)
  const togglePin = useRepoLists((s) => s.togglePin)
  // Only this row's status, so a scan streaming in re-renders one line.
  const status = useScanStore((s) => s.repos.get(id))
  const trackedLatest = useScanStore((s) => s.trackedLatest)
  const d = status ? derive(status, trackedLatest) : null

  return (
    <div className="group flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-adaptive-200">
      <button
        type="button"
        onClick={() => openDetail(id)}
        title={`${id} — open`}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        {d ? (
          <StatusDot tone={d.tone} size={6} />
        ) : (
          // Not scanned yet — a grey dot rather than nothing, so the row does not
          // jump sideways when the scan lands.
          <span className="size-[6px] flex-none rounded-full bg-adaptive-300" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-adaptive-800">
          {repo.name}
        </span>
        {repo.category && (
          <span className="flex-none font-mono text-[9.5px] text-adaptive-400">
            {repo.category}
          </span>
        )}
      </button>
      {/* On hover only: the rail is 214px, and a column of stars beside four names
          is more furniture than the names themselves. */}
      <button
        type="button"
        onClick={() => togglePin(root, repo)}
        title={pinned ? `Unpin ${repo.name}` : `Pin ${repo.name}`}
        aria-label={pinned ? 'Unpin' : 'Pin'}
        className={cn(
          'hidden flex-none text-adaptive-400 group-hover:block',
          pinned ? 'hover:text-adaptive-900' : 'hover:text-sev-warn'
        )}
      >
        {pinned ? <X className="size-3" /> : <Star className="size-3" />}
      </button>
    </div>
  )
}
