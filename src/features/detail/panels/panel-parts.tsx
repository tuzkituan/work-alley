import type { ReactNode, Ref } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PanelShell, SectionLabel } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'

/**
 * One detail tab: a header that is always visible and a body that scrolls on its
 * own.
 *
 * The page used to have a single scroller wrapping everything, so switching to a
 * long tab pushed the tab strip off the top of the panel and there was no way back
 * without scrolling up through the whole list. `PanelShell` already solves this —
 * the old code just declared a private `Panel` that was `PanelShell` minus the
 * scrollport.
 */
export function TabPanel({
  icon,
  title,
  right,
  isFetching,
  onRefresh,
  actions,
  children,
  bodyRef,
}: {
  icon?: ReactNode
  title: ReactNode
  /** Extra header content, left of the spacer. */
  right?: ReactNode
  isFetching: boolean
  onRefresh: () => void
  /** A second header row, for per-tab action chips. */
  actions?: ReactNode
  children: ReactNode
  bodyRef?: Ref<HTMLDivElement>
}) {
  return (
    <PanelShell
      className="min-h-0 flex-1"
      bodyRef={bodyRef}
      header={
        <div className="flex-none border-b border-adaptive-200">
          <div className="flex items-center gap-2 px-3 py-2">
            {icon}
            <SectionLabel>{title}</SectionLabel>
            {right}
            <div className="flex-1" />
            {/* Rendered in every state on purpose. The PR tab used to return early
                on each failure, taking its Refresh button with it — so after
                running `gh auth login` in the terminal next door, the only way to
                retry was to close and reopen the page. */}
            <Button
              variant="waOutline"
              size="waXs"
              disabled={isFetching}
              title="Reload this tab"
              onClick={onRefresh}
            >
              <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-adaptive-200 px-3 py-1.5">
              {actions}
            </div>
          )}
        </div>
      }
    >
      {children}
    </PanelShell>
  )
}

export function PanelEmpty({ children }: { children: ReactNode }) {
  return <div className="p-4 text-xs text-adaptive-500">{children}</div>
}

/**
 * A failed query, said plainly.
 *
 * Its own component because three of the four panels had no error branch at all.
 * `ChangesPanel` did not even destructure `error`, so a failed IPC fell through to
 * `data ?? []` and rendered "The working tree is clean" — the most misleading
 * possible answer to "did that work?".
 */
export function PanelError({ what, message }: { what: string; message: string }) {
  return (
    <div className="p-4 text-xs text-sev-err">
      Could not load {what}.
      <div className="mt-1 font-mono text-[11px] break-all text-adaptive-400">{message}</div>
    </div>
  )
}

export function PanelSkeleton({ n, height = 'h-4' }: { n: number; height?: string }) {
  return (
    <div className="flex flex-col gap-2 p-3">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className={cn('w-full', height)} />
      ))}
    </div>
  )
}

/** A read-only inspection chip. These skip the confirm dialog, so one click runs. */
export function InspectChip({
  label,
  title,
  onClick,
}: {
  label: string
  title: string
  onClick: () => void
}) {
  return (
    <Button variant="waGhost" size="waXs" title={title} onClick={onClick}>
      {label}
    </Button>
  )
}
