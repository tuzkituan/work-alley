import { Button } from '@/components/ui/button'
import { useRunAction } from '@/hooks/use-action'
import { useContainerRuntime, useHeadlessScripts } from '@/hooks/use-bootstrap'
import type { RepoRef } from '@/domain/types'

/**
 * The things you launch from here rather than from a repo row.
 *
 * The script chips come from whatever this workspace has in scripts/ — there is no
 * built-in script to hardcode.
 */
export function QuickActions({ scopeRef }: { scopeRef: RepoRef | null }) {
  const run = useRunAction()
  const scripts = useHeadlessScripts()
  const runtime = useContainerRuntime()

  return (
    <div className="flex flex-none flex-wrap gap-1.5 border-t border-adaptive-200 px-2.5 py-2.5">
      <Button variant="waDashed" size="waChip" onClick={() => run({ kind: 'prList' })}>
        gh pr list
      </Button>
      {runtime && (
        <Button variant="waDashed" size="waChip" onClick={() => run({ kind: 'dockerPs' })}>
          {runtime} ps
        </Button>
      )}
      {/* Scoped to the pane, not hardcoded to the workspace. It used to send
          `ref: null` from a repo-scoped pane, so the run it started was filtered
          straight back out of the strip you launched it from. */}
      <Button
        variant="waDashed"
        size="waChip"
        title={scopeRef ? `Fetch ${scopeRef.name}` : 'Fetch every repo in the workspace'}
        onClick={() => run({ kind: 'fetchAll', ref: scopeRef })}
      >
        {scopeRef ? 'fetch' : 'fetch --all'}
      </Button>
      {scripts.map((s) => (
        <Button
          key={s.id}
          variant="waDashed"
          size="waChip"
          title={s.description}
          onClick={() => run({ kind: 'script', script: s.id, args: [] })}
        >
          {s.id}
        </Button>
      ))}
    </div>
  )
}
