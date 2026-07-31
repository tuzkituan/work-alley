import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { isValidBranchName } from '@/features/actions/checkout-policy'
import type { RepoId, RepoRef, WorkflowInput } from '@/domain/types'
import { useRunAction } from '@/hooks/use-action'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { PanelError } from './panels/panel-parts'

/**
 * Start a workflow by hand — GitHub's `workflow_dispatch`.
 *
 * The form is built from the workflow's own YAML, because that is the only place
 * the inputs exist: the REST API does not expose them, and `gh` parses the file
 * client-side to build its own prompt. Which is also why this is a dialog rather
 * than a button — a dispatch takes a ref and a field per declared input, each
 * with a type and often a default, and getting one wrong means deploying the
 * wrong thing.
 *
 * A workflow with no `workflow_dispatch:` trigger cannot be started at all. That
 * is GitHub's rule, not this app's, and the dialog says so rather than offering a
 * button that would fail.
 */
export function RunWorkflowDialog({
  open,
  onOpenChange,
  repo,
  id,
  /** `.github/workflows/deploy.yml`. */
  workflow,
  workflowName,
  /** The repo's current branch, as the default ref. */
  currentBranch,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repo: RepoRef
  id: RepoId
  workflow: string
  workflowName: string
  currentBranch: string | null
}) {
  const run = useRunAction()
  const [gitRef, setGitRef] = useState(currentBranch ?? '')
  const [values, setValues] = useState<Record<string, string>>({})

  const dispatch = useQuery({
    queryKey: keys.ghDispatch(id, workflow),
    queryFn: () => api.workflowDispatchInputs(repo, workflow),
    enabled: open,
    // The file changes when someone edits it, which is not while this is open.
    staleTime: 5 * 60_000,
  })

  const branches = useQuery({
    queryKey: keys.branches(id),
    queryFn: () => api.listBranches(repo),
    enabled: open,
    staleTime: 60_000,
  })

  const inputs = useMemo(
    () => (dispatch.data?.kind === 'ok' ? dispatch.data.inputs : []),
    [dispatch.data]
  )

  // Seed from the declared defaults each time the form appears, so reopening
  // after a mistake starts from the workflow's own answer rather than the last
  // one typed.
  useEffect(() => {
    if (!open) return
    setGitRef(currentBranch ?? '')
    setValues(Object.fromEntries(inputs.map((i) => [i.name, i.default])))
  }, [open, inputs, currentBranch])

  const refOk = gitRef.trim().length > 0 && isValidBranchName(gitRef)
  const missing = inputs.filter((i) => i.required && !values[i.name]?.trim())
  const canRun = dispatch.data?.kind === 'ok' && refOk && missing.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run {workflowName}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{workflow}</span>
          </DialogDescription>
        </DialogHeader>

        {dispatch.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : dispatch.error ? (
          <PanelError what="this workflow" message={dispatch.error.message} />
        ) : dispatch.data?.kind === 'notDispatchable' ? (
          <div className="text-xs text-adaptive-500">
            This workflow has no <span className="font-mono">workflow_dispatch:</span>{' '}
            trigger, so GitHub offers no way to start it by hand. A push, a pull request
            or a schedule is the only way in.
          </div>
        ) : dispatch.data?.kind === 'notAuthenticated' ? (
          <div className="text-xs text-adaptive-500">
            Not signed in to GitHub. Run <span className="font-mono">gh auth login</span>.
          </div>
        ) : dispatch.data?.kind === 'failed' ? (
          <PanelError what="this workflow" message={dispatch.data.message} />
        ) : (
          <div className="flex flex-col gap-3">
            <Field label="Ref" hint="The branch or tag to run on.">
              <div className="flex items-center gap-1.5">
                <Input
                  value={gitRef}
                  onChange={(e) => setGitRef(e.target.value)}
                  spellCheck={false}
                  aria-label="Ref"
                  className="h-[30px] font-mono text-xs"
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="waOutline" size="waIcon" title="Pick a branch">
                      <ChevronDown className="size-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
                    {(branches.data ?? []).map((b) => (
                      <DropdownMenuItem
                        key={b.name}
                        className="font-mono text-xs"
                        onClick={() => setGitRef(b.name)}
                      >
                        {b.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {!refOk && gitRef.length > 0 && (
                <span className="text-[11px] text-sev-err">Not a valid branch or tag name.</span>
              )}
            </Field>

            {inputs.map((i) => (
              <Field
                key={i.name}
                label={i.name + (i.required ? ' *' : '')}
                hint={i.description || undefined}
              >
                <InputControl
                  input={i}
                  value={values[i.name] ?? ''}
                  onChange={(v) => setValues((prev) => ({ ...prev, [i.name]: v }))}
                />
              </Field>
            ))}

            {inputs.length === 0 && (
              <div className="text-[11.5px] text-adaptive-500">
                This workflow takes no inputs.
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="waOutline" size="waSm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="waPrimary"
            size="waSm"
            disabled={!canRun}
            title={
              missing.length > 0
                ? `${missing.map((i) => i.name).join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`
                : undefined
            }
            onClick={() => {
              if (!canRun) return
              onOpenChange(false)
              run({
                kind: 'ghWorkflowRun',
                ref: repo,
                workflow,
                gitRef: gitRef.trim(),
                // Only what was actually filled in: an empty optional input sent
                // as "" is not the same as leaving it out, and GitHub applies the
                // declared default only for the latter.
                inputs: inputs
                  .map((i) => [i.name, values[i.name] ?? ''] as [string, string])
                  .filter(([, v]) => v.trim().length > 0),
              })
            }}
          >
            <Play className="size-3" />
            Run workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11.5px] font-semibold text-adaptive-800">{label}</span>
      {hint && <span className="text-[11px] text-adaptive-500">{hint}</span>}
      {children}
    </div>
  )
}

/** The control the declared type asks for — anything unknown is a text field. */
function InputControl({
  input,
  value,
  onChange,
}: {
  input: WorkflowInput
  value: string
  onChange: (v: string) => void
}) {
  if (input.kind === 'boolean') {
    return (
      <Switch
        checked={value === 'true'}
        // Sent as the literal strings GitHub expects, not as a JS boolean.
        onCheckedChange={(on) => onChange(on ? 'true' : 'false')}
      />
    )
  }

  if (input.kind === 'choice' && input.options.length > 0) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="waOutline" size="waSm" className="justify-between">
            <span className="truncate font-mono">{value || 'Choose…'}</span>
            <ChevronDown className="size-3 flex-none" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {input.options.map((o) => (
            <DropdownMenuItem key={o} className="font-mono text-xs" onClick={() => onChange(o)}>
              {o}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      type={input.kind === 'number' ? 'number' : 'text'}
      spellCheck={false}
      aria-label={input.name}
      className="h-[30px] font-mono text-xs"
    />
  )
}
