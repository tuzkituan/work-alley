import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Boxes, ChevronDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { MonoChip, SectionLabel, StatusDot } from '@/components/wa/primitives'
import type { DepField, DepUpdate, RepoDep, RepoId, RepoRef } from '@/domain/types'
import { useRunAction } from '@/hooks/use-action'
import { api } from '@/ipc/commands'
import { cn } from '@/lib/utils'
import { keys } from '@/queries/keys'
import { PanelEmpty, PanelError, PanelSkeleton, TabPanel } from './panel-parts'

const FIELD_LABEL: Record<DepField, string> = {
  dependencies: 'dependencies',
  devDependencies: 'dev dependencies',
  peerDependencies: 'peer dependencies',
}

// Display order, matching package.json's own convention.
const FIELD_ORDER: DepField[] = ['dependencies', 'devDependencies', 'peerDependencies']

/**
 * What this repo depends on, and what is newer.
 *
 * Two queries rather than one, the same split the Toolbox makes: the table itself
 * is a manifest read and comes back instantly, while "is there a newer version"
 * goes through the repo's package manager to a registry and can take half a minute
 * on a large repo. Splitting them means the list is usable while that runs.
 *
 * The invariant carried through from the backend: `checked === false` means nobody
 * could be asked. That is not "up to date" and must never render as it — those rows
 * keep their Upgrade button and the panel says why.
 */
export function PackagesPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const [query, setQuery] = useState('')

  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: keys.repoPackages(id),
    queryFn: () => api.listRepoPackages(repo),
    staleTime: 30_000,
  })

  const updates = useQuery({
    queryKey: keys.repoPackageUpdates(id),
    queryFn: () => api.checkRepoPackageUpdates(repo),
    // A published version does not move minute to minute, and this is the
    // expensive half.
    staleTime: 10 * 60_000,
  })

  // Waiting on the first answer, which is not the same as an answer of "could not
  // ask" — the rows are identical in the data and mean opposite things.
  const checking = updates.isFetching && !updates.data
  const checked = updates.data?.checked === true
  const outdated = useMemo(
    () => new Map((updates.data?.updates ?? []).map((u) => [u.name, u])),
    [updates.data]
  )

  const all = useMemo(() => data?.deps ?? [], [data])
  const needle = query.trim().toLowerCase()
  const visible = useMemo(
    () => (needle ? all.filter((d) => d.name.toLowerCase().includes(needle)) : all),
    [all, needle]
  )

  // Grouped by field, and within a group the rows that need attention first — the
  // same reasoning as the status dot: a 90-row table should be scannable down one
  // edge rather than read line by line.
  //
  // The sort is frozen while the check is in flight. Applying it as answers land
  // reorders 90 rows under the cursor, which is how you click Upgrade on the wrong
  // package.
  const groups = useMemo(
    () =>
      FIELD_ORDER.map((field) => ({
        field,
        deps: checking
          ? visible.filter((d) => d.field === field)
          : visible
              .filter((d) => d.field === field)
              .sort((a, b) => Number(outdated.has(b.name)) - Number(outdated.has(a.name))),
      })).filter((g) => g.deps.length > 0),
    [visible, outdated, checking]
  )

  const behind = visible.filter((d) => outdated.has(d.name)).length
  const filtering = needle.length > 0

  return (
    <TabPanel
      icon={<Boxes className="size-3.5 text-adaptive-400" />}
      title={
        error
          ? 'Packages'
          : filtering
            ? `${visible.length} of ${all.length}`
            : `${all.length} dependencies`
      }
      right={
        <>
          {data?.manager && <MonoChip>{data.manager}</MonoChip>}
          {updates.isFetching && (
            <span className="text-[11px] text-adaptive-400">checking for updates…</span>
          )}
          {!updates.isFetching && checked && behind > 0 && (
            <span className="text-[11px] text-sev-warn">{behind} behind</span>
          )}
        </>
      }
      // Both halves: the version check is the slow one, and a refresh icon that
      // sits still through it says the panel is idle when it is not.
      isFetching={isFetching || updates.isFetching}
      onRefresh={() => {
        void refetch()
        void updates.refetch()
      }}
      actions={
        <div className="relative w-[15rem] flex-none">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-adaptive-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder="Filter packages…"
            aria-label="Filter packages"
            className="h-[26px] pl-7 text-xs"
          />
        </div>
      }
    >
      {isPending ? (
        <PanelSkeleton n={8} />
      ) : error ? (
        <PanelError what="this repo's dependencies" message={error.message} />
      ) : !data?.hasManifest ? (
        <PanelEmpty>This repo has no package.json.</PanelEmpty>
      ) : all.length === 0 ? (
        <PanelEmpty>This package.json declares no dependencies.</PanelEmpty>
      ) : (
        <>
          {/* Two different kinds of "we do not know", stated separately: nothing is
              installed, and nobody could be asked what is current. */}
          {!data.installedTree && (
            <Note>
              Nothing is installed yet, so the installed column is empty until you run
              an install.
            </Note>
          )}
          {updates.data && !checked && updates.data.reason && (
            <Note tone="warn">{updates.data.reason}</Note>
          )}

          {visible.length === 0 ? (
            <PanelEmpty>No packages match.</PanelEmpty>
          ) : (
            groups.map((g) => (
              <div key={g.field}>
                <div className="flex items-center gap-2 border-b border-adaptive-200 bg-adaptive-50 px-3 py-1">
                  <SectionLabel className="text-[10px]">{FIELD_LABEL[g.field]}</SectionLabel>
                  <span className="wa-num font-mono text-[10px] text-adaptive-400">
                    {g.deps.length}
                  </span>
                </div>
                {g.deps.map((dep) => (
                  <DepRow
                    key={`${g.field}/${dep.name}`}
                    dep={dep}
                    repo={repo}
                    id={id}
                    update={outdated.get(dep.name)}
                    checked={checked}
                    pending={checking}
                  />
                ))}
              </div>
            ))
          )}
        </>
      )}
    </TabPanel>
  )
}

function Note({ children, tone = 'idle' }: { children: React.ReactNode; tone?: 'idle' | 'warn' }) {
  return (
    <div
      className={cn(
        'border-b border-adaptive-200 px-3 py-2 text-[11.5px]',
        tone === 'warn' ? 'text-sev-warn' : 'text-adaptive-500'
      )}
    >
      {children}
    </div>
  )
}

/**
 * @param update  The newer version this repo's manager reports, if any.
 * @param checked Whether it could be asked at all. Without it there is no
 *                difference between "current" and "we do not know", and rendering
 *                the second as the first quietly hides a real upgrade.
 * @param pending The check has not answered yet — the third state, and the one
 *                that used to render as a bare dash indistinguishable from a
 *                manager that could not be reached.
 */
function DepRow({
  dep,
  repo,
  id,
  update,
  checked,
  pending,
}: {
  dep: RepoDep
  repo: RepoRef
  id: RepoId
  update?: DepUpdate
  checked: boolean
  pending: boolean
}) {
  const latest = update?.latest ?? null
  const upToDate = checked && !update

  return (
    <div className="wa-dep-cols border-b border-adaptive-200 px-3 py-1.5 last:border-b-0 hover:bg-adaptive-100/40">
      <StatusDot tone={update ? 'warn' : upToDate && dep.installed ? 'ok' : 'idle'} size={6} />

      <span className="truncate font-mono text-[11.5px] text-adaptive-800" title={dep.name}>
        {dep.name}
      </span>

      <span
        className="wa-d-optional truncate text-right font-mono text-[11px] text-adaptive-500"
        title={`Declared as ${dep.range}`}
      >
        {dep.range}
      </span>

      <span className="wa-d-narrow truncate text-right font-mono text-[11px] text-adaptive-500">
        {dep.installed ?? <span className="text-adaptive-400">—</span>}
      </span>

      <span className="flex justify-end truncate text-right font-mono text-[11px]">
        {pending ? (
          // A shimmer rather than a dash: the dash is what this cell shows when the
          // manager could not be asked, and the two must not look the same.
          <Skeleton className="h-3 w-12" />
        ) : latest ? (
          <span className="text-sev-warn" title={`${latest} is published`}>
            {latest}
          </span>
        ) : upToDate ? (
          <span className="text-adaptive-400">current</span>
        ) : (
          <span className="text-adaptive-400">—</span>
        )}
      </span>

      <div className="flex justify-end">
        {dep.linked ? (
          // Not an upgrade the app can perform: the range names a location, and
          // installing over it would swap a local link for a published copy. Rust
          // refuses these too — this stops you finding that out via a dialog.
          <span title={`Declared as ${dep.range} — edit package.json to change it`}>
            <MonoChip className="text-[10px]">linked</MonoChip>
          </span>
        ) : (
          <UpgradeAction
            repo={repo}
            id={id}
            dep={dep}
            latest={latest}
            // Nothing to upgrade to, but pinning a version is still a thing people
            // do — so the menu stays and only the button goes.
            menuOnly={upToDate && !!dep.installed}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Upgrade, with a version menu beside it.
 *
 * The button installs whatever the registry considers latest, which is what almost
 * everyone wants. Versions are fetched only when the menu opens: listing them is a
 * registry round trip per package, and doing that for 80 rows on tab open would be
 * absurd.
 */
function UpgradeAction({
  repo,
  id,
  dep,
  latest,
  menuOnly,
}: {
  repo: RepoRef
  id: RepoId
  dep: RepoDep
  latest: string | null
  menuOnly: boolean
}) {
  const run = useRunAction()
  const [menuOpen, setMenuOpen] = useState(false)

  const { data: versions, isPending } = useQuery({
    queryKey: keys.depVersions(id, dep.name),
    queryFn: () => api.listDepVersions(repo, dep.name),
    enabled: menuOpen,
    staleTime: 5 * 60_000,
  })

  const variant = latest ? 'waPrimary' : 'waOutline'

  return (
    <div className="flex flex-none items-center">
      {!menuOnly && (
        <Button
          variant={variant}
          size="waXs"
          data-split="left"
          title={
            latest
              ? `Install ${dep.name}@${latest}`
              : `Install the latest published ${dep.name}`
          }
          onClick={() => run({ kind: 'upgradeDep', ref: repo, package: dep.name })}
        >
          Upgrade
        </Button>
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            size="waXs"
            title="Choose a version"
            data-split={menuOnly ? undefined : 'right'}
            className="px-1"
          >
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
          <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
            {dep.name}
          </DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() => run({ kind: 'upgradeDep', ref: repo, package: dep.name })}
          >
            Latest
            <span className="ml-auto text-[10px] text-adaptive-400">default</span>
          </DropdownMenuItem>

          {isPending && (
            <div className="px-2 py-1.5 text-[11px] text-adaptive-400">Looking up versions…</div>
          )}
          {!isPending && (versions?.length ?? 0) === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-adaptive-400">
              Could not list published versions.
            </div>
          )}
          {(versions?.length ?? 0) > 0 && <DropdownMenuSeparator />}
          {versions?.map((v) => (
            <DropdownMenuItem
              key={v.value}
              className="font-mono text-xs"
              onClick={() =>
                run({ kind: 'upgradeDep', ref: repo, package: dep.name, version: v.value })
              }
            >
              <span className="truncate">{v.label}</span>
              {v.note && (
                <span className="ml-auto flex-none text-[10px] text-sev-ok">{v.note}</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
