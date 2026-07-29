import { Search } from 'lucide-react'
import { WindowControls } from './WindowControls'
import { TerminalsMenu } from './TerminalsMenu'
import { WorkspaceSwitcher } from '@/features/workspace/WorkspacePicker'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { KeyCap, Sep } from '@/components/wa/primitives'
import { useTheme } from '@/hooks/use-theme'
import { useRunAction } from '@/hooks/use-action'
import { useUiStore } from '@/stores/ui-store'
import { useScanStore } from '@/stores/scan-store'
import type { Bootstrap } from '@/domain/types'

export function TopBar({ boot }: { boot: Bootstrap | undefined }) {
  const { toggleTheme, label, mode } = useTheme()
  const run = useRunAction()
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen)
  const expanded = useUiStore((s) => s.expandedCategory)
  const phase = useScanStore((s) => s.phase)
  const total = useScanStore((s) => s.total)
  const received = useScanStore((s) => s.received)

  const repoCount = boot?.repos.length ?? 0
  const scriptCount = boot?.scripts.length ?? 0

  // Bulk actions follow the open folder. "Pull All" across 63 repos when the user
  // is looking at one folder would act well outside what they can see.
  const targets = (boot?.repos ?? []).filter((r) => !expanded || r.category === expanded)
  const scopeLabel = expanded ? `${expanded}/` : 'All'

  return (
    <div className="relative flex-none">
      <div className="flex h-[52px] items-center gap-3.5 border-b border-adaptive-200 bg-adaptive-100 px-4">
        {/* The bar doubles as the title bar. The drag attribute goes on the inert
            areas only — putting it on the whole bar would swallow button clicks. */}
        <div data-tauri-drag-region className="flex items-center gap-2">
          <div className="flex size-[22px] items-center justify-center rounded-md bg-gradient-to-b from-[#EA580C] to-[#F97316] text-[13px] font-bold text-white">
            W
          </div>
          <span className="text-sm font-semibold tracking-[-0.01em]">work-alley</span>
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
          className="flex items-center gap-2 rounded-md border border-adaptive-200 bg-background px-2.5 py-[5px] text-xs text-adaptive-400 transition-shadow hover:border-adaptive-950 hover:shadow-focus-ring"
        >
          <Search className="size-3" />
          <span>Search repos, branches, scripts</span>
          <KeyCap>⌘K</KeyCap>
        </button>

        <TerminalsMenu />

        <Button
          variant="waOutline"
          size="wa"
          onClick={toggleTheme}
          title={
            mode === 'system'
              ? 'Following the system theme — click for light'
              : `${label} theme — click to change`
          }
        >
          {label}
        </Button>
        <Button
          variant="waOutline"
          size="wa"
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

