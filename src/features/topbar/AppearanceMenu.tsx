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
import { Palette } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SKIN_OPTIONS, usePaneTheme, useSkin, useTheme, useZoom } from '@/hooks/use-theme'
import { useUiStore } from '@/stores/ui-store'
import type { PaneTheme, Skin, ThemeMode } from '@/stores/ui-store'

/**
 * Theme, skin, console lighting and zoom, in one menu.
 *
 * Its own component because it belongs in *both* headers. TopBar is only mounted
 * once a workspace is open, so on the launcher, the setup takeover and the folder
 * picker — exactly the screens a new user spends their first minutes on — there was
 * no way to turn the lights down without first getting past them.
 */
export function AppearanceMenu() {
  const { theme, setTheme, label: themeLabel } = useTheme()
  const { skin, setSkin, label: skinLabel } = useSkin()
  const { paneTheme, setPaneTheme } = usePaneTheme()
  const { setZoom, nudgeZoom, label: zoomLabel, canGrow, canShrink } = useZoom()
  const setPage = useUiStore((s) => s.setPage)

  // A menu rather than the old toggle: appearance and skin are independent, so
  // there are four states, and a control with four states has to *show* which one
  // it is in. The command palette keeps a one-keystroke path to the first two.
  return (
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
  )
}
