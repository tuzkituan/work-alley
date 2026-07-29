import { Terminal } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/wa/primitives'
import { api } from '@/ipc/commands'
import { runScope, useRunStore } from '@/stores/run-store'
import { useUiStore } from '@/stores/ui-store'
import { displayName } from '@/domain/severity'
import type { Tone } from '@/domain/severity'

/**
 * How many terminals are open, and which.
 *
 * Necessary once output became per-repo: a run in another repo's scope is
 * invisible from where you are standing, so the count has to live somewhere
 * always on screen. Selecting an entry jumps to that scope.
 */
export function TerminalsMenu() {
  const runs = useRunStore((s) => s.runs)
  const order = useRunStore((s) => s.order)
  const setActive = useRunStore((s) => s.setActive)
  const setActiveRepo = useUiStore((s) => s.setActiveRepo)

  const all = order.map((id) => runs.get(id)).filter((r): r is NonNullable<typeof r> => !!r)
  const running = all.filter((r) => r.summary.status.kind === 'running')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={running.length > 0 ? 'waPrimary' : 'waOutline'}
          size="wa"
          title={`${running.length} running, ${all.length} terminal${all.length === 1 ? '' : 's'} open`}
        >
          <Terminal className="size-3.5" />
          <span className="wa-num">
            {running.length > 0 ? `${running.length}/${all.length}` : all.length}
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-[11px] font-semibold">
          {all.length === 0
            ? 'No terminals open'
            : `${running.length} running · ${all.length} open`}
        </DropdownMenuLabel>

        {all.length > 0 && <DropdownMenuSeparator />}

        {all
          .slice()
          .reverse()
          .map((r) => {
            const scope = runScope(r)
            const label = scope ? displayName(scope.split('/')[1] ?? scope).short : 'workspace'
            const st = r.summary.status
            const tone: Tone =
              st.kind === 'running'
                ? 'info'
                : st.kind === 'exited'
                  ? st.code === 0
                    ? 'ok'
                    : 'warn'
                  : st.kind === 'failed'
                    ? 'err'
                    : 'idle'
            return (
              <DropdownMenuItem
                key={r.runId}
                onClick={() => {
                  if (scope) setActiveRepo(scope)
                  setActive(r.runId)
                }}
              >
                <StatusDot tone={tone} size={6} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono text-[11px] text-adaptive-500">{label}</span>{' '}
                  {r.summary.kind}
                </span>
                {st.kind === 'running' && (
                  <button
                    type="button"
                    className="font-mono text-[10px] text-adaptive-400 hover:text-error-500"
                    onClick={(e) => {
                      e.stopPropagation()
                      void api.cancelRun(r.runId).catch(() => {})
                    }}
                  >
                    cancel
                  </button>
                )}
              </DropdownMenuItem>
            )
          })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
