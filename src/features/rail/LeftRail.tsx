import { memo, useMemo } from 'react'
import { ChevronDown, ChevronRight, Play, Wrench } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { KvRow, SectionLabel, StatusDot } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import { derive, displayName, TONE_TEXT } from '@/domain/severity'
import { CATEGORIES, repoId, type Bootstrap, type Category, type RepoRef } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'

/**
 * Three zones: a scrolling middle with the folder accordion, and a pinned footer.
 * The design's "spacer, then info card" only works with 4 rows — 63 would push the
 * card off the bottom.
 *
 * Exactly one folder is open at a time, and only the open folder is scanned.
 */
export function LeftRail({ boot }: { boot: Bootstrap | undefined }) {
  const scripts = boot?.scripts ?? []
  const run = useRunAction()

  const byCategory = new Map<Category, RepoRef[]>()
  for (const c of CATEGORIES) byCategory.set(c, [])
  for (const r of boot?.repos ?? []) byCategory.get(r.category)?.push(r)

  return (
    <div className="flex h-full flex-col gap-4 border-r border-adaptive-200 bg-adaptive-100 px-2.5 py-3">
      <div className="wa-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-1.5 pb-1">
            <SectionLabel>Repositories</SectionLabel>
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {boot?.repos.length ?? 0}
            </span>
          </div>

          {CATEGORIES.map((c) => (
            <RepoGroup
              key={c}
              category={c}
              repos={byCategory.get(c) ?? []}
              declared={boot?.categories.find((x) => x.category === c)?.declaredCount ?? 0}
            />
          ))}
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
              className="flex items-center gap-2 rounded-md border border-transparent px-2 py-[7px] text-left hover:bg-adaptive-200"
              title={s.description}
            >
              <Play className="size-2.5 flex-none text-adaptive-400" />
              <span className="flex-1 truncate text-xs font-medium text-adaptive-800">
                {s.title}
              </span>
              <span className="flex-none font-mono text-[10px] text-adaptive-400">{s.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <ToolboxButton />
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

const RepoGroup = memo(function RepoGroup({
  category,
  repos,
  declared,
}: {
  category: Category
  repos: RepoRef[]
  declared: number
}) {
  const expanded = useUiStore((s) => s.expandedCategory === category)
  const toggleCategory = useUiStore((s) => s.toggleCategory)
  const scanning = useScanStore((s) => s.scanning === category)
  const scanned = useScanStore((s) => s.scanned.has(category))

  // hostapp-marketplace and subapp-sa-marketplace both strip to "marketplace".
  // Where that happens, the rail shows the full name rather than two identical rows.
  const ambiguousShorts = useMemo(() => {
    const seen = new Map<string, number>()
    for (const r of repos) {
      const k = displayName(r.name).short
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k))
  }, [repos])

  return (
    <Collapsible open={expanded} onOpenChange={() => toggleCategory(category)}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1',
          expanded ? 'bg-background' : 'hover:bg-adaptive-200'
        )}
      >
        {expanded ? (
          <ChevronDown className="size-3 text-adaptive-400" />
        ) : (
          <ChevronRight className="size-3 text-adaptive-400" />
        )}
        <span
          className={cn(
            'font-mono text-[11px] font-semibold',
            expanded ? 'text-primary-600' : 'text-adaptive-700'
          )}
        >
          {category}
        </span>
        <div className="flex-1" />
        {scanning ? (
          <span
            className="size-2.5 rounded-full border border-primary-600 border-t-transparent"
            style={{ animation: 'wa-spin 0.7s linear infinite' }}
          />
        ) : (
          <span className="wa-num font-mono text-[10px] text-adaptive-400">
            {repos.length === 0 && declared > 0 ? `0 / ${declared}` : repos.length}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        {/* be/ is declared in repos.json but empty on disk — a state the 4-repo
            design never had to represent. */}
        {repos.length === 0 ? (
          <div className="px-2 py-1.5 text-[11px] text-adaptive-400">
            {declared > 0 ? `none of ${declared} cloned` : 'empty'}
          </div>
        ) : (
          repos.map((r) => (
            <RailRow
              key={repoId(r)}
              repo={r}
              scanned={scanned}
              ambiguous={ambiguousShorts.has(displayName(r.name).short)}
            />
          ))
        )}
      </CollapsibleContent>
    </Collapsible>
  )
})

const RailRow = memo(function RailRow({
  repo,
  scanned,
  ambiguous,
}: {
  repo: RepoRef
  scanned: boolean
  ambiguous: boolean
}) {
  const id = repoId(repo)
  // Only the open folder is scanned, so an unscanned row shows a neutral dot and
  // a "·" flag rather than implying it is clean.
  const status = useScanStore((s) => s.repos.get(id))
  const uiLatest = useScanStore((s) => s.uiLatest)
  const active = useUiStore((s) => s.activeRepoId === id)
  const setActiveRepo = useUiStore((s) => s.setActiveRepo)

  const d = status && scanned ? derive(status, uiLatest) : null
  const { short, prefix } = displayName(repo.name)
  const label = ambiguous ? repo.name.replace(/^blazeup-/, '') : short

  return (
    <button
          type="button"
          title={`${prefix ? prefix + '-' : ''}${short}${status?.branch ? ' · ' + status.branch : ''}`}
          onClick={() => setActiveRepo(id)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md border px-2 py-[7px] text-left',
            active ? 'border-adaptive-300 bg-background' : 'border-transparent hover:bg-adaptive-200'
          )}
        >
          {d ? (
            <StatusDot tone={d.tone} />
          ) : (
            <span className="size-[7px] flex-none rounded-full bg-adaptive-300" />
          )}
          <span className="flex-1 truncate text-xs text-adaptive-800">{label}</span>
          <span
            className={cn(
              'wa-num flex-none font-mono text-[11px]',
              d ? TONE_TEXT[d.tone] : 'text-adaptive-400'
            )}
          >
            {d ? d.railFlag : '·'}
          </span>
    </button>
  )
})

/** The toolchain card doubles as the way in — clicking it opens the Toolbox. */
function ToolboxButton() {
  const page = useUiStore((s) => s.page)
  const setPage = useUiStore((s) => s.setPage)
  return (
    <button
      type="button"
      onClick={() => setPage(page === 'toolbox' ? 'repos' : 'toolbox')}
      className={cn(
        'flex flex-none items-center gap-2 rounded-md border px-2 py-[7px] text-left',
        page === 'toolbox'
          ? 'border-primary-600 bg-background text-primary-600'
          : 'border-adaptive-200 hover:bg-adaptive-200'
      )}
    >
      <Wrench className="size-3 flex-none text-adaptive-400" />
      <span className="flex-1 text-xs font-medium">Toolbox</span>
      <span className="font-mono text-[10px] text-adaptive-400">env</span>
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
  const runtime = docker?.path ? docker : podman

  return (
    <div className="flex flex-none flex-col gap-[7px] rounded-lg border border-adaptive-200 bg-background p-2.5">
      <SectionLabel>
        {/* The design says "Node · pnpm"; this workspace uses bun, and podman
            rather than docker. */}
        node · {bun?.path ? 'bun' : 'npm'}
      </SectionLabel>
      <KvRow label="node" value={node?.version ?? '—'} />
      <KvRow label={bun?.path ? 'bun' : 'npm'} value={(bun ?? find('npm'))?.version ?? '—'} />
      <KvRow
        label={runtime?.name ?? 'docker'}
        value={runtime?.path ? (runtime.version ?? 'present') : 'not found'}
        tone={runtime?.path ? 'ok' : 'idle'}
      />
    </div>
  )
}
