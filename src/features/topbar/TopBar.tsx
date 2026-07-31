import { Palette, Search, SquareTerminal } from 'lucide-react'
import { WindowControls } from './WindowControls'
import { WorkspaceSwitcher } from '@/features/workspace/WorkspacePicker'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Progress } from '@/components/ui/progress'
import { KeyCap, Sep } from '@/components/wa/primitives'
import { SKIN_OPTIONS, usePaneTheme, useSkin, useTheme, useZoom } from '@/hooks/use-theme'
import { useAppIdentity } from '@/hooks/use-bootstrap'
import { useRunAction } from '@/hooks/use-action'
import { useUiStore } from '@/stores/ui-store'
import { useScanStore } from '@/stores/scan-store'
import type { Bootstrap } from '@/domain/types'
import type { PaneTheme, Skin, ThemeMode } from '@/stores/ui-store'

export function TopBar({ boot }: { boot: Bootstrap | undefined }) {
  const { theme, setTheme, label: themeLabel } = useTheme()
  const { skin, setSkin, label: skinLabel } = useSkin()
  const { paneTheme, setPaneTheme } = usePaneTheme()
  const { setZoom, nudgeZoom, label: zoomLabel, canGrow, canShrink } = useZoom()
  const { name } = useAppIdentity()
  const run = useRunAction()
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen)
  const setPage = useUiStore((s) => s.setPage)
  const phase = useScanStore((s) => s.phase)
  const total = useScanStore((s) => s.total)
  const received = useScanStore((s) => s.received)

  const repoCount = boot?.repos.length ?? 0
  const scriptCount = boot?.scripts.length ?? 0
  // The bar is shown on the machine pages too, where there may be no workspace at
  // all. Everything scoped to one is hidden rather than shown empty: "0 repos ·
  // 0 scripts" says nothing.
  const hasWorkspace = boot?.hasWorkspace ?? false

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

        <WorkspaceSwitcher boot={boot} />

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

        <Button
          variant="waOutline"
          size="waIconLg"
          className="border-adaptive-300"
          title="Open a terminal in the workspace folder"
          onClick={() => run({ kind: 'openShell', ref: null })}
        >
          <SquareTerminal className="size-3.5" />
        </Button>
        {/* Toolbox and Guided setup live in the left rail now, above the toolchain
            card: both are about this machine rather than this workspace, which is
            exactly what that card already shows. */}
        {/* A menu rather than the old toggle: appearance and skin are independent,
            so there are four states, and a control with four states has to *show*
            which one it is in. The palette keeps a one-keystroke path to both. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="waOutline"
              size="waIconLg"
              // Stronger edge than the page default: see the note on the search field.
              className="border-adaptive-300"
              title={`Appearance: ${themeLabel} · Skin: ${skinLabel} · Zoom: ${zoomLabel}`}
            >
              {/* A palette, not a sun/moon: the menu behind this button is no longer
                  a light/dark toggle — it holds the skin, the zoom and the console's
                  own lighting, and an icon that shows only one of four axes is an
                  icon that lies about three of them. */}
              <Palette className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
              Appearance
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(v) => setTheme(v as ThemeMode)}
            >
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
              Skin
            </DropdownMenuLabel>
            {/* Mapped over SKIN_OPTIONS, not written out: two hardcoded entries are
                why the third skin was invisible here even though the store, the
                stylesheet and the command palette all knew about it. */}
            <DropdownMenuRadioGroup value={skin} onValueChange={(v) => setSkin(v as Skin)}>
              {SKIN_OPTIONS.map((o) => (
                <DropdownMenuRadioItem key={o.id} value={o.id}>
                  {o.label}
                  <span className="ml-auto text-[10px] text-adaptive-400">{o.hint}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
              Console
            </DropdownMenuLabel>
            {/* The output pane and terminals. Here as well as in Settings because a
                dark console under a light app is a thing people flip while looking
                at the log, not while reading a settings page. */}
            <DropdownMenuRadioGroup
              value={paneTheme}
              onValueChange={(v) => setPaneTheme(v as PaneTheme)}
            >
              <DropdownMenuRadioItem value="app">Follow app</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
              Zoom
            </DropdownMenuLabel>
            {/* Plain buttons in a plain div, not DropdownMenuItems: an item closes
                the menu on select, and a stepper you must reopen the menu to press
                twice is not a stepper. */}
            <div
              className="flex items-center gap-1 px-2 py-1"
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Button
                variant="waOutline"
                size="waIcon"
                aria-label="Zoom out"
                disabled={!canShrink}
                onClick={(e) => {
                  e.preventDefault()
                  nudgeZoom(-1)
                }}
              >
                −
              </Button>
              <button
                type="button"
                // The readout doubles as reset, which is where every browser puts
                // it and saves a third button in a 176px menu.
                className="wa-num flex-1 rounded-md py-1 text-center font-mono text-xs text-adaptive-700 hover:bg-adaptive-200"
                title="Reset to 100%"
                onClick={(e) => {
                  e.preventDefault()
                  setZoom(1)
                }}
              >
                {zoomLabel}
              </button>
              <Button
                variant="waOutline"
                size="waIcon"
                aria-label="Zoom in"
                disabled={!canGrow}
                onClick={(e) => {
                  e.preventDefault()
                  nudgeZoom(1)
                }}
              >
                +
              </Button>
            </div>
            <DropdownMenuSeparator />
            {/* This menu stays the one-click path for the two things people flip
                hourly; fonts, scanning and background fetch are a page away. */}
            <DropdownMenuItem onClick={() => setPage('settings')}>
              More settings…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Fetch / Pull / Checkout used to sit here. They are scoped to the open
            folder, so they now live in that folder's own header in RepoGrid, beside
            the name they act on. */}

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

