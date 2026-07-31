import { WindowControls } from './WindowControls'
import { AppearanceMenu } from './AppearanceMenu'
import { useAppIdentity } from '@/hooks/use-bootstrap'

/**
 * A title bar for the screens that do not have the top bar.
 *
 * `decorations: false` means the OS draws no title bar, so the app has to draw its
 * own — which the 52px `TopBar` does, window buttons and drag region included. The
 * first-run screens and the fatal-error screen do not render it, and the result was
 * a window that could not be moved, minimized or even closed: the only way out of
 * the workspace picker was to kill the process.
 *
 * Same height, same mark, same appearance menu as `TopBar` — the two are never on
 * screen together, so any difference between them reads as the window shifting as
 * you move through the app rather than as two components. What it drops is what has
 * nothing to act on yet: the workspace switcher, the repo counts and the search.
 */
export function ChromeBar({ title }: { title?: string } = {}) {
  // The app's own name, not a hardcoded string: it is set at build time and the top
  // bar has always read it from here.
  const { name } = useAppIdentity()

  return (
    <div
      data-slot="chrome-bar"
      // 52px and `px-4`, the same as TopBar. It used to be 38px on the theory that a
      // screen with one question needs less chrome; in practice the height changed
      // between the launcher and the dashboard, so the window appeared to shift as
      // you moved through it — and the mark and the appearance menu are the same size
      // in both, so the shorter bar only squeezed them.
      className="flex h-[52px] flex-none items-center gap-3.5 border-b border-adaptive-200 bg-adaptive-100 px-4"
    >
      {/* The drag attribute goes on the inert areas only — on the whole bar it
          swallows the button clicks. */}
      <div data-tauri-drag-region className="flex items-center gap-2">
        {/* The same mark the top bar draws, at the same size. These two bars are
            never on screen together, so any difference between them reads as the
            app changing identity between screens rather than as two components. */}
        <div className="flex size-[22px] items-center justify-center rounded-md bg-primary text-[13px] font-bold text-primary-foreground">
          {name.charAt(0)}
        </div>
        <span data-slot="app-name" className="text-sm font-semibold tracking-[-0.01em]">
          {title ?? name}
        </span>
      </div>
      {/* Double-clicking a drag region toggles maximize, as a title bar should. */}
      <div data-tauri-drag-region className="h-full flex-1" />
      {/* The same menu the dashboard's header has. This bar is what the launcher,
          the setup takeover and the fatal-error screen use, and those are exactly
          the screens where someone first meets the app — having to get past them to
          turn the lights down was the wrong order. */}
      <AppearanceMenu />
      <span className="mx-1 h-5 w-px bg-adaptive-200" />
      <WindowControls />
    </div>
  )
}
