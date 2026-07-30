import { useState } from 'react'
import { GitBranch, Moon, Search, SquareTerminal, Sun } from 'lucide-react'
import { WindowControls } from './WindowControls'
import { TerminalsMenu } from './TerminalsMenu'
import { WorkspaceSwitcher } from '@/features/workspace/WorkspacePicker'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Progress } from '@/components/ui/progress'
import { KeyCap, Sep } from '@/components/wa/primitives'
import { useSkin, useTheme } from '@/hooks/use-theme'
import { useAppIdentity } from '@/hooks/use-bootstrap'
import { CheckoutAllDialog } from '@/features/actions/CheckoutAllDialog'
import { useRunAction } from '@/hooks/use-action'
import { useUiStore } from '@/stores/ui-store'
import { useScanStore } from '@/stores/scan-store'
import type { Bootstrap } from '@/domain/types'
import type { Skin, ThemeMode } from '@/stores/ui-store'

export function TopBar({ boot }: { boot: Bootstrap | undefined }) {
  const { theme, setTheme, label: themeLabel } = useTheme()
  const { skin, setSkin, label: skinLabel } = useSkin()
  const { name } = useAppIdentity()
  const run = useRunAction()
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen)
  const expanded = useUiStore((s) => s.expandedCategory)
  const phase = useScanStore((s) => s.phase)
  const total = useScanStore((s) => s.total)
  const received = useScanStore((s) => s.received)

  const [checkoutOpen, setCheckoutOpen] = useState(false)

  const repoCount = boot?.repos.length ?? 0
  const scriptCount = boot?.scripts.length ?? 0

  // Bulk actions follow the open folder. "Pull All" across every repo when
  // is looking at one folder would act well outside what they can see.
  const targets = (boot?.repos ?? []).filter((r) => !expanded || r.category === expanded)
  const scopeLabel = expanded ? `${expanded}/` : 'All'

  return (
    <div className="relative flex-none">
      <div className="flex h-[52px] items-center gap-3.5 border-b border-adaptive-200 bg-adaptive-100 px-4">
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

        <div
          data-tauri-drag-region
          className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-adaptive-500"
        >
          <span className="wa-num">{repoCount} repos</span>
          <Sep />
          <span className="wa-num">{scriptCount} scripts</span>
        </div>

        {/* Double-clicking a drag region toggles maximize, as a title bar should. */}
        <div data-tauri-drag-region className="h-full flex-1" />

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-[30px] items-center gap-2 rounded-md border border-adaptive-300 bg-background px-2.5 text-xs text-adaptive-400 transition-shadow hover:border-adaptive-950 hover:shadow-focus-ring"
        >
          <Search className="size-3" />
          <span>Search repos, branches, scripts</span>
          <KeyCap>⌘K</KeyCap>
        </button>

        <TerminalsMenu />

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
              title={`Appearance: ${themeLabel} · Skin: ${skinLabel}`}
            >
              {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
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
            <DropdownMenuRadioGroup value={skin} onValueChange={(v) => setSkin(v as Skin)}>
              <DropdownMenuRadioItem value="classic">
                Classic
                <span className="ml-auto text-[10px] text-adaptive-400">rounded</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="metro">
                Metro
                <span className="ml-auto text-[10px] text-adaptive-400">flat tiles</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="waOutline"
          size="wa"
          className="border-adaptive-300"
          disabled={targets.length === 0}
          // Scoped to the open folder. This previously said "Fetch sa/" but sent
          // ref: null, which fetches every repo in the workspace — the label and
          // the action disagreed.
          onClick={() =>
            run(expanded ? { kind: 'fetchMany', refs: targets } : { kind: 'fetchAll', ref: null })
          }
        >
          Fetch {scopeLabel}
        </Button>
        <Button
          variant="waPrimary"
          size="wa"
          disabled={targets.length === 0}
          onClick={() => run({ kind: 'pullMany', refs: targets })}
        >
          Pull {scopeLabel}
        </Button>
        <Button
          variant="waOutline"
          size="wa"
          className="border-adaptive-300"
          disabled={targets.length === 0}
          title={`Check out a branch across every repo in ${scopeLabel}`}
          onClick={() => setCheckoutOpen(true)}
        >
          <GitBranch className="size-3.5" />
          Checkout
        </Button>

        <span className="mx-1 h-5 w-px bg-adaptive-200" />
        <WindowControls />
      </div>

      <CheckoutAllDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        repos={targets}
        scopeLabel={scopeLabel}
      />

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

