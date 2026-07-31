import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel, StatusDot } from '@/components/wa/primitives'
import { api } from '@/ipc/commands'
import { useRunStore } from '@/stores/run-store'
import { useScanStore } from '@/stores/scan-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunAction } from '@/hooks/use-action'
import { TerminalView } from '@/features/terminal/TerminalView'
import { useTermPalette } from '@/features/terminal/use-term-palette'
import { usePaneTheme } from '@/hooks/use-theme'
import { cn } from '@/lib/utils'
import { runStatusLabel } from '@/domain/run-status'
import type { RepoId, RepoRef } from '@/domain/types'
import { estimateGeometry } from './term-geometry'
import { activityLabel, computeActivity, scopesToOffer } from './activity'
import { buildTabs, type OutputView } from './output-view'
import { isBulkKind } from './bulk-log'
import { requestCancel } from './cancel-run'
import { useCancelKey } from './use-cancel-key'
import { BulkProgress } from './BulkProgress'
import { EmptyLog, LogView } from './LogView'
import { QuickActions } from './QuickActions'
import { ScopeTabs, type ScopeOption } from './ScopeTabs'
import { TabStrip } from './TabStrip'

/**
 * Runs and terminals for one scope.
 *
 * A shell now: the tab model lives in `output-view.ts`, "what is running" in
 * `activity.ts`, per-repo bulk progress in `bulk-log.ts`, and each region in its own
 * component. The file previously held all of it at ~570 lines, with three separate
 * selector surfaces and two selection variables that could disagree about what was
 * showing.
 */
export function OutputPane() {
  const runs = useRunStore((s) => s.runs)
  const runOrder = useRunStore((s) => s.order)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const setActiveRun = useRunStore((s) => s.setActive)
  const clear = useRunStore((s) => s.clear)
  const dismiss = useRunStore((s) => s.dismiss)
  const run = useRunAction()

  const tabs = useTerminalStore((s) => s.tabs)
  const termOrder = useTerminalStore((s) => s.order)
  const activeTermId = useTerminalStore((s) => s.activeTermId)
  const setActiveTerm = useTerminalStore((s) => s.setActive)
  const closeTerm = useTerminalStore((s) => s.close)
  // Still read here for the +/- controls and the pty geometry estimate; only the
  // *applying* of it moved out.
  const termFontSize = useUiStore((s) => s.termFontSize)
  const scanRepos = useScanStore((s) => s.repos)
  const bodyRef = useRef<HTMLDivElement>(null)

  const { className: paneClass } = usePaneTheme()
  useTermPalette(bodyRef)
  // Terminal typography is pushed by `features/terminal/font-sync`, at module
  // scope. It lived here as an effect, which meant it only ran on pages where this
  // pane is mounted — not the Toolbox, setup or settings pages.

  // The pane is scoped: the selected repo's own runs and terminals, or the workspace
  // scope for anything that belongs to no single repo.
  // In the store, not local state: it has to survive this pane unmounting when a
  // full-window page opens. Nothing moves it on its own — see the note in the
  // bridge's `run:started`.
  const scope = useUiStore((s) => s.outputScope)
  const setScope = useUiStore((s) => s.setOutputScope)
  const setActiveRepo = useUiStore((s) => s.setActiveRepo)
  const openScopes = useUiStore((s) => s.openScopes)
  const rememberScopes = useUiStore((s) => s.rememberScopes)
  const closeScope = useUiStore((s) => s.closeScope)

  // Computed, not selected: a selector returning a fresh object on every call breaks
  // useSyncExternalStore's snapshot caching.
  const { runTabs, termTabs, shown } = useMemo(
    () => buildTabs({ runs, runOrder, tabs, termOrder, scope, activeRunId, activeTermId }),
    [runs, runOrder, tabs, termOrder, scope, activeRunId, activeTermId]
  )

  const activity = useMemo(
    () => computeActivity(runs.values(), tabs.values(), scope),
    [runs, tabs, scope]
  )
  const allActivity = useMemo(
    () => computeActivity(runs.values(), tabs.values()),
    [runs, tabs]
  )

  // A scope that has anything in it gets a tab, and keeps it: `rememberScopes` is
  // additive, and only the tab's own × takes one away. Joined into a string so the
  // effect does not re-run on every fresh array `computeActivity` returns.
  const activeScopeKey = allActivity.scopes.filter((s): s is RepoId => s !== null).join('\u0000')
  useEffect(() => {
    if (activeScopeKey) rememberScopes(activeScopeKey.split('\u0000') as RepoId[])
  }, [activeScopeKey, rememberScopes])

  const shownRun = shown?.kind === 'run' ? runs.get(shown.id) : undefined
  const shownTerm = shown?.kind === 'term' ? tabs.get(shown.id) : undefined

  // Only for the run on screen, and never while a shell is showing — there, Ctrl+C
  // belongs to the shell.
  useCancelKey(shownTerm ? undefined : shownRun)

  const scopeLabel = scope ? (scanRepos.get(scope)?.ref.name ?? scope) : 'workspace'

  // Looked up rather than parsed out of the scope id, because a category or a repo
  // name can itself contain a slash and splitting would open the shell in the wrong
  // folder.
  const scopeRef: RepoRef | null = (scope ? scanRepos.get(scope)?.ref : null) ?? null

  // Which repo the log is filtered to, from a bulk progress row. Reset whenever the
  // shown view changes — a filter left over from another run reads as an empty log.
  const [repoFilter, setRepoFilter] = useState<string | null>(null)
  useEffect(() => {
    setRepoFilter(null)
  }, [shown?.kind, shown?.id])

  // Only scopes with something in them, plus the current one. A repo with no runs
  // and no shells has an empty pane, so offering every repo made the menu long and
  // most of it a dead end.
  const scopeOptions: ScopeOption[] = useMemo(() => {
    return scopesToOffer(allActivity, scope, openScopes).map((id) => {
      const a = computeActivity(runs.values(), tabs.values(), id)
      return {
        id,
        label: id ? (scanRepos.get(id)?.ref.name ?? id) : 'workspace',
        runs: a.runs,
        terms: a.terms,
      }
    })
  }, [allActivity, scope, openScopes, runs, tabs, scanRepos])

  const openTerminal = (external = false) => {
    // The pane's own + button: the shell is the request, so it gets shown. An
    // external one opens a window elsewhere and has no tab to select.
    if (!external) useTerminalStore.getState().requestFocus()
    return run({
      kind: 'openShell',
      ref: scopeRef,
      external,
      size: estimateGeometry(bodyRef.current, termFontSize),
    })
  }

  const select = (view: OutputView) => {
    if (view.kind === 'term') {
      setActiveTerm(view.id)
      return
    }
    // Selecting a run means "show the log", which is what activeTermId: null encodes.
    setActiveTerm(null)
    setActiveRun(view.id)
  }

  const close = (view: OutputView) => {
    if (view.kind === 'term') {
      closeTerm(view.id)
      return
    }
    dismiss(view.id)
    void api.dismissRun(view.id).catch(() => {})
  }

  const summary = activityLabel(activity)

  return (
    <div
      data-slot="output-pane"
      className={cn(
        'wa-output flex h-full flex-col border-l border-adaptive-200 bg-adaptive-50',
        // Empty unless the console has been pinned against the app's own theme, in
        // which case this is what re-declares the ramp for the whole subtree — the
        // header, the scope tabs and the log, so a dark console is not a dark box
        // under light chrome. See `usePaneTheme`.
        paneClass
      )}
    >
      {/* Scope first, then the header for the scope you picked. The dropdown this
          replaces sat inside the header and showed one name at a time. */}
      <ScopeTabs
        scope={scope}
        options={scopeOptions}
        onSelect={(id) => {
          setScope(id)
          // Keep the pane and the repo table pointing at the same thing.
          if (id) setActiveRepo(id)
        }}
        onClose={closeScope}
      />

      <div className="flex h-10 flex-none items-center gap-2 border-b border-adaptive-200 px-2.5">
        <SectionLabel>Output</SectionLabel>
        {/* What is running, across everything in this scope — not the status of the
            one run that happens to be showing, which is all this could say before and
            was always in the singular. */}
        {summary ? (
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-adaptive-600">
            <StatusDot
              tone="info"
              size={5}
              style={{ animation: 'wa-blink 1.4s step-end infinite' }}
            />
            <span className="truncate">{summary}</span>
          </span>
        ) : (
          <span className="font-mono text-[11px] text-adaptive-400">
            {shownRun ? runStatusLabel(shownRun.summary.status) : 'idle'}
          </span>
        )}

        <div className="flex-1" />

        {/* Terminal controls replace the run controls wholesale: Cancel, Dismiss and
            Clear all act on a run, and none of them means anything while a shell is
            showing. */}
        {shownTerm ? (
          <>
            <span className="wa-o-narrow flex h-[26px] items-center rounded-sm border border-adaptive-200 font-mono text-[11px] text-adaptive-500">
              <button
                type="button"
                aria-label="Smaller terminal text"
                className="h-full px-1.5 hover:text-adaptive-900"
                onClick={() => useUiStore.getState().setTermFontSize(termFontSize - 1)}
              >
                −
              </button>
              <button
                type="button"
                aria-label="Larger terminal text"
                className="h-full px-1.5 hover:text-adaptive-900"
                onClick={() => useUiStore.getState().setTermFontSize(termFontSize + 1)}
              >
                +
              </button>
            </span>
            <Button
              variant="waOutline"
              size="waXs"
              className="wa-o-narrow"
              title="Reopen this shell in the system terminal"
              onClick={() => openTerminal(true)}
            >
              Externally
            </Button>
            <Button
              variant={shownTerm.status === 'live' ? 'waDanger' : 'waOutline'}
              size="waXs"
              onClick={() => closeTerm(shownTerm.termId)}
            >
              {shownTerm.status === 'live' ? 'Kill' : 'Close'}
            </Button>
          </>
        ) : (
          <>
            {shownRun?.summary.status.kind === 'running' && (
              <Button
                variant="waDanger"
                size="waXs"
                // Disabled while the signal is in flight: clicking again sends a
                // second SIGTERM to the same tree, which does nothing but make the
                // button feel broken.
                disabled={shownRun.cancelling}
                title="Cancel this run (Ctrl+C)"
                onClick={() => requestCancel(shownRun.runId)}
              >
                {shownRun.cancelling ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    Cancelling
                  </>
                ) : (
                  'Cancel'
                )}
              </Button>
            )}
            {/* Only when there is more than one to sweep up; a single finished run has
                its own × on the chip. */}
            {runTabs.filter((t) => t.closable).length > 1 && (
              <Button
                variant="waOutline"
                size="waXs"
                className="wa-o-narrow"
                onClick={() => {
                  for (const t of runTabs.filter((x) => x.closable)) {
                    dismiss(t.view.id)
                    void api.dismissRun(t.view.id).catch(() => {})
                  }
                }}
              >
                Dismiss {runTabs.filter((t) => t.closable).length}
              </Button>
            )}
            <Button
              variant="waOutline"
              size="waXs"
              disabled={!shownRun}
              title="Empty this log. New output still arrives."
              onClick={() => shownRun && clear(shownRun.runId)}
            >
              Clear
            </Button>
          </>
        )}
      </div>

      <TabStrip
        runTabs={runTabs}
        termTabs={termTabs}
        shown={shown}
        scopeLabel={scopeLabel}
        onSelect={select}
        onClose={close}
        onNewTerminal={() => openTerminal()}
      />

      {/* Per-repo progress, above the log rather than inside it: during a 40-repo pull
          the question is "how far, and did any fail", and the answer was previously
          only findable by reading the whole interleaved log. */}
      {shownRun && isBulkKind(shownRun.summary.kind) && (
        <BulkProgress run={shownRun} onSelectRepo={setRepoFilter} selected={repoFilter} />
      )}

      {/* `bodyRef` is what `estimateGeometry` measures, so a new shell starts at
          roughly the right size instead of reprinting its prompt a frame later. */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {shownTerm ? (
          <TerminalView key={shownTerm.termId} termId={shownTerm.termId} />
        ) : shownRun ? (
          <LogView
            run={shownRun}
            repoFilter={repoFilter}
            onClearFilter={() => setRepoFilter(null)}
          />
        ) : (
          <EmptyLog scope={scopeLabel} />
        )}
      </div>

      {/* Hidden while a terminal is showing: its output goes to the log anyway, and
          60px of height is worth a lot in a pane this narrow. */}
      {!shownTerm && <QuickActions scopeRef={scopeRef} />}
    </div>
  )
}
