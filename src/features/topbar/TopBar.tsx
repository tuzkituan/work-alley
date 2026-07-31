import { Search, SquareTerminal } from 'lucide-react'
import { WindowControls } from './WindowControls'
import { AppearanceMenu } from './AppearanceMenu'
import { useOpenFolderKey, WorkspaceSwitcher } from '@/features/workspace/WorkspacePicker'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { KeyCap, Sep } from '@/components/wa/primitives'
import { useAppIdentity } from '@/hooks/use-bootstrap'
import { useRunAction } from '@/hooks/use-action'
import { useUiStore } from '@/stores/ui-store'
import { useScanStore } from '@/stores/scan-store'
import type { Bootstrap } from '@/domain/types'
import { useTerminalStore } from '@/stores/terminal-store'

export function TopBar({ boot }: { boot: Bootstrap | undefined }) {
  const { name } = useAppIdentity()
  const run = useRunAction()
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen)
  const phase = useScanStore((s) => s.phase)
  const total = useScanStore((s) => s.total)
  const received = useScanStore((s) => s.received)

  const repoCount = boot?.repos.length ?? 0
  const scriptCount = boot?.scripts.length ?? 0
  // The bar is shown on the machine pages too, where there may be no workspace at
  // all. Everything scoped to one is hidden rather than shown empty: "0 repos ·
  // 0 scripts" says nothing.
  const hasWorkspace = boot?.hasWorkspace ?? false
  // Here rather than in the switcher below, which is not mounted without a folder.
  useOpenFolderKey()

  return (
    <div className="relative flex-none">
      <div
      data-slot="top-bar"
      className="flex h-[52px] items-center gap-3.5 border-b border-adaptive-200 bg-adaptive-100 px-4"
    >
        {/* The bar doubles as the title bar. The drag attribute goes on the inert
            areas only — putting it on the whole bar would swallow button clicks. */}
        <div data-tauri-drag-region className="flex items-center gap-2">
          <div className="flex size-[22px] items-center justify-center rounded-md bg-primary text-[13px] font-bold text-primary-foreground">
            {name.charAt(0)}
          </div>
          <span data-slot="app-name" className="text-sm font-semibold tracking-[-0.01em]">
            {name}
          </span>
        </div>

        {/* Only with a folder open. On the machine pages — Toolbox, Guided setup,
            Git accounts — reached before choosing one, this rendered as a button
            reading "no workspace": a control whose entire content is the absence of
            the thing it switches. Opening a folder from here is still one keystroke
            (⌘O), and the launcher does it properly. */}
        {hasWorkspace && <WorkspaceSwitcher boot={boot} />}

        {hasWorkspace && (
          <div
            data-tauri-drag-region
            className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-adaptive-500"
          >
            <span className="wa-num">{repoCount} repos</span>
            <Sep />
            <span className="wa-num">{scriptCount} scripts</span>
          </div>
        )}

        {/* Double-clicking a drag region toggles maximize, as a title bar should. */}
        <div data-tauri-drag-region className="h-full flex-1" />

        {/* Everything it searches — repos, branches, scripts — comes from a
            workspace, and the palette is not even mounted outside the dashboard. */}
        {hasWorkspace && (
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-[30px] items-center gap-2 rounded-md border border-adaptive-300 bg-background px-2.5 text-xs text-adaptive-400 transition-shadow hover:border-adaptive-950 hover:shadow-focus-ring"
          >
            <Search className="size-3" />
            <span>Search repos, branches, scripts</span>
            <KeyCap>⌘K</KeyCap>
          </button>
        )}

        {/* No workspace, no folder to open a shell *in* — the action's cwd is the
            workspace root, so on the setup and picker screens this button either
            fails or opens somewhere arbitrary. Hidden like the counts and the
            search field above, for the same reason. */}
        {hasWorkspace && (
          <Button
            variant="waOutline"
            size="waIconLg"
            className="border-adaptive-300"
            title="Open a terminal in the workspace folder"
            onClick={() => {
            useTerminalStore.getState().requestFocus()
            run({ kind: 'openShell', ref: null })
          }}
          >
            <SquareTerminal className="size-3.5" />
          </Button>
        )}
        {/* Toolbox and Guided setup live in the left rail now, above the toolchain
            card: both are about this machine rather than this workspace, which is
            exactly what that card already shows. */}
        <AppearanceMenu />
        <span className="mx-1 h-5 w-px bg-adaptive-200" />
        <WindowControls />
      </div>

      {/* Determinate scan progress. The chrome is already painted; this only
          reports how much real git state has landed. */}
      {phase === 'scanning' && total > 0 && (
        <Progress
          value={(received / total) * 100}
          className="absolute inset-x-0 bottom-0 h-[2px] rounded-none bg-transparent"
        />
      )}
    </div>
  )
}

