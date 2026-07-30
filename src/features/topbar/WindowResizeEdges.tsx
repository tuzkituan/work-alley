import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * Grab strips along the window's edges and corners.
 *
 * `decorations: false` turns off the OS frame, and the resize border goes with it —
 * there is no invisible margin outside the webview to hit, so the window could only
 * be resized by a compositor keybinding, and hovering an edge showed the ordinary
 * cursor because nothing there claimed to be draggable. `TopBar`/`ChromeBar` already
 * replace the title bar's *moving* half with `data-tauri-drag-region`; this is the
 * other half.
 *
 * The cursor is the point of the exercise, so it is set inline rather than through a
 * utility class: it must not depend on which cursor utilities the Tailwind build
 * happens to have emitted.
 */

type Dir = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest'

/**
 * 5px of edge and 12px of corner.
 *
 * Enough to hit without aiming — a 1px border is unusable with a trackpad — and
 * small enough that the strips stay off the app's own controls, which start at the
 * 10px padding every panel uses. Corners are bigger because they are the throw you
 * make when you want to resize both axes at once, and they win over the edges by
 * being painted after them.
 */
const EDGE = 5
const CORNER = 12

const HANDLES: { dir: Dir; cursor: string; style: React.CSSProperties }[] = [
  { dir: 'North', cursor: 'ns-resize', style: { top: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: 'South', cursor: 'ns-resize', style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: 'West', cursor: 'ew-resize', style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: 'East', cursor: 'ew-resize', style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: 'NorthWest', cursor: 'nwse-resize', style: { top: 0, left: 0, width: CORNER, height: CORNER } },
  { dir: 'NorthEast', cursor: 'nesw-resize', style: { top: 0, right: 0, width: CORNER, height: CORNER } },
  { dir: 'SouthWest', cursor: 'nesw-resize', style: { bottom: 0, left: 0, width: CORNER, height: CORNER } },
  { dir: 'SouthEast', cursor: 'nwse-resize', style: { bottom: 0, right: 0, width: CORNER, height: CORNER } },
]

export function WindowResizeEdges() {
  const [maximized, setMaximized] = useState(false)

  // Same subscription as `WindowControls`: the compositor can maximize the window
  // behind the app's back, and an edge that still offers to resize a maximized window
  // either does nothing or unmaximizes it on a stray click.
  useEffect(() => {
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined
    let cancelled = false

    void win.isMaximized().then((m) => !cancelled && setMaximized(m))
    void win
      .onResized(() => {
        void win.isMaximized().then((m) => !cancelled && setMaximized(m))
      })
      .then((fn) => {
        unlisten = fn
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  if (maximized) return null

  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.dir}
          // Above everything, including a modal's overlay: these are 5px of window
          // frame, and a window you cannot resize while a dialog is open is a window
          // that looks broken.
          style={{ position: 'fixed', zIndex: 9999, cursor: h.cursor, ...h.style }}
          onMouseDown={(e) => {
            // Primary button only — a right-click here belongs to the context menu.
            if (e.button !== 0) return
            // Or the gesture starts by selecting whatever text is under the strip,
            // and the selection survives the resize.
            e.preventDefault()
            void getCurrentWindow().startResizeDragging(h.dir).catch(() => {})
          }}
        />
      ))}
    </>
  )
}
