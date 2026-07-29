import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { cn } from '@/lib/utils'

/**
 * Our own window buttons, since the OS title bar is turned off
 * (`decorations: false`) and the design's 52px top bar doubles as the title bar.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined
    let cancelled = false

    void win.isMaximized().then((m) => !cancelled && setMaximized(m))
    // The window can also be maximized by the compositor (a keyboard shortcut, a
    // tiling action), so the icon has to follow the real state, not just clicks.
    void win.onResized(() => {
      void win.isMaximized().then((m) => !cancelled && setMaximized(m))
    }).then((fn) => {
      unlisten = fn
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const win = getCurrentWindow()

  return (
    <div className="flex items-center gap-0.5 pl-1">
      <ControlButton label="Minimize" onClick={() => void win.minimize()}>
        <Minus className="size-3.5" />
      </ControlButton>

      <ControlButton
        label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
      </ControlButton>

      <ControlButton label="Close" danger onClick={() => void win.close()}>
        <X className="size-3.5" />
      </ControlButton>
    </div>
  )
}

function ControlButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-adaptive-500 transition-colors',
        danger ? 'hover:bg-error-500 hover:text-background' : 'hover:bg-adaptive-200 hover:text-adaptive-900'
      )}
    >
      {children}
    </button>
  )
}
