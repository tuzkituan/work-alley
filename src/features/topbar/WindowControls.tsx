import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/hooks/use-platform'

/**
 * Our own window buttons, since the OS title bar is turned off
 * (`decorations: false`) and the design's 52px top bar doubles as the title bar.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  // Windows users read the shape of these buttons before they read the icons, so a
  // Linux-shaped set in the corner of a Windows window looks broken rather than
  // minimal. The decorations stay off either way — this is the caption bar, so it has
  // to at least be the right size and hit area.
  const windows = usePlatform() === 'windows'

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
    <div className={cn('flex items-center', windows ? 'h-full' : 'gap-0.5 pl-1')}>
      <ControlButton windows={windows} label="Minimize" onClick={() => void win.minimize()}>
        <Minus className="size-3.5" />
      </ControlButton>

      <ControlButton
        windows={windows}
        label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
      </ControlButton>

      <ControlButton windows={windows} label="Close" danger onClick={() => void win.close()}>
        <X className="size-3.5" />
      </ControlButton>
    </div>
  )
}

function ControlButton({
  label,
  danger = false,
  windows = false,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  /** Windows caption-button metrics: 46px wide, square, full height, no gaps. */
  windows?: boolean
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
        'flex items-center justify-center text-adaptive-500 transition-colors',
        // 46x32 and hard-edged, which is what every other Windows title bar does —
        // including the full height, so the pointer still lands on it in the very
        // corner of the screen.
        windows ? 'h-full w-[46px]' : 'size-7 rounded-md',
        danger ? 'hover:bg-error-500 hover:text-background' : 'hover:bg-adaptive-200 hover:text-adaptive-900'
      )}
    >
      {children}
    </button>
  )
}
