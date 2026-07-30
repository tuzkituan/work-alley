import { memo } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink, Folder, FolderOpen, Layers, ListChecks, Play, Square, Wrench } from 'lucide-react'
import { KvRow, SectionLabel, StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import { repoId, type Bootstrap, type Category, type DevServer } from '@/domain/types'
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
    <div
      // A skin handle. Without one, the only way to restyle this surface was the
      // `bg-adaptive-100` utility below — which is also the row-hover and
      // table-header grey, so the two could not be changed independently.
      data-slot="rail"
      className="flex h-full flex-col gap-4 border-r border-adaptive-200 bg-adaptive-100 px-2.5 py-3"
    >
      <div className="wa-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-1.5 pb-1">
            <SectionLabel>Folders</SectionLabel>
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {boot?.repos.length ?? 0}
            </span>
          </div>

          {/* Above the folders, because it is the answer to a question none of them
              can answer on its own: "what is running / dirty / behind, anywhere?"
              Reaching that used to mean opening each folder in turn and remembering
              what you saw. Scans the whole workspace, on the same scan-once-then-
              cache terms as a folder. */}
          {groups.length > 1 && (
            <AllReposButton count={boot?.repos.length ?? 0} />
          )}

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

        <RunningSection />
      </div>

      {/* Pinned under the scroll, directly above the card that reports the same
          machine these two pages manage. Outside the scroll container on purpose:
          they are how you fix a missing tool, so they must not be scrolled away. */}
      <div className="flex flex-none flex-col gap-1">
        <MachineButton
          page="toolbox"
          icon={<Wrench className="size-3 flex-none" />}
          label="Toolbox"
          title="Install, upgrade or remove your dev tools"
        />
        <MachineButton
          page="setup"
          icon={<ListChecks className="size-3 flex-none" />}
          label="Guided setup"
          title="The ordered path for a machine with nothing on it"
        />
      </div>

      <ToolchainCard boot={boot} />
    </div>
  )
}

/**
 * A link to one of the machine-scoped pages.
 *
 * No active state, unlike FolderButton: both pages replace the whole window and
 * the rail is not on screen beside them, so it could never render as selected.
 * Getting back out is the job of those pages' own back button.
 *
 * Styled to match the Scripts buttons above rather than as a Button, so the rail
 * reads as one column of the same control repeated.
 */
function MachineButton({
  page,
  icon,
  label,
  title,
}: {
  page: 'toolbox' | 'setup'
  icon: React.ReactNode
  label: string
  title: string
}) {
  const setPage = useUiStore((s) => s.setPage)

  return (
    <button
      type="button"
      onClick={() => setPage(page)}
      title={title}
      className="flex h-[30px] items-center gap-2 rounded-md border border-transparent px-2 text-left text-xs font-medium text-adaptive-800 hover:bg-adaptive-200"
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
    </button>
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
      // Correct markup regardless of the skin, and the only way CSS can tell the
      // selected folder from the rest — selection is expressed here in border and
      // background utilities, which a skin has no way to read.
      aria-current={selected ? 'true' : undefined}
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

/**
 * What is running, anywhere in the workspace.
 *
 * The rail is the right home for this: it is the column that answers "which repos
 * am I looking at", and the app shows one folder at a time — so "is anything still
 * running?" otherwise meant opening each folder in turn and remembering what you
 * saw. The backend has always known the whole answer, since its dev registry is
 * process-wide; the frontend was discarding every server whose repo sat in an
 * unscanned folder. See `ScanState.devServers`.
 *
 * Renders nothing when nothing is running, rather than an empty-state row: this
 * sits below two sections that are always present, and a permanent "nothing is
 * running" line is furniture.
 */
function RunningSection() {
  const servers = useScanStore((s) => s.devServers)
  if (servers.length === 0) return null

  // Crashed first, then starting, then up. The list is read to find a problem, and
  // a dead server is the thing you came looking for.
  const sorted = [...servers].sort((a, b) => runRank(a) - runRank(b))

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1.5 pb-1">
        <SectionLabel>Running</SectionLabel>
        <span className="wa-num font-mono text-[11px] text-adaptive-400">{sorted.length}</span>
      </div>
      {sorted.map((s) => (
        <RunningRow key={`${repoId(s.ref)}#${s.task}`} server={s} />
      ))}
    </div>
  )
}

function RunningRow({ server }: { server: DevServer }) {
  const setCategory = useUiStore((s) => s.setCategory)
  const openDetail = useUiStore((s) => s.openDetail)
  const run = useRunAction()
  const id = repoId(server.ref)
  const crashed = server.state === 'crashed'
  // Rust fills `url` in whenever it knows a port; the fallback covers a server
  // whose port was sniffed from the output after the entry was first registered.
  // Never for a crashed one — there is nothing listening to open.
  const url = crashed
    ? null
    : (server.url ?? (server.port ? `http://localhost:${server.port}` : null))

  return (
    // A row, not a button, because it holds two targets: the name opens the repo and
    // the square stops the task. Nesting a button inside a button is invalid.
    <div className="group flex h-[30px] items-center gap-2 rounded-md border border-transparent px-2 hover:bg-adaptive-200">
      <StatusDot
        tone={crashed ? 'err' : server.state === 'up' ? 'ok' : 'warn'}
        size={7}
        style={
          server.state === 'starting' || server.state === 'stopping'
            ? { animation: 'wa-blink 1.4s step-end infinite' }
            : undefined
        }
      />
      <button
        type="button"
        // Both, and in this order: the folder has to be open for the repo to be
        // addressable, and `setCategory` clears the detail page — so opening it
        // second is what makes the jump land.
        onClick={() => {
          setCategory(server.ref.category)
          openDetail(id)
        }}
        title={`${server.command.join(' ')}\n\nClick to open ${id}`}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="w-full truncate text-xs font-medium text-adaptive-800">
          {server.ref.name}
        </span>
        {/* The folder and task, because two repos in different folders can share a
            name and this list spans all of them. */}
        <span className="w-full truncate font-mono text-[9.5px] text-adaptive-400">
          {server.ref.category || 'workspace'} · {server.task}
        </span>
      </button>
      {/* The port at rest, the actions on hover — the rail is 214px wide and the
          name already has most of it, so both cannot be shown at once. */}
      <span
        className={cn(
          'wa-num flex-none font-mono text-[10px] group-hover:hidden',
          crashed ? 'text-sev-err' : 'text-adaptive-400'
        )}
      >
        {crashed ? 'dead' : server.port ? `:${server.port}` : server.state}
      </span>
      <span className="hidden flex-none items-center gap-1.5 group-hover:flex">
        {/* Only once the port is actually known. Before that `url` is null and the
            button would open http://localhost:undefined — the port is a guess until
            the server prints its banner, which is why Rust leaves it unset. */}
        {url && (
          <button
            type="button"
            onClick={() => void openUrl(url).catch(() => {})}
            title={`Open ${url}`}
            aria-label={`Open ${url}`}
            className="text-adaptive-400 hover:text-primary"
          >
            <ExternalLink className="size-3" />
          </button>
        )}
        <button
          type="button"
          onClick={() => run({ kind: 'devStop', ref: server.ref, task: server.task })}
          title={`Stop ${server.task} in ${id}`}
          aria-label={`Stop ${server.task} in ${id}`}
          className="text-adaptive-400 hover:text-sev-err"
        >
          <Square className="size-3" />
        </button>
      </span>
    </div>
  )
}

/** Crashed, then starting/stopping, then up. */
function runRank(s: DevServer): number {
  if (s.state === 'crashed') return 0
  if (s.state === 'starting' || s.state === 'stopping') return 1
  return 2
}

/**
 * Every repo in the workspace, in one flat list.
 *
 * A sibling of the folder buttons rather than a switch somewhere else, because it
 * answers the same question they do — "which repos am I looking at" — and the two
 * are mutually exclusive. Same shape, same selected treatment, so which one is
 * active reads at a glance.
 *
 * Hidden when there is only one folder: it would then be a second button for the
 * same set of repos.
 */
function AllReposButton({ count }: { count: number }) {
  const selected = useUiStore((s) => s.allRepos)
  const setAllRepos = useUiStore((s) => s.setAllRepos)
  const scanning = useScanStore((s) => s.scanning !== null)

  return (
    <button
      type="button"
      onClick={() => setAllRepos(!selected)}
      aria-current={selected ? 'true' : undefined}
      title={
        selected
          ? 'Back to one folder at a time'
          : `Show all ${count} repos at once, across every folder`
      }
      className={cn(
        'flex h-[30px] w-full items-center gap-2 rounded-md border px-2 text-left',
        selected
          ? 'border-adaptive-300 bg-background'
          : 'border-transparent hover:bg-adaptive-200'
      )}
    >
      <Layers
        className={cn('size-3.5 flex-none', selected ? 'text-primary' : 'text-adaptive-400')}
      />
      <span
        className={cn(
          'flex-1 truncate text-xs font-medium',
          selected ? 'text-adaptive-950' : 'text-adaptive-800'
        )}
      >
        All repos
      </span>
      {selected && scanning ? (
        <span
          className="size-2.5 flex-none rounded-full border border-primary border-t-transparent"
          style={{ animation: 'wa-spin 0.7s linear infinite' }}
        />
      ) : (
        <span className="wa-num flex-none font-mono text-[10px] text-adaptive-400">{count}</span>
      )}
    </button>
  )
}

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
