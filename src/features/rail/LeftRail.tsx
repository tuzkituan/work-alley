import { memo } from 'react'
import { Folder, FolderOpen, Play } from 'lucide-react'
import { KvRow, SectionLabel } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import type { Bootstrap, Category } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'

/**
 * Three zones: a header, a scrolling middle, and a pinned footer.
 *
 * The rail lists *folders*, not repos. It used to expand into every repo it
 * contained, which duplicated the main page in a 214px column — the same names
 * truncated twice, and hundreds of rows to scroll past to reach the scripts
 * below. Repos are the main page's job; the rail's job is choosing which set of
 * them you are looking at.
 *
 * Exactly one folder is selected at a time, and only that folder is scanned.
 */
export function LeftRail({ boot }: { boot: Bootstrap | undefined }) {
  const scripts = boot?.scripts ?? []
  const run = useRunAction()

  // Groups come from the backend's discovery, in its order (biggest first).
  const groups = boot?.categories ?? []

  return (
    <div className="flex h-full flex-col gap-4 border-r border-adaptive-200 bg-adaptive-100 px-2.5 py-3">
      <div className="wa-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-1.5 pb-1">
            <SectionLabel>Folders</SectionLabel>
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {boot?.repos.length ?? 0}
            </span>
          </div>

          {groups.map((g) => (
            <FolderButton
              key={g.category}
              category={g.category}
              label={g.label}
              count={g.repoCount}
              declared={g.declaredCount}
            />
          ))}
          {groups.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-adaptive-400">
              No repos found in this folder.
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <div className="px-1.5 pb-1">
            <SectionLabel>Scripts</SectionLabel>
          </div>
          {scripts.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() =>
                run(
                  s.mode === 'headless'
                    ? { kind: 'script', script: s.id, args: defaultArgs(s.argSchema) }
                    : { kind: 'openInTerminal', script: s.id, ref: null }
                )
              }
              className="flex h-[30px] items-center gap-2 rounded-md border border-transparent px-2 text-left hover:bg-adaptive-200"
              title={s.description}
            >
              <Play className="size-2.5 flex-none text-adaptive-400" />
              <span className="flex-1 truncate text-xs font-medium text-adaptive-800">
                {s.title}
              </span>
              <span className="flex-none font-mono text-[10px] text-adaptive-400">{s.hint}</span>
            </button>
          ))}
          {scripts.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-adaptive-400">
              No scripts/ directory here.
            </div>
          )}
        </div>
      </div>

      <ToolchainCard boot={boot} />
    </div>
  )
}

function defaultArgs(schema: Bootstrap['scripts'][number]['argSchema']): string[] {
  // Only leading args that have a default are pre-filled; the rest are omitted so
  // the script applies its own defaults.
  const out: string[] = []
  for (const a of schema) {
    if (a.default === null) break
    out.push(a.default)
  }
  return out
}

/**
 * One folder. Selecting it is what makes the main page show those repos and what
 * triggers the scan.
 *
 * `setCategory`, not `toggleCategory`: clicking the selected folder used to
 * deselect it and empty the main page, which reads as the button having broken.
 */
const FolderButton = memo(function FolderButton({
  category,
  label,
  count,
  declared,
}: {
  category: Category
  label: string
  count: number
  declared: number
}) {
  const selected = useUiStore((s) => s.expandedCategory === category)
  const setCategory = useUiStore((s) => s.setCategory)
  const scanning = useScanStore((s) => s.scanning === category)

  // Naming the directory matters: "0 / 32" on its own reads like a detection
  // failure rather than a folder nothing has been cloned into yet.
  const empty = count === 0 && declared > 0

  return (
    <button
      type="button"
      onClick={() => setCategory(category)}
      title={
        empty
          ? `none of ${declared} repos cloned into ${category}/`
          : `${count} repo${count === 1 ? '' : 's'} in ${category || 'this folder'}`
      }
      className={cn(
        'flex h-[30px] w-full items-center gap-2 rounded-md border px-2 text-left',
        selected
          ? 'border-adaptive-300 bg-background'
          : 'border-transparent hover:bg-adaptive-200'
      )}
    >
      {selected ? (
        <FolderOpen className="size-3.5 flex-none text-primary" />
      ) : (
        <Folder className="size-3.5 flex-none text-adaptive-400" />
      )}
      <span
        className={cn(
          'flex-1 truncate text-xs font-medium',
          selected ? 'text-adaptive-950' : 'text-adaptive-800'
        )}
      >
        {label}
      </span>
      {scanning ? (
        <span
          className="size-2.5 flex-none rounded-full border border-primary border-t-transparent"
          style={{ animation: 'wa-spin 0.7s linear infinite' }}
        />
      ) : (
        <span
          className={cn(
            'wa-num flex-none font-mono text-[10px]',
            empty ? 'text-sev-warn' : 'text-adaptive-400'
          )}
        >
          {empty ? `0 / ${declared}` : count}
        </span>
      )}
    </button>
  )
})

function ToolchainCard({ boot }: { boot: Bootstrap | undefined }) {
  const tools = boot?.tools ?? []
  const find = (n: string) => tools.find((t) => t.name === n)
  const node = find('node')
  const bun = find('bun')
  const docker = find('docker')
  const podman = find('podman')
  // Whichever container runtime this machine has; neither is the special case.
  const runtime = docker?.path ? docker : podman
  // The package manager label follows what is actually installed.
  const pm = bun?.path ? bun : find('npm')

  return (
    <div className="flex flex-none flex-col gap-[7px] rounded-lg border border-adaptive-200 bg-background p-2.5">
      <SectionLabel>node · {pm?.name ?? 'npm'}</SectionLabel>
      <KvRow label="node" value={node?.version ?? '—'} />
      <KvRow label={pm?.name ?? 'npm'} value={pm?.version ?? '—'} />
      <KvRow
        label={runtime?.name ?? 'docker'}
        value={runtime?.path ? (runtime.version ?? 'present') : 'not found'}
        tone={runtime?.path ? 'ok' : 'idle'}
      />
    </div>
  )
}
