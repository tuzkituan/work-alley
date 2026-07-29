import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { TopBar } from '@/features/topbar/TopBar'
import { LeftRail } from '@/features/rail/LeftRail'
import { NeedsYouStrip } from '@/features/needs-you/NeedsYouStrip'
import { RepoGrid } from '@/features/repos/RepoGrid'
import { OutputPane } from '@/features/output/OutputPane'
import { ConfirmActionDialog } from '@/features/actions/ConfirmActionDialog'
import { CommandPalette } from '@/features/command/CommandPalette'
import { WorkspaceWelcome } from '@/features/workspace/WorkspacePicker'
import { Toolbox } from '@/features/toolbox/Toolbox'
import { useUiStore } from '@/stores/ui-store'
import { api } from '@/ipc/commands'
import { connectBridge } from '@/ipc/bridge'
import { isTauri } from '@/ipc/guard'
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

function Dashboard() {
  const qc = useQueryClient()
  // Read once: re-reading on every render would fight the drag.
  const [savedLayout] = useState(loadLayout)
  const page = useUiStore((s) => s.page)
  const { theme } = useTheme()
  const [connected, setConnected] = useState(false)

  // get_bootstrap paints the entire chrome — real counts, all 63 rail rows, the
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

  // Scans the open folder, once a folder is open *and* the toolchain is resolved.
  useCategoryScan(boot?.toolsReady ?? false)

  // Attach listeners as soon as the backend is up. No scan is started here: with
  // every folder collapsed there is nothing in view, so scanning all 63 repos
  // would be work nobody asked for.
  useEffect(() => {
    if (!boot || connected) return
    setConnected(true)
    void connectBridge(qc)
  }, [boot, connected, qc])

  if (error && !boot) return <FatalError message={error.message} />

  // No folder chosen yet, or the saved one has gone. Nothing else is meaningful
  // until this is answered, so it replaces the whole window rather than nagging.
  if (boot && !boot.hasWorkspace) {
    return (
      <TooltipProvider>
        <WorkspaceWelcome boot={boot} />
        <Toaster theme={theme} position="bottom-right" />
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

          <ResizableHandle className="hover:bg-primary-600 data-[dragging]:bg-primary-600" />

          <ResizablePanel id="main" minSize="420px">
            <div className="flex h-full min-w-0 flex-col overflow-hidden">
              {page === 'toolbox' ? (
                <Toolbox toolsReady={boot?.toolsReady ?? false} />
              ) : (
                <>
                  <NeedsYouStrip />
                  <RepoGrid boot={boot} />
                </>
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle className="hover:bg-primary-600 data-[dragging]:bg-primary-600" />

          <ResizablePanel id="output" defaultSize="372px" minSize="260px" maxSize="900px">
            <OutputPane />
          </ResizablePanel>
        </ResizablePanelGroup>

        {boot && boot.warnings.length > 0 && <WarningBar warnings={boot.warnings} />}
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
        position="bottom-right"
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

function WarningBar({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false)
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
    <div className="flex h-full items-center justify-center bg-background p-10">
      <div className="flex max-w-lg flex-col gap-3 rounded-lg border border-error-500 bg-card p-6">
        <h1 className="text-base font-semibold text-error-500">Could not start</h1>
        <p className="text-sm text-adaptive-700">{message}</p>
        <p className="text-xs text-adaptive-500">
          Work Alley looks for the nearest ancestor directory containing{' '}
          <code className="font-mono">repos.json</code> and a{' '}
          <code className="font-mono">be/ fe/ sa/ ui/</code> directory. Set{' '}
          <code className="font-mono">WORK_ALLEY_ROOT</code> to override.
        </p>
        <Button variant="waPrimary" size="wa" onClick={() => window.location.reload()}>
          Retry
        </Button>
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
