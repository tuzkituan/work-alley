import { ArrowLeft, Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { SKIN_OPTIONS, usePaneTheme, useZoom } from '@/hooks/use-theme'
import {
  MONO_FONTS,
  UI_FONTS,
  useUiStore,
  type MonoFont,
  type UiFont,
} from '@/stores/ui-store'
import { GithubProjectSetting } from '@/features/github-projects/GithubProjectSetting'
import { NumberField, Section, Segmented, SettingRow } from './sections'
import { UpdateRow } from './UpdateRow'
import { useConfig, useSetConfig } from './use-config'

/**
 * Everything the app remembers about how it should behave.
 *
 * Two sources, deliberately not merged: appearance lives in the ui-store
 * (localStorage, instant, no IO) and the rest lives in `config.json` behind
 * `set_config`. The page does not advertise the split — a control is a control —
 * but it is why some rows save immediately on click and the numbers wait for the
 * field to settle.
 *
 * Theme and skin are *also* in the TopBar menu. That is duplication of a control,
 * not of state, and it is the right trade: those two are flipped hourly, and one
 * click from anywhere beats a page visit.
 */
export function SettingsPage() {
  const setPage = useUiStore((s) => s.setPage)
  const { data: cfg } = useConfig()
  const save = useSetConfig()

  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const skin = useUiStore((s) => s.skin)
  const setSkin = useUiStore((s) => s.setSkin)
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const uiFont = useUiStore((s) => s.uiFont)
  const setUiFont = useUiStore((s) => s.setUiFont)
  const monoFont = useUiStore((s) => s.monoFont)
  const setMonoFont = useUiStore((s) => s.setMonoFont)
  const { paneTheme, setPaneTheme } = usePaneTheme()
  const { zoom, setZoom, nudgeZoom, label: zoomLabel, canGrow, canShrink } = useZoom()
  const termFontSize = useUiStore((s) => s.termFontSize)
  const setTermFontSize = useUiStore((s) => s.setTermFontSize)

  return (
    <div className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
      {/* Narrower than the Toolbox's 104rem: that width exists for 50 rows of
          tools, whereas a settings form is one column, and stretching it puts every
          label and its control at opposite edges of the window. */}
      <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-4">
        <div className="flex items-center gap-2">
          {/* A full-window page, so it needs its own way out. */}
          <Button
            variant="waGhost"
            size="waIcon"
            onClick={() => setPage('repos')}
            title="Back to the workspace"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold tracking-[-0.01em]">Settings</h1>
        </div>

        <Section title="Appearance">
          <SettingRow label="Theme">
            <Segmented
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light' as const, label: 'Light' },
                { value: 'dark' as const, label: 'Dark' },
              ]}
            />
          </SettingRow>
          <SettingRow label="Skin" hint="How surfaces are shaped and weighted.">
            <Segmented
              value={skin}
              onChange={setSkin}
              options={SKIN_OPTIONS.map((s) => ({ value: s.id, label: s.label, title: s.hint }))}
            />
          </SettingRow>
          <SettingRow
            label="Console"
            hint="Light or dark for the output pane and terminals, independent of the app. A tool's ANSI colours were usually chosen for a dark background."
          >
            <Segmented
              value={paneTheme}
              onChange={setPaneTheme}
              options={[
                { value: 'app' as const, label: 'Follow app' },
                { value: 'light' as const, label: 'Light' },
                { value: 'dark' as const, label: 'Dark' },
              ]}
            />
          </SettingRow>
          <SettingRow label="Repo view" hint="What the centre panel opens as.">
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'list' as const, label: 'List' },
                { value: 'cards' as const, label: 'Cards' },
              ]}
            />
          </SettingRow>
          <SettingRow label="Interface font">
            <FontPicker
              value={uiFont}
              onChange={setUiFont}
              options={UI_FONTS.map((f) => ({ id: f.id, label: f.label, stack: f.stack }))}
            />
          </SettingRow>
          <SettingRow
            label="Monospace font"
            hint="The output pane, the terminal and every version column."
          >
            <FontPicker
              value={monoFont}
              onChange={setMonoFont}
              options={MONO_FONTS.map((f) => ({ id: f.id, label: f.label, stack: f.stack }))}
            />
          </SettingRow>
          <SettingRow
            label="Zoom"
            hint="Scales the whole interface, not just the text. Also in the appearance menu, and on ⌘/Ctrl + − and 0."
          >
            <Button
              variant="waOutline"
              size="waIcon"
              aria-label="Zoom out"
              disabled={!canShrink}
              onClick={() => nudgeZoom(-1)}
            >
              −
            </Button>
            {/* Wider than the terminal stepper's `w-6`: "100%" is four characters. */}
            <span className="wa-num w-10 text-center font-mono text-xs">{zoomLabel}</span>
            <Button
              variant="waOutline"
              size="waIcon"
              aria-label="Zoom in"
              disabled={!canGrow}
              onClick={() => nudgeZoom(1)}
            >
              +
            </Button>
            <Button
              variant="waGhost"
              size="waXs"
              disabled={zoom === 1}
              onClick={() => setZoom(1)}
            >
              Reset
            </Button>
          </SettingRow>
          <SettingRow
            label="Terminal text size"
            hint="At 12px the default output pane is about 44 columns; curses apps assume 80."
          >
            <Button
              variant="waOutline"
              size="waIcon"
              aria-label="Smaller terminal text"
              disabled={termFontSize <= 8}
              onClick={() => setTermFontSize(termFontSize - 1)}
            >
              −
            </Button>
            <span className="wa-num w-6 text-center font-mono text-xs">{termFontSize}</span>
            <Button
              variant="waOutline"
              size="waIcon"
              aria-label="Larger terminal text"
              disabled={termFontSize >= 20}
              onClick={() => setTermFontSize(termFontSize + 1)}
            >
              +
            </Button>
          </SettingRow>
        </Section>

        <Section title="Workspace">
          <SettingRow
            label="Reopen the last folder on launch"
            hint="Opens the workspace you last had open, and scans the folder you last had selected. Off, the app starts on the folder picker."
          >
            <Switch
              checked={cfg?.reopenLastWorkspace ?? true}
              disabled={!cfg}
              onCheckedChange={(reopenLastWorkspace) => save.mutate({ reopenLastWorkspace })}
            />
          </SettingRow>
          <SettingRow
            label="Package manager"
            hint="Used when a repo does not say. A lockfile or a packageManager field always wins — running npm in a pnpm repo would rewrite its lockfile."
          >
            <Segmented
              value={cfg?.preferredPackageManager ?? 'auto'}
              onChange={(v) =>
                save.mutate({ preferredPackageManager: v === 'auto' ? null : v })
              }
              options={[
                { value: 'auto', label: 'Auto', title: 'Whichever is installed, fastest first' },
                { value: 'bun', label: 'bun' },
                { value: 'pnpm', label: 'pnpm' },
                { value: 'yarn', label: 'yarn' },
                { value: 'npm', label: 'npm' },
              ]}
            />
          </SettingRow>
          <SettingRow
            label="Background fetch"
            hint="Ahead/behind counts come from local refs, so without this they drift the longer a workspace stays open."
          >
            <Segmented
              value={cfg?.autoFetchMinutes ?? 10}
              onChange={(autoFetchMinutes) => save.mutate({ autoFetchMinutes })}
              options={[
                { value: 0, label: 'Off' },
                { value: 5, label: '5 min' },
                { value: 10, label: '10 min' },
                { value: 30, label: '30 min' },
                { value: 60, label: '1 hr' },
              ]}
            />
          </SettingRow>
        </Section>

        <Section title="GitHub Projects">
          <GithubProjectSetting />
        </Section>

        <Section title="Scanning">
          <SettingRow
            label="Stale after"
            hint="How long since a fetch before a repo is called stale."
          >
            <NumberField
              value={cfg?.staleDays ?? 9}
              min={1}
              max={365}
              suffix="days"
              onCommit={(staleDays) => save.mutate({ staleDays })}
            />
          </SettingRow>
          <SettingRow
            label="Scan concurrency"
            hint="Parallel git processes per scan. Higher is faster until the disk becomes the bottleneck."
          >
            <NumberField
              value={cfg?.scanConcurrency ?? 8}
              min={1}
              max={64}
              onCommit={(scanConcurrency) => save.mutate({ scanConcurrency })}
            />
          </SettingRow>
          <SettingRow
            label="Recent commits"
            hint="How many commits the workspace-wide list merges per scan."
          >
            <NumberField
              value={cfg?.recentCommitLimit ?? 30}
              min={1}
              max={200}
              onCommit={(recentCommitLimit) => save.mutate({ recentCommitLimit })}
            />
          </SettingRow>
        </Section>

        <Section title="Logs">
          <SettingRow
            label="Lines kept per run"
            hint="A ring buffer. Past this the oldest lines are dropped and the log is marked truncated."
          >
            <NumberField
              value={cfg?.maxLogLinesPerRun ?? 5000}
              min={200}
              max={100_000}
              suffix="lines"
              onCommit={(maxLogLinesPerRun) => save.mutate({ maxLogLinesPerRun })}
            />
          </SettingRow>
        </Section>

        <Section title="About">
          <UpdateRow />
        </Section>

        <p className="pb-2 text-[11px] text-adaptive-400">
          Numbers are clamped by the backend, so a value outside its range settles on
          the nearest one it accepts.
        </p>
      </div>
    </div>
  )
}

/**
 * The font list, each item rendered in its own family.
 *
 * That preview is the whole reason this is a menu rather than segmented buttons:
 * the choice is about how the letters look, and a row of same-looking labels
 * cannot say it.
 */
function FontPicker<T extends UiFont | MonoFont>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { id: T; label: string; stack: string }[]
  onChange: (id: T) => void
}) {
  const current = options.find((o) => o.id === value) ?? options[0]!

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="waOutline" size="waXs" className="w-[12rem] justify-between">
          <span className="truncate" style={{ fontFamily: current.stack }}>
            {current.label}
          </span>
          <ChevronDown className="size-3 flex-none" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[14rem]">
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onClick={() => onChange(o.id)}>
            <span className="flex-1 truncate" style={{ fontFamily: o.stack }}>
              {o.label}
            </span>
            {o.id === value && <Check className="size-3 flex-none text-sev-ok" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
