import { WindowControls } from './WindowControls'

/**
 * A title bar for the screens that do not have the top bar.
 *
 * `decorations: false` means the OS draws no title bar, so the app has to draw its
 * own — which the 52px `TopBar` does, window buttons and drag region included. The
 * first-run screens and the fatal-error screen do not render it, and the result was
 * a window that could not be moved, minimized or even closed: the only way out of
 * the workspace picker was to kill the process.
 *
 * Deliberately slimmer and quieter than `TopBar`. These screens are a single
 * centred question, and a full-height bar with a workspace switcher in it would be
 * promising controls that have nothing to act on yet.
 */
export function ChromeBar({ title = 'Work Alley' }: { title?: string }) {
  return (
    <div className="flex h-[38px] flex-none items-center gap-2 border-b border-adaptive-200 bg-adaptive-100 pr-2 pl-3.5">
      {/* The drag attribute goes on the inert areas only — on the whole bar it
          swallows the button clicks. */}
      <div data-tauri-drag-region className="flex items-center gap-2">
        <span className="text-[12px] font-semibold text-adaptive-700">{title}</span>
      </div>
      {/* Double-clicking a drag region toggles maximize, as a title bar should. */}
      <div data-tauri-drag-region className="h-full flex-1" />
      <WindowControls />
    </div>
  )
}
