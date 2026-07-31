import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatArgv, parseArgv } from '@/domain/argv'
import { repoId, type RepoRef, type RunnableTask } from '@/domain/types'
import { api } from '@/ipc/commands'
import { IpcError } from '@/ipc/errors'
import { cn } from '@/lib/utils'
import { keys } from '@/queries/keys'

/**
 * Change what a repo's Run button actually executes.
 *
 * Overrides only tasks the repo already offers. That is not a UI convention — Rust
 * validates the task id against `runner::run_tasks` before it will store anything,
 * the same closed-set gate every other repo action holds. What is *not* validated
 * is the command itself, and cannot be: running something the detector would never
 * choose is the entire feature.
 *
 * The parsed tokens are shown under the field because splitting a line into an
 * argv is the lossy step, and it should be visible before Save rather than
 * discovered when the server fails to start.
 */
export function RunCommandDialog({
  open,
  onOpenChange,
  repo,
  tasks,
  initialTask,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repo: RepoRef
  /** `status.runnable` — the detected set, and the only thing selectable. */
  tasks: RunnableTask[]
  initialTask: string | null
}) {
  const qc = useQueryClient()
  const id = repoId(repo)
  const [task, setTask] = useState(initialTask ?? tasks[0]?.id ?? '')
  const [text, setText] = useState('')
  // Null until the preview lands, so an empty field cannot be mistaken for "the
  // user cleared the command".
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (open) setTask(initialTask ?? tasks[0]?.id ?? '')
  }, [open, initialTask, tasks])

  const preview = useQuery({
    queryKey: keys.runCommand(id, task),
    queryFn: () => api.previewRunCommand(repo, task),
    enabled: open && task.length > 0,
    staleTime: 30_000,
  })

  // Refill whenever the answer changes — opening, or switching task.
  useEffect(() => {
    setLoaded(false)
  }, [task])
  useEffect(() => {
    if (!preview.data || loaded) return
    setText(formatArgv(preview.data.overrideArgv ?? preview.data.defaultArgv))
    setLoaded(true)
  }, [preview.data, loaded])

  const parsed = useMemo(() => parseArgv(text), [text])
  const argv = 'argv' in parsed ? parsed.argv : null
  const defaultArgv = preview.data?.defaultArgv ?? []
  const isDefault = !!argv && formatArgv(argv) === formatArgv(defaultArgv)

  const save = useMutation({
    mutationFn: (next: string[] | null) => api.setRunCommand(repo, task, next),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.runCommand(id, task) })
      // Bootstrap carries a copy of the config; anything else reading it should
      // catch up rather than hold a version where this key is absent.
      void qc.invalidateQueries({ queryKey: keys.bootstrap })
      onOpenChange(false)
    },
    onError: (e: unknown) => {
      const msg = e instanceof IpcError || e instanceof Error ? e.message : String(e)
      toast.error('Could not save the run command', { description: msg })
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Run command</DialogTitle>
          <DialogDescription>
            What Run executes in <span className="font-mono">{repo.name}</span>. Applies at
            the next start — a server already up keeps the command it was started with.
          </DialogDescription>
        </DialogHeader>

        {tasks.length === 0 ? (
          <div className="text-xs text-adaptive-500">
            Nothing in this repo is runnable, so there is no command to override. A
            command can only replace a task the repo already offers.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {tasks.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-adaptive-500">Task</span>
                {tasks.map((t) => (
                  <Button
                    key={t.id}
                    variant={t.id === task ? 'waPrimary' : 'waOutline'}
                    size="waXs"
                    aria-pressed={t.id === task}
                    onClick={() => setTask(t.id)}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
            )}

            {preview.isPending ? (
              <Skeleton className="h-20 w-full" />
            ) : preview.error ? (
              <div className="text-xs text-sev-err">
                Could not resolve this task: {preview.error.message}
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-adaptive-500">Detected default</span>
                  <code className="truncate rounded-md border border-adaptive-200 bg-adaptive-50 px-2 py-1.5 font-mono text-[11.5px] text-adaptive-600">
                    {formatArgv(defaultArgv) || '—'}
                  </code>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-adaptive-500">Command</span>
                  <Input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    spellCheck={false}
                    className="h-[30px] font-mono text-xs"
                    aria-label="Run command"
                  />
                </div>

                {/* The argv as it will actually be passed. No shell is involved, so
                    `&&`, `$VAR` and globs arrive at the program verbatim — seeing
                    them as one token is how you find that out here rather than at
                    the next start. */}
                {'error' in parsed ? (
                  <div className="text-[11.5px] text-sev-err">{parsed.error}</div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1">
                    {argv!.length === 0 ? (
                      <span className="text-[11.5px] text-adaptive-500">
                        Empty — saving clears the override.
                      </span>
                    ) : (
                      argv!.map((a, i) => (
                        <span
                          key={`${i}-${a}`}
                          className={cn(
                            'rounded-sm border border-adaptive-200 px-1 font-mono text-[10.5px]',
                            i === 0 ? 'text-adaptive-900' : 'text-adaptive-500'
                          )}
                          title={i === 0 ? 'Program' : `Argument ${i}`}
                        >
                          {a === '' ? '∅' : a}
                        </span>
                      ))
                    )}
                  </div>
                )}

                <p className="text-[11px] text-adaptive-400">
                  Runs in <span className="font-mono">{preview.data?.cwd}</span>. The
                  command is not checked — it is passed to the program as-is, never
                  through a shell. A custom <span className="font-mono">--port</span> is
                  only picked up once the server prints it.
                </p>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="waGhost"
            size="waSm"
            disabled={!preview.data || isDefault}
            title="Go back to the command detected from this repo's files"
            onClick={() => setText(formatArgv(defaultArgv))}
          >
            Reset to default
          </Button>
          <Button variant="waOutline" size="waSm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="waPrimary"
            size="waSm"
            disabled={!argv || save.isPending || !preview.data}
            onClick={() => {
              if (!argv) return
              // Saving the default stores nothing. Pinning a command identical to
              // what the detector produces would silently freeze this repo against
              // every future improvement to the detector.
              save.mutate(isDefault || argv.length === 0 ? null : argv)
            }}
          >
            {isDefault ? 'Use the default' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
