import type { ReactNode } from 'react'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { MachineTerminalDock, useHasMachineTerminals } from '@/features/terminal/MachineTerminalDock'

/**
 * The frame the machine-scoped pages share: a page above, the install terminal below.
 *
 * Extracted so first-run onboarding gets it too, and that is load-bearing rather than
 * tidiness. Installs run in a pty tab, and a system package prompts for a **sudo
 * password in that tab** — a takeover screen without this split would sit there
 * looking hung, waiting on a prompt the user cannot see.
 */
export function MachinePage({ children }: { children: ReactNode }) {
  const hasMachineTerms = useHasMachineTerminals()

  // Split only once something is running: installs happen in a terminal tab, and
  // until the first one opens the page should have the whole window. Resizable rather
  // than a fixed strip — a dnf transaction is a lot of output, and a sudo prompt has
  // to be readable.
  if (!hasMachineTerms) return <>{children}</>

  return (
    <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
      <ResizablePanel id="machine-page" minSize="180px">
        {/* The flex context the page's own `min-h-0 flex-1` scroller needs; outside
            the split it gets that from the window column. */}
        <div className="flex h-full min-h-0 flex-col">{children}</div>
      </ResizablePanel>
      <ResizableHandle className="hover:bg-primary data-[dragging]:bg-primary" />
      <ResizablePanel id="machine-term" defaultSize="340px" minSize="140px">
        <MachineTerminalDock />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
