import { Button } from '@/components/ui/button'
import { useRunAction } from '@/hooks/use-action'
import { useContainerRuntime, useHeadlessScripts } from '@/hooks/use-bootstrap'
import { repoId, type RepoRef } from '@/domain/types'
import { cn } from '@/lib/utils'
import { useScanStore } from '@/stores/scan-store'

/**
 * The things you launch from here rather than from a repo row.
 *
 * Scope-sensitive, because the pane's whole job is to be about one thing at a time:
 * with a repo selected the strip is *that repo's* commands — its package scripts,
 * its `flutter pub get`, its `cargo clippy` — and `gh pr list` across 113 repos is
 * not what you want one click from a log of `web`. The workspace scope keeps the
 * workspace-wide chips it always had.
 *
 * Wraps rather than scrolls, so a repo with fourteen scripts shows all fourteen —
 * a chip you cannot see is a chip you will not use. The strip is capped in height
 * and scrolls vertically past that, so the log it sits under keeps most of the pane.
 */
export function QuickActions({ scopeRef }: { scopeRef: RepoRef | null }) {
  const run = useRunAction()
  const scripts = useHeadlessScripts()
  const runtime = useContainerRuntime()
  const status = useScanStore((s) => (scopeRef ? s.repos.get(repoId(scopeRef)) : undefined))

  return (
    <div
      // ~4 rows of chips before it scrolls, which is where it stops being a strip
      // and starts being a panel.
      className="wa-scroll-hidden flex max-h-[7.5rem] flex-none flex-wrap items-center gap-1.5 overflow-y-auto border-t border-adaptive-200 px-2.5 py-2.5"
    >
      {!scopeRef && (
        <>
          <Button
            variant="waDashed"
            size="waChip"
            className="flex-none"
            onClick={() => run({ kind: 'prList' })}
          >
            gh pr list
          </Button>
          {runtime && (
            <Button
              variant="waDashed"
              size="waChip"
              className="flex-none"
              onClick={() => run({ kind: 'dockerPs' })}
            >
              {runtime} ps
            </Button>
          )}
        </>
      )}

      {/* Scoped to the pane, not hardcoded to the workspace. It used to send
          `ref: null` from a repo-scoped pane, so the run it started was filtered
          straight back out of the strip you launched it from. */}
      <Button
        variant="waDashed"
        size="waChip"
        className="flex-none"
        title={scopeRef ? `Fetch ${scopeRef.name}` : 'Fetch every repo in the workspace'}
        onClick={() => run({ kind: 'fetchAll', ref: scopeRef })}
      >
        {scopeRef ? 'fetch' : 'fetch --all'}
      </Button>

      {/* Nothing else here runs until this does, so it leads. */}
      {scopeRef && status?.needsInstall && (
        <Button
          variant="waDashed"
          size="waChip"
          className="flex-none text-sev-warn"
          title={`Install ${scopeRef.name}'s dependencies`}
          onClick={() => run({ kind: 'runChore', ref: scopeRef, chore: 'packages.install' })}
        >
          install
        </Button>
      )}

      {scopeRef &&
        status?.availableScripts.map((s) => (
          <Button
            key={`script:${s}`}
            variant="waDashed"
            size="waChip"
            className="flex-none font-mono"
            title={`Run the "${s}" script in ${scopeRef.name}`}
            // The manager is stamped on by `useRunAction`, so every surface that
            // runs a script agrees without repeating it here.
            onClick={() => run({ kind: 'runScript', ref: scopeRef, script: s })}
          >
            {s}
          </Button>
        ))}

      {scopeRef &&
        status?.chores.map((c) => (
          <Button
            key={`chore:${c.id}`}
            variant="waDashed"
            size="waChip"
            className={cn('flex-none font-mono', c.destructive && 'text-sev-warn')}
            title={
              c.destructive
                ? `${c.label} — deletes build output or rewrites files, so it asks first`
                : c.label
            }
            onClick={() => run({ kind: 'runChore', ref: scopeRef, chore: c.id })}
          >
            {/* The full label, unlike the detail bar's grouped rows: there is no
                group heading beside the chip to say which tool this belongs to,
                and `clean` alone could be gradle's or flutter's. */}
            {c.label}
          </Button>
        ))}

      {/* Workspace-level scripts from scripts/ — meaningless inside one repo. */}
      {!scopeRef &&
        scripts.map((s) => (
          <Button
            key={s.id}
            variant="waDashed"
            size="waChip"
            className="flex-none"
            title={s.description}
            onClick={() => run({ kind: 'script', script: s.id, args: [] })}
          >
            {s.id}
          </Button>
        ))}

      {/* A scoped repo that declares nothing: say so, rather than leaving a strip
          with one lonely `fetch` in it looking broken. */}
      {scopeRef &&
        !status?.needsInstall &&
        !status?.availableScripts.length &&
        !status?.chores.length && (
          <span className="flex-none text-[10.5px] text-adaptive-400">
            {scopeRef.name} declares no scripts.
          </span>
        )}
    </div>
  )
}
