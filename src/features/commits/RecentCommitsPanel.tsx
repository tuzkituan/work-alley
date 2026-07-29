import { PanelShell } from '@/components/wa/primitives'
import { Skeleton } from '@/components/ui/skeleton'
import { useScanStore } from '@/stores/scan-store'
import type { Category } from '@/domain/types'

export function RecentCommitsPanel({
  repoCount,
  scope,
}: {
  repoCount: number
  scope: Category | null
}) {
  const all = useScanStore((s) => s.commits)
  const scanning = useScanStore((s) => s.scanning)
  // Commits come from the scanned folder only.
  const commits = scope ? all.filter((c) => c.ref.category === scope) : []

  return (
    <PanelShell
      title="Recent commits"
      right={
        <span className="wa-num text-[11px] text-adaptive-400">
          {scope ? `across ${repoCount} repos in ${scope}/` : 'no folder open'}
        </span>
      }
      className="max-h-[320px]"
    >
      {commits.length === 0 ? (
        scope && scanning === scope ? (
          <div className="flex flex-col gap-2 p-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : (
          <div className="p-3 text-xs text-adaptive-500">
            {scope ? 'No commits found.' : 'Open a folder to see its commits.'}
          </div>
        )
      ) : (
        commits.map((c) => (
          <div
            key={`${c.ref.category}/${c.ref.name}/${c.sha}`}
            className="flex items-center gap-2.5 border-b border-adaptive-200 px-3 py-2 last:border-b-0"
          >
            <span className="w-[52px] flex-none font-mono text-[11px] text-primary-600">
              {c.sha}
            </span>
            {/* With 63 repos the category is the only disambiguator, so it stays. */}
            <span className="w-5 flex-none font-mono text-[11px] text-adaptive-400">
              {c.ref.category}
            </span>
            <span className="flex-1 truncate text-xs text-adaptive-800" title={c.subject}>
              {c.subject}
            </span>
            <span className="wa-num flex-none text-[11px] text-adaptive-400">{c.relative}</span>
          </div>
        ))
      )}
    </PanelShell>
  )
}
