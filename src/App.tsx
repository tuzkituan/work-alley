import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { TopBar } from '@/features/topbar/TopBar'
import { ChromeBar } from '@/features/topbar/ChromeBar'
import { LeftRail } from '@/features/rail/LeftRail'
import { NeedsYouStrip } from '@/features/needs-you/NeedsYouStrip'
import { RepoGrid } from '@/features/repos/RepoGrid'
import { OutputPane } from '@/features/output/OutputPane'
import { ConfirmActionDialog } from '@/features/actions/ConfirmActionDialog'
import { CommandPalette } from '@/features/command/CommandPalette'
import { WorkspaceWelcome } from '@/features/workspace/WorkspacePicker'
import { Toolbox } from '@/features/toolbox/Toolbox'
import { SetupPage } from '@/features/setup/SetupPage'
import { MachinePage } from '@/features/setup/MachinePage'
import { shouldOnboard } from '@/features/setup/should-onboard'
import { useUiStore } from '@/stores/ui-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { api } from '@/ipc/commands'
import { connectBridge } from '@/ipc/bridge'
import { isTauri } from '@/ipc/guard'
import { InitWorkspace } from '@/features/workspace/InitWorkspace'
import { learnNamePrefixes } from '@/domain/severity'
import { useCategoryScan } from '@/hooks/use-category-scan'
import { IpcError } from '@/ipc/errors'
import { keys } from '@/queries/keys'
import { useApplyTheme, useTheme } from '@/hooks/use-theme'

export function App() {
  useApplyTheme()

  if (!isTauri()) return <NotInTauri />
  return <Dashboard />
}

const LAYOUT_KEY = 'work-alley:panels'

function loadLayout(): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : null
  } catch {
    return null
  }
}

function saveLayout(layout: Record<string, number>) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    // A full or blocked storage quota must not break resizing.
  }
}

/** Below this the output pane is under ~50 columns, and vim assumes 80. */
const TERMINAL_MIN_PX = 720
const TERMINAL_OPEN_PX = 760

/**
 * Widens the output pane the first time a terminal opens.
 *
 * At the design's 372px default the pane is roughly 44 columns of JetBrains Mono
 * 12 — fine for a log, cramped to the point of uselessness for htop or vim. The
 * resize is imperative, so `onLayoutChanged` reports `isUserInteraction: false`
 * and `saveLayout` correctly does not persist it: the user's own chosen width
 * survives, and dragging it back narrower sticks.
 */
function useGrowForTerminals(panelRef: React.RefObject<PanelImperativeHandle | null>) {
  useEffect(
    () =>
      useTerminalStore.subscribe((state, prev) => {
        if (state.order.length === 0 || state.order.length <= prev.order.length) return
        const panel = panelRef.current
        if (!panel) return
        if (panel.getSize().inPixels >= TERMINAL_MIN_PX) return
        panel.resize(`${TERMINAL_OPEN_PX}px`)
      }),
    [panelRef]
  )
}

function Dashboard() {
  const qc = useQueryClient()
  // Read once: re-reading on every render would fight the drag.
  const [savedLayout] = useState(loadLayout)
  const page = useUiStore((s) => s.page)
  const setPage = useUiStore((s) => s.setPage)
  const { theme } = useTheme()
  const [setupMode, setSetupMode] = useState(false)
  const outputPanelRef = useRef<PanelImperativeHandle | null>(null)
  useGrowForTerminals(outputPanelRef)
  // Toolbox and setup installs run in a terminal session; the dock below only
  // exists once one has been opened.

  // get_bootstrap paints the entire chrome — real counts, every folder, the
  // real scripts list — before a single git process has run.
  const {
    data: boot,
    error,
    isPending,
  } = useQuery({
    queryKey: keys.bootstrap,
    queryFn: () => api.getBootstrap(),
    // State is managed after an async toolchain probe, so an early call can arrive
    // before it exists. Retry that specific case.
    retry: (count, err) =>
      err instanceof IpcError && err.code === 'NOT_READY' ? count < 25 : count < 1,
    retryDelay: 200,
  })

  // Repo names are abbreviated for display by stripping whatever prefix this
  // workspace's repos happen to share. That has to be learned from the names
  // themselves before anything renders one.
  learnNamePrefixes(useMemo(() => (boot?.repos ?? []).map((r) => r.name), [boot?.repos]))

  // The selected folder is remembered across launches, so it can name a folder
  // that no longer exists — a different workspace, or a renamed directory. Clearing
  // it here stops the scan hook chasing a folder that is not there.
  const setCategory = useUiStore((s) => s.setCategory)
  const selected = useUiStore((s) => s.expandedCategory)
  useEffect(() => {
    if (!boot || selected === null) return
    if (!boot.categories.some((c) => c.category === selected)) setCategory(null)
  }, [boot, selected, setCategory])

  // Scans the open folder, once a folder is open *and* the toolchain is resolved.
  useCategoryScan(boot?.toolsReady ?? false)

  // Attach listeners as soon as the backend is up. No scan is started here: with
  // no folder selected there is nothing in view, so scanning every repo
  // would be work nobody asked for.
  useEffect(() => {
    if (!boot) return
    // No local guard: `connectBridge` is memoised on its promise, so calling it
    // twice is a no-op. A local `connected` flag used to sit here, which is what
    // made the double-registration bug look impossible — the real guard was inside
    // the bridge and it was checked after an await.
    void connectBridge(qc)
  }, [boot, qc])

  if (error && !boot) return <FatalError message={error.message} />

  // The Toolbox and the setup page describe this machine, not the open folder, so
  // they take the whole window and work with no workspace at all — which is exactly
  // when someone needs to install their tools.
  //
  // Checked before `hasWorkspace` on purpose: that is what makes Guided setup
  // reachable from the workspace picker on a machine that cannot clone yet.
  if (page === 'toolbox' || page === 'setup') {
    return (
      <TooltipProvider delayDuration={400}>
        <div className="flex h-full flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900">
          <TopBar boot={boot} />
          <MachinePage>
            {page === 'setup' ? (
              <SetupPage toolsReady={boot?.toolsReady ?? false} />
            ) : (
              <Toolbox toolsReady={boot?.toolsReady ?? false} />
            )}
          </MachinePage>
        </div>
        <ConfirmActionDialog />
        <Toaster theme={theme} position="bottom-left" />
      </TooltipProvider>
    )
  }

  // A machine that cannot do what the dashboard offers gets setup instead of a
  // dashboard whose every button fails. See `shouldOnboard` for why each term of that
  // predicate is there.
  //
  // After the explicit `page` branch above, so arriving from the banner still wins,
  // and before `hasWorkspace`, so a bare machine is not first asked to choose a folder
  // it has no git to scan.
  if (boot && shouldOnboard(boot)) {
    return (
      <TooltipProvider delayDuration={400}>
        <div className="flex h-full flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900">
          {/* ChromeBar, not TopBar: the workspace switcher and the bulk actions are
              meaningless before the machine works, and a window with no way to close
              it is the FatalError lesson. */}
          <ChromeBar />
          <MachinePage>
            <SetupPage toolsReady={boot.toolsReady} firstRun />
          </MachinePage>
        </div>
        <ConfirmActionDialog />
        <Toaster theme={theme} position="bottom-left" />
      </TooltipProvider>
    )
  }

  // No folder chosen yet, or the saved one has gone. Nothing else is meaningful
  // until this is answered, so it replaces the whole window rather than nagging.
  if (boot && !boot.hasWorkspace) {
    return (
      <TooltipProvider>
        {/* Same frame as every other screen, and a title bar: with the OS
            decorations off, a screen without one cannot be moved or closed. */}
        <div className="flex h-full flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900">
          <ChromeBar />
          <div className="min-h-0 flex-1">
            {setupMode ? (
              <InitWorkspace
                boot={boot}
                onCancel={() => setSetupMode(false)}
                onDone={(path) => {
                  setSetupMode(false)
                  // The folder only becomes a workspace once something is cloned
                  // into it, so switching is the last step, not the first.
                  void api.setWorkspace(path).then((b) => {
                    qc.setQueryData(keys.bootstrap, b)
                    // Select the first folder, so the dashboard lands mid-scan rather
                    // than on "Pick a folder". Cloning into a workspace and then being
                    // asked to pick something inside it was one hop too many, and
                    // nothing said that clicking a rail folder is what starts a scan.
                    const first = b.categories.find((c) => c.repoCount > 0)
                    if (first) useUiStore.getState().setCategory(first.category)
                  })
                }}
              />
            ) : (
              <WorkspaceWelcome boot={boot} onSetUp={() => setSetupMode(true)} />
            )}
          </div>
        </div>
        {/* The clone goes through the same confirmation gate as everything else,
            so the dialog has to be mounted on this screen too. */}
        <ConfirmActionDialog />
        <Toaster theme={theme} position="bottom-left" />
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider delayDuration={400}>
      {/* The design's root is a bordered, 10px-radius panel. We render it as an
          inner frame in a decorated window: transparency plus rounded corners on
          Wayland/WebKitGTK is unreliable. */}
      <div className="flex h-full flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900">
        <TopBar boot={boot} />

        {/* Defaults are the design's exact pixel widths. react-resizable-panels
            v3 has no autoSaveId, so the layout is persisted by hand. */}
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={savedLayout ?? undefined}
          onLayoutChanged={(layout, meta) => {
            // Only user drags are worth saving; mount and imperative changes are not.
            if (meta.isUserInteraction) saveLayout(layout)
          }}
        >
          <ResizablePanel id="rail" defaultSize="214px" minSize="160px" maxSize="420px">
            <LeftRail boot={boot} />
          </ResizablePanel>

          <ResizableHandle className="hover:bg-primary data-[dragging]:bg-primary" />

          <ResizablePanel id="main" minSize="420px">
            <div className="flex h-full min-w-0 flex-col overflow-hidden">
              {/* No tab strip: this panel has exactly one view. It used to carry a
                  Repos/Activity pair, but Activity's two panels were both redundant —
                  per-repo commits live on the detail page, and container state is a
                  `docker ps` away in the output pane. Removing it gave the list back
                  the strip's height. */}
              <NeedsYouStrip />
              <RepoGrid boot={boot} />
            </div>
          </ResizablePanel>

          <ResizableHandle className="hover:bg-primary data-[dragging]:bg-primary" />

          <ResizablePanel
            id="output"
            panelRef={outputPanelRef}
            defaultSize="372px"
            minSize="260px"
            maxSize="900px"
          >
            <OutputPane />
          </ResizablePanel>
        </ResizablePanelGroup>

        {boot && (boot.warnings.length > 0 || boot.readiness.missingRequired.length > 0) && (
          <WarningBar
            warnings={boot.warnings}
            missing={boot.readiness.missingRequired}
            onFix={() => setPage('setup')}
          />
        )}
        {isPending && !boot && (
          <div className="flex-none border-t border-adaptive-200 px-4 py-1.5 text-[11px] text-adaptive-500">
            Starting up — resolving the toolchain…
          </div>
        )}
      </div>

      <ConfirmActionDialog />
      <CommandPalette boot={boot} />
      {/* Sonner sniffs the theme itself, so it must be told explicitly. */}
      <Toaster
        theme={theme}
        position="bottom-left"
        style={
          {
            '--normal-bg': 'var(--card)',
            '--normal-border': 'var(--adaptive-200)',
            '--normal-text': 'var(--adaptive-900)',
          } as React.CSSProperties
        }
      />
    </TooltipProvider>
  )
}

/**
 * Two modes, because two very different things end up here.
 *
 * A *missing required tool* is not a warning — it means the buttons above do not work,
 * so it renders expanded, in error tone, and cannot be folded away. That case used to
 * be indistinguishable from "no docker found": both went into one accordion that was
 * collapsed by default, at the bottom of the window.
 */
function WarningBar({
  warnings,
  missing = [],
  onFix,
}: {
  warnings: string[]
  missing?: string[]
  onFix?: () => void
}) {
  const [open, setOpen] = useState(false)

  if (missing.length > 0) {
    return (
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-t border-error-500/40 bg-red-500/[0.08] px-4 py-1.5">
        <span className="text-[11px] font-semibold text-sev-err">
          {missing.join(', ')} {missing.length > 1 ? 'are' : 'is'} not installed
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-adaptive-600">
          Scanning and most repo actions need {missing.length > 1 ? 'them' : 'it'}.
        </span>
        {onFix && (
          <Button variant="waPrimary" size="waXs" onClick={onFix}>
            Finish setup
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex-none border-t border-adaptive-200 bg-amber-500/[0.08] px-4 py-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left text-[11px] text-warning-500"
      >
        <span className="font-semibold">
          {warnings.length} environment warning{warnings.length > 1 ? 's' : ''}
        </span>
        <span className="text-adaptive-500">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5 pb-1">
          {warnings.map((w, i) => (
            <li key={i} className="text-[11px] text-adaptive-600">
              • {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FatalError({ message }: { message: string }) {
  return (
    // The window buttons matter most here: this screen has no other way out, and
    // without them the only way to close a failed launch was to kill the process.
    <div className="flex h-full flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900">
      <ChromeBar />
      <div className="flex min-h-0 flex-1 items-center justify-center p-10">
        <div className="flex max-w-lg flex-col gap-3 rounded-lg border border-error-500 bg-card p-6">
          <h1 className="text-base font-semibold text-error-500">Could not start</h1>
          <p className="text-sm text-adaptive-700">{message}</p>
          <p className="text-xs text-adaptive-500">
            Work Alley opens the folder you last chose, or the nearest one above the
            working directory that contains git repos. Set{' '}
            <code className="font-mono">WORK_ALLEY_ROOT</code> to override.
          </p>
          <Button variant="waPrimary" size="wa" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * No mock layer on purpose. The data is real by requirement, and a mock would
 * quietly become the thing people develop against.
 */
function NotInTauri() {
  return (
    <div className="flex h-full items-center justify-center bg-background p-10 text-center">
      <div className="flex max-w-md flex-col gap-2">
        <h1 className="text-base font-semibold">Run this under Tauri</h1>
        <p className="text-sm text-adaptive-600">
          Work Alley reads real git state through the Rust backend, so the browser
          dev server alone cannot render it.
        </p>
        <code className="mt-2 rounded-md border border-adaptive-200 bg-adaptive-100 px-2 py-1.5 font-mono text-xs">
          bun run tauri dev
        </code>
      </div>
    </div>
  )
}
