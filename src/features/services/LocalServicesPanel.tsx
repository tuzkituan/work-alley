import { useQuery } from '@tanstack/react-query'
import { PanelShell, StatusDot } from '@/components/wa/primitives'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { useRunAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'
import { TONE_TEXT, type Tone } from '@/domain/severity'

export function LocalServicesPanel() {
  const run = useRunAction()

  const { data: status, isPending } = useQuery({
    queryKey: keys.docker,
    queryFn: () => api.dockerStatus(),
  })

  const { data: devServers } = useQuery({
    queryKey: keys.devServers,
    queryFn: () => api.listDevServers(),
  })

  const runtimeLabel =
    status && status.kind !== 'notInstalled' ? status.runtime : 'container runtime'

  return (
    <PanelShell
      title="Local services"
      right={
        <Button
          variant="waOutline"
          size="waXs"
          disabled={!status || status.kind === 'notInstalled'}
          onClick={() => run({ kind: 'dockerPs' })}
        >
          {runtimeLabel} ps
        </Button>
      }
      /* Capped only while the panels are stacked; side by side it fills the tab. */
      className="max-h-[320px] lg:max-h-none"
    >
      {isPending && (
        <div className="flex flex-col gap-2 p-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      )}

      {/* Absence is a state to render, not an error to throw. */}
      {status?.kind === 'notInstalled' && (
        <div className="p-3 text-xs text-adaptive-500">
          Neither docker nor podman is installed, so there are no containers to show.
        </div>
      )}
      {status?.kind === 'daemonDown' && (
        <div className="p-3 text-xs text-warning-500">
          {status.runtime} is installed but not responding.
          <div className="mt-1 font-mono text-[11px] text-adaptive-500">{status.message}</div>
        </div>
      )}
      {status?.kind === 'timedOut' && (
        <div className="p-3 text-xs text-warning-500">
          {status.runtime} did not respond within 3s — its socket may be wedged.
        </div>
      )}

      {status?.kind === 'ok' &&
        status.services.map((s) => {
          const tone: Tone = s.state === 'running' ? 'ok' : s.state === 'exited' ? 'err' : 'idle'
          const port = s.ports.find((p) => p.host !== null) ?? s.ports[0]
          return (
            <Row
              key={s.id || s.name}
              tone={tone}
              name={s.name}
              port={port ? `:${port.host ?? port.container}` : ''}
              state={s.status || s.state}
            />
          )
        })}

      {/* Dev servers we started ourselves belong in the same list. */}
      {(devServers ?? []).map((d) => (
        <Row
          key={d.runId}
          tone={d.state === 'up' ? 'ok' : d.state === 'crashed' ? 'err' : 'idle'}
          name={d.task === 'storybook' ? `${d.ref.name} (storybook)` : d.ref.name}
          port={d.port ? `:${d.port}` : ''}
          state={d.state}
        />
      ))}

      {status?.kind === 'ok' && status.services.length === 0 && (devServers ?? []).length === 0 && (
        <div className="p-3 text-xs text-adaptive-500">
          No containers and no dev servers are running.
        </div>
      )}
    </PanelShell>
  )
}

function Row({
  tone,
  name,
  port,
  state,
}: {
  tone: Tone
  name: string
  port: string
  state: string
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-adaptive-200 px-3 py-2 last:border-b-0">
      <StatusDot tone={tone} size={6} />
      <span className="flex-1 truncate font-mono text-xs text-adaptive-800">{name}</span>
      <span className="wa-num flex-none font-mono text-[11px] text-adaptive-400">{port}</span>
      <span
        className={cn('w-[68px] flex-none text-right text-[11px] font-semibold', TONE_TEXT[tone])}
        title={state}
      >
        <span className="block truncate">{state}</span>
      </span>
    </div>
  )
}
