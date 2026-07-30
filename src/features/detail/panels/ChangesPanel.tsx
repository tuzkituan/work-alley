import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FileDiff, FolderOpen } from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { Input } from '@/components/ui/input'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { TONE_TEXT, type Tone } from '@/domain/severity'
import type { ChangedFile, RepoId, RepoRef } from '@/domain/types'
import { useRunAction } from '@/hooks/use-action'
import { useScanStore } from '@/stores/scan-store'
import { groupChanges, type ChangeGroup } from './changes-groups'
import { DiffView } from './DiffView'
import { InspectChip, PanelEmpty, PanelError, PanelSkeleton, TabPanel } from './panel-parts'

export function ChangesPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const run = useRunAction()
  const repoPath = useScanStore((s) => s.repos.get(id)?.path)
  const [filter, setFilter] = useState('')
  // Keyed `group:path`, because one file can legitimately be open in both the staged
  // and the unstaged group and each shows a different patch.
  const [open, setOpen] = useState<string | null>(null)

  // `error` is destructured deliberately: without it this panel fell through to
  // `data ?? []` and reported a clean working tree when the IPC had failed.
  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: keys.changedFiles(id),
    queryFn: () => api.listChangedFiles(repo),
    staleTime: 10_000,
  })

  // Its own query, not a field on the scan: the scan runs per repo across a whole
  // folder and is already the app's latency budget, and only this panel wants it.
  // What it buys is knowing whether Pop will do anything before you click it.
  const stashes = useQuery({
    queryKey: keys.stashes(id),
    queryFn: () => api.listStashes(repo),
    staleTime: 30_000,
  })
  const stashCount = stashes.data?.length ?? 0

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const files = q ? (data ?? []).filter((f) => f.path.toLowerCase().includes(q)) : (data ?? [])
    return groupChanges(files)
  }, [data, filter])

  const counts = useMemo(() => {
    const all = groupChanges(data ?? [])
    const n = (id: ChangeGroup['id']) => all.find((g) => g.id === id)?.files.length ?? 0
    return { staged: n('staged'), unstaged: n('unstaged'), untracked: n('untracked'), conflicts: n('conflicts') }
  }, [data])

  const dirty = data?.length ?? 0

  return (
    <TabPanel
      icon={<FileDiff className="size-3.5 text-adaptive-400" />}
      title={error ? 'Changes' : `${dirty} changed`}
      right={
        !error && dirty > 0 ? (
          <span className="truncate font-mono text-[11px] text-adaptive-400">
            {counts.staged} staged · {counts.unstaged} not staged
            {counts.untracked > 0 && ` · ${counts.untracked} new`}
            {counts.conflicts > 0 && (
              <span className="text-sev-err"> · {counts.conflicts} conflict</span>
            )}
          </span>
        ) : undefined
      }
      isFetching={isFetching}
      onRefresh={() => void refetch()}
      actions={
        <>
          <div className="relative w-[13rem] flex-none">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setFilter('')
              }}
              placeholder="Filter paths…"
              aria-label="Filter changed files by path"
              className="h-[26px] text-xs"
            />
          </div>
          {/* The whole patch, for when a 400px panel is not enough — read-only, so
              one click and no dialog. */}
          <InspectChip
            label="Diff…"
            title="Show the full unstaged diff in the output pane"
            onClick={() => run({ kind: 'diff', ref: repo })}
          />
          <InspectChip
            label="Status…"
            title="Show git status in the output pane"
            onClick={() => run({ kind: 'status', ref: repo })}
          />
          <span className="mx-0.5 h-4 w-px bg-adaptive-200" />
          <InspectChip
            label="Stash"
            title="Move tracked changes onto the stash"
            onClick={() => run({ kind: 'stash', ref: repo })}
          />
          <InspectChip
            label="Stash -u"
            title="Stash, including untracked files"
            onClick={() => run({ kind: 'stash', ref: repo, includeUntracked: true })}
          />
          {/* The count is the point: "Pop" on an empty stash is an error Rust
              refuses, and knowing that before clicking beats being told after. */}
          <InspectChip
            label={stashCount > 0 ? `Pop (${stashCount})` : 'Pop'}
            title={
              stashCount > 0
                ? `Re-apply ${stashes.data![0]!.selector} — ${stashes.data![0]!.message}`
                : 'The stash is empty'
            }
            onClick={() => run({ kind: 'stashPop', ref: repo })}
          />
          {stashCount > 0 && (
            <InspectChip
              label="Stash list…"
              title="Show every stash entry in the output pane"
              onClick={() => run({ kind: 'stashList', ref: repo })}
            />
          )}
        </>
      }
    >
      {isPending ? (
        <PanelSkeleton n={5} />
      ) : error ? (
        <PanelError what="the changed files" message={error.message} />
      ) : dirty === 0 ? (
        <PanelEmpty>The working tree is clean.</PanelEmpty>
      ) : groups.length === 0 ? (
        <PanelEmpty>No paths match “{filter.trim()}”.</PanelEmpty>
      ) : (
        groups.map((g) => (
          <div key={g.id}>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-adaptive-200 bg-adaptive-100 px-3 py-1">
              <span className="text-[10px] font-semibold tracking-[0.05em] text-adaptive-500 uppercase">
                {g.label}
              </span>
              <span className="font-mono text-[10px] text-adaptive-400">{g.files.length}</span>
            </div>
            {g.files.map((f) => {
              const key = `${g.id}:${f.path}`
              return (
                <div key={key}>
                  <FileRow
                    file={f}
                    group={g.id}
                    expanded={open === key}
                    onToggle={() => setOpen(open === key ? null : key)}
                    onReveal={
                      repoPath
                        ? () => void revealItemInDir(`${repoPath}/${f.path}`).catch(() => {})
                        : undefined
                    }
                  />
                  {open === key && (
                    <DiffView repo={repo} path={f.path} staged={g.id === 'staged'} />
                  )}
                </div>
              )
            })}
          </div>
        ))
      )}
    </TabPanel>
  )
}

function FileRow({
  file,
  group,
  expanded,
  onToggle,
  onReveal,
}: {
  file: ChangedFile
  group: ChangeGroup['id']
  expanded: boolean
  onToggle: () => void
  onReveal?: () => void
}) {
  const tone: Tone =
    group === 'conflicts' ? 'err' : group === 'untracked' ? 'info' : group === 'staged' ? 'ok' : 'warn'

  // An untracked file has nothing to diff against — git would print nothing, so
  // offering to expand it is a dead end.
  const canDiff = group !== 'untracked'

  return (
    <div className="wa-file-cols border-b border-adaptive-200 px-3 py-1.5 last:border-b-0 hover:bg-adaptive-100/40">
      <button
        type="button"
        onClick={canDiff ? onToggle : undefined}
        disabled={!canDiff}
        title={canDiff ? (expanded ? 'Hide the diff' : 'Show the diff') : 'Untracked — no diff'}
        className={cn(
          'flex items-center gap-0.5 font-mono text-[11px] disabled:opacity-60',
          TONE_TEXT[tone]
        )}
      >
        {canDiff && (
          <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
        )}
        {file.code.trim() || '??'}
      </button>

      <button
        type="button"
        onClick={canDiff ? onToggle : undefined}
        className="truncate text-left font-mono text-[11.5px] text-adaptive-800"
        title={file.path}
      >
        {file.path}
      </button>

      {/* Zero is rendered as an em dash: no count is not the same as no change — an
          untracked or binary file legitimately has none. */}
      <span className="wa-d-narrow flex items-center justify-end gap-1.5 font-mono text-[11px]">
        {file.added === 0 && file.deleted === 0 ? (
          <span className="text-adaptive-400">—</span>
        ) : (
          <>
            <span className="text-sev-ok">+{file.added}</span>
            <span className="text-sev-err">−{file.deleted}</span>
          </>
        )}
        {onReveal && (
          <button
            type="button"
            onClick={onReveal}
            title="Reveal in file manager"
            className="text-adaptive-400 hover:text-adaptive-900"
          >
            <FolderOpen className="size-3" />
          </button>
        )}
      </span>
    </div>
  )
}
