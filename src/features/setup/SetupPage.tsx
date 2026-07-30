import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  RefreshCw,
  Terminal,
  Wrench,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { SectionLabel } from '@/components/wa/primitives'
import { useUiStore } from '@/stores/ui-store'
import { useRunStore } from '@/stores/run-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { useActionStore, useRunAction } from '@/hooks/use-action'
import { SEVERITY_CLASS } from '@/features/output/severity-class'
import type { ActionSpec, SetupPlan, SetupStepStatus } from '@/domain/types'

/** Whether the action that last started belongs to this step. */
function isRunning(lastRan: ActionSpec | null, step: SetupStepStatus): boolean {
  if (!lastRan) return false
  if (lastRan.kind === 'setupStep') return lastRan.id === step.id
  // The identity step's action carries values rather than a step id, so it is
  // matched on the kind — there is only ever one such step.
  return lastRan.kind === 'gitIdentity' && step.kind === 'gitIdentity'
}

/**
 * First-run setup for a machine that has nothing on it.
 *
 * The Toolbox already installs any one tool. What a fresh Fedora or Ubuntu install
 * needs is different and harder: an *order*. The dependencies between these tools
 * are real and invisible — npm packages need Node, Node comes from nvm, nvm is
 * downloaded with curl — so this page is a sequence, each step says why it is where
 * it is, and a step that cannot run yet says what to do first instead of failing
 * halfway through a command.
 *
 * Each step also batches its installs into one command, which on a distribution
 * that needs root means one password prompt for five tools rather than five.
 *
 * Machine-scoped, like the Toolbox: a full-window page that works before any
 * workspace exists, which is exactly when it is needed.
 */
export function SetupPage({ toolsReady }: { toolsReady: boolean }) {
  const setPage = useUiStore((s) => s.setPage)
  const { data, isPending, isFetching, refetch } = useQuery({
    queryKey: keys.setupPlan,
    queryFn: () => api.listSetupPlan(),
    // Detection resolves paths through the toolchain; before the probe lands every
    // installed tool reports as missing.
    enabled: toolsReady,
    staleTime: 30_000,
    // The exception to the app-wide default. Installs run in a terminal tab and
    // can leave the window (a browser sign-in, a manual step), so coming back is a
    // moment the answers may have changed.
    refetchOnWindowFocus: true,
  })

  const required = (data?.steps ?? []).filter((s) => !s.optional)
  const doneCount = required.filter((s) => s.done).length
  const allRequiredDone = required.length > 0 && doneCount === required.length

  // The step to nudge: the first unfinished required one. Optional steps never
  // become "current" — nothing is waiting on them.
  const currentId = required.find((s) => !s.done)?.id ?? null

  // Which step's output to show, derived from the action that actually started
  // rather than from a click: pressing Install only opens the confirmation dialog,
  // and cancelling it must leave no trace. Also keeps one step from claiming
  // another's log — there is a single newest run.
  const lastRan = useActionStore((s) => s.lastRan)

  return (
    <div className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
      <div className="mx-auto flex w-full max-w-[104rem] flex-col gap-3.5">
        <div className="flex items-center gap-2">
          <Button
            variant="waGhost"
            size="waIcon"
            onClick={() => setPage('repos')}
            title="Back to the workspace"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold tracking-[-0.01em]">Set up this machine</h1>
          {required.length > 0 && (
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {doneCount}/{required.length} required
            </span>
          )}
          <div className="flex-1" />
          <Button
            variant="waOutline"
            size="waXs"
            onClick={() => setPage('toolbox')}
            title="Every tool, one at a time"
          >
            <Wrench className="size-3" />
            Toolbox
          </Button>
          <Button
            variant="waOutline"
            size="waXs"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} />
            Re-check
          </Button>
        </div>

        <Intro plan={data} />

        {!toolsReady ? (
          <div className="rounded-lg border border-adaptive-200 bg-card p-4 text-xs text-adaptive-500">
            Resolving your toolchain…
          </div>
        ) : isPending ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        ) : (
          <>
            <StepList
              steps={data?.steps ?? []}
              currentId={currentId}
              plan={data}
              lastRan={lastRan}
            />
            {allRequiredDone && <Finished onOpen={() => setPage('repos')} />}
          </>
        )}
      </div>
    </div>
  )
}

function Intro({ plan }: { plan: SetupPlan | undefined }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-adaptive-200 bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>This machine</SectionLabel>
        <span className="text-[12px] text-adaptive-700">{plan?.osLabel ?? '…'}</span>
        {plan?.packageManager ? (
          <span className="rounded-sm border border-adaptive-200 px-1 font-mono text-[10px] text-adaptive-400">
            {plan.packageManager}
          </span>
        ) : (
          plan && (
            <span className="text-[11px] text-sev-warn">
              no system package manager found
            </span>
          )
        )}
      </div>
      {/* The two things that surprise people, said once here rather than on every
          step: where the output goes, and why nvm needs a restart. */}
      <p className="max-w-prose text-xs text-adaptive-500">
        Work through these in order — each one assumes the ones above it. Every step
        runs in a terminal at the bottom of this page, which is also where you type
        your password when a system package needs root. Every command is shown before
        it runs, and nothing runs until you accept it.
      </p>
    </div>
  )
}

function StepList({
  steps,
  currentId,
  plan,
  lastRan,
}: {
  steps: SetupStepStatus[]
  currentId: string | null
  plan: SetupPlan | undefined
  lastRan: ActionSpec | null
}) {
  return (
    // Staggered columns, same as the Toolbox — steps range from two lines to a
    // whole command preview, so grid rows left large holes.
    //
    // Multi-column happens to suit ordered content better than a grid would: it
    // fills a column top to bottom before starting the next, so the steps still
    // read 1, 2, 3 downwards rather than zig-zagging across rows. The numbers on
    // the cards carry the order either way.
    <div className="columns-[34rem] gap-4">
      {steps.map((step, i) => (
        <StepCard
          key={step.id}
          step={step}
          index={i + 1}
          current={step.id === currentId}
          plan={plan}
          launched={isRunning(lastRan, step)}
        />
      ))}
    </div>
  )
}

function StepCard({
  step,
  index,
  current,
  plan,
  launched,
}: {
  step: SetupStepStatus
  index: number
  current: boolean
  plan: SetupPlan | undefined
  launched: boolean
}) {
  const run = useRunAction()
  const blocked = step.blocked !== null
  const command = step.commandPreview.join(' ')

  return (
    <div
      className={cn(
        // mb + break-inside-avoid: this card is a multi-column item in StepList,
        // and a step split across a column boundary is unreadable.
        'mb-2 flex break-inside-avoid flex-col gap-2.5 rounded-lg border bg-card p-3.5',
        current ? 'border-adaptive-950 shadow-focus-ring' : 'border-adaptive-200'
      )}
    >
      <div className="flex items-start gap-3">
        <StepBadge index={index} done={step.done} />

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-semibold">{step.title}</span>
            <span className="rounded-sm border border-adaptive-200 px-1 font-mono text-[10px] text-adaptive-400">
              {step.manager}
            </span>
            {step.needsRoot && (
              <span
                className="flex items-center gap-1 text-[10px] text-adaptive-400"
                title="Runs in the terminal below, where you can enter your password"
              >
                <Terminal className="size-2.5" />
                root
              </span>
            )}
            {step.optional && (
              <span className="text-[10px] text-adaptive-400">optional</span>
            )}
          </div>

          <span className="text-[12px] text-adaptive-700">{step.summary}</span>
          <p className="max-w-prose text-[11.5px] leading-[1.5] text-adaptive-500">
            {step.why}
          </p>
        </div>

        {step.kind !== 'gitIdentity' && (
          <StepButton
            step={step}
            blocked={blocked}
            onRun={() => run({ kind: 'setupStep', id: step.id })}
          />
        )}
      </div>

      <Items items={step.items} manager={step.manager} />

      {step.kind === 'gitIdentity' ? (
        <GitIdentityForm step={step} plan={plan} />
      ) : null}

      {blocked && (
        <div className="rounded-md border border-adaptive-200 bg-adaptive-100 px-2.5 py-1.5 text-[11px] text-sev-warn">
          {step.blocked}
        </div>
      )}

      {step.note && (
        <p className="max-w-prose text-[11px] leading-[1.5] text-adaptive-500">
          <span className="font-semibold text-adaptive-700">Note </span>
          {step.note}
        </p>
      )}

      {command && !blocked && (
        // Shown up front, not hidden behind the confirm dialog: "curl | bash" is a
        // thing people are right to want to read before agreeing to it.
        <pre className="wa-scroll overflow-x-auto rounded-md border border-adaptive-200 bg-adaptive-100 px-2.5 py-1.5 font-mono text-[10.5px] leading-[1.6] text-adaptive-600">
          $ {command}
        </pre>
      )}

      {launched && <StepOutput needsRoot={step.needsRoot} />}
    </div>
  )
}

function StepBadge({ index, done }: { index: number; done: boolean }) {
  return (
    <span
      className={cn(
        'mt-0.5 flex size-[22px] flex-none items-center justify-center rounded-full text-[11px] font-semibold',
        done
          ? 'bg-sev-ok text-background'
          : 'border border-adaptive-300 text-adaptive-500'
      )}
    >
      {done ? <Check className="size-3" /> : <span className="wa-num font-mono">{index}</span>}
    </span>
  )
}

function StepButton({
  step,
  blocked,
  onRun,
}: {
  step: SetupStepStatus
  blocked: boolean
  onRun: () => void
}) {
  const unavailable = step.items.length > 0 && step.items.every((i) => !i.available)

  if (unavailable) {
    return (
      <span
        className="flex-none text-[11px] text-sev-warn"
        title={`Not available through ${step.manager} on this machine`}
      >
        unavailable
      </span>
    )
  }

  return (
    <Button
      variant={step.done ? 'waOutline' : 'waPrimary'}
      size="waXs"
      className="flex-none"
      disabled={blocked || step.commandPreview.length === 0}
      onClick={onRun}
      title={step.done ? 'Run it again' : `Install ${step.title}`}
    >
      {step.done ? (
        <RefreshCw className="size-3" />
      ) : (
        <Download className="size-3" />
      )}
      {step.done ? 'Re-run' : 'Install'}
    </Button>
  )
}

function Items({ items, manager }: { items: SetupStepStatus['items']; manager: string }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {items.map((item) => (
        <span
          key={item.id}
          className="flex items-center gap-1.5 text-[11.5px]"
          title={
            item.available
              ? undefined
              : `${manager} does not package ${item.label} — this one is skipped`
          }
        >
          <span
            className={cn(
              'size-1.5 flex-none rounded-full',
              item.installed
                ? 'bg-sev-ok'
                : item.available
                  ? 'bg-adaptive-300'
                  : 'bg-sev-warn'
            )}
          />
          <span className={item.installed ? 'text-adaptive-700' : 'text-adaptive-500'}>
            {item.label}
          </span>
          {item.version && (
            <span className="wa-num font-mono text-[10.5px] text-adaptive-400">
              {item.version}
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

/**
 * The one step that takes input.
 *
 * Prefilled from the global config so it doubles as a display of what is already
 * set — the common case on a machine that has been used before is "these are
 * right, move on", and that should need no typing.
 */
function GitIdentityForm({
  step,
  plan,
}: {
  step: SetupStepStatus
  plan: SetupPlan | undefined
}) {
  const run = useRunAction()
  const [name, setName] = useState(plan?.gitName ?? '')
  const [email, setEmail] = useState(plan?.gitEmail ?? '')

  const clean = { name: name.trim(), email: email.trim() }
  const valid = clean.name.length > 0 && clean.email.includes('@')
  const unchanged = clean.name === (plan?.gitName ?? '') && clean.email === (plan?.gitEmail ?? '')

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
        <span className="text-[10px] font-semibold tracking-[0.06em] text-adaptive-500 uppercase">
          Name
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ada Lovelace"
          className="h-[30px] text-xs"
        />
      </label>
      <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
        <span className="text-[10px] font-semibold tracking-[0.06em] text-adaptive-500 uppercase">
          Email
        </span>
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="ada@example.com"
          className="h-[30px] text-xs"
        />
      </label>
      <Button
        variant={step.done && unchanged ? 'waOutline' : 'waPrimary'}
        size="waXs"
        disabled={!valid || step.blocked !== null || (step.done && unchanged)}
        onClick={() => run({ kind: 'gitIdentity', name: clean.name, email: clean.email })}
        title="Writes user.name and user.email to your global git config"
      >
        {step.done && unchanged ? 'Saved' : 'Save'}
      </Button>
    </div>
  )
}

/**
 * What this step's operation is doing.
 *
 * Installs run in the integrated terminal at the bottom of this page, so their
 * state comes from the terminal tab rather than from a run: there is no log to
 * tail, and the real output is already on screen a few hundred pixels below. The
 * run-store path below it still serves the identity step, which is a plain
 * `git config` and streams like any other command.
 */
function StepOutput({ needsRoot }: { needsRoot: boolean }) {
  const term = useTerminalStore((s) => {
    for (let i = s.order.length - 1; i >= 0; i--) {
      const t = s.tabs.get(s.order[i]!)
      if (t?.kind === 'package') return t
    }
    return undefined
  })
  const runId = useRunStore((s) => {
    for (let i = s.order.length - 1; i >= 0; i--) {
      const id = s.order[i]!
      const kind = s.runs.get(id)?.summary.kind
      if (kind === 'package' || kind === 'gitIdentity') return id
    }
    return null
  })
  const run = useRunStore((s) => (runId ? s.runs.get(runId) : undefined))

  if (term) {
    const live = term.status === 'live'
    return (
      <div className="flex items-center gap-2 rounded-md border border-adaptive-200 bg-adaptive-100 px-2.5 py-1.5 text-[11px] text-adaptive-600">
        <Terminal className="size-3 flex-none" />
        {live
          ? needsRoot
            ? 'Running in the terminal below — enter your password there.'
            : 'Running in the terminal below.'
          : term.exitCode === 0
            ? 'Finished — press Re-check.'
            : `Exited with code ${term.exitCode ?? '?'} — the terminal below has why.`}
      </div>
    )
  }

  // Between pressing the button and the session opening there is a beat, and on a
  // root step that beat is where the password prompt is about to appear.
  if (needsRoot && !run) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-adaptive-200 bg-adaptive-100 px-2.5 py-1.5 text-[11px] text-adaptive-600">
        <Terminal className="size-3 flex-none" />
        Opening a terminal for the password prompt…
      </div>
    )
  }

  if (!run) return null

  const status = run.summary.status
  const running = status.kind === 'running'
  const tail = run.lines.slice(-8)

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-adaptive-200 bg-adaptive-100 px-2.5 py-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className={cn(
            'size-1.5 flex-none rounded-full',
            running
              ? 'animate-pulse bg-sev-info'
              : status.kind === 'exited' && status.code === 0
                ? 'bg-sev-ok'
                : 'bg-sev-err'
          )}
        />
        <span className="text-adaptive-600">
          {running
            ? 'Running…'
            : status.kind === 'exited' && status.code === 0
              ? 'Finished'
              : 'Did not finish — the output pane has the whole log.'}
        </span>
      </div>
      {tail.length > 0 && (
        <pre className="wa-scroll max-h-32 overflow-auto font-mono text-[10.5px] leading-[1.55]">
          {tail.map((line) => (
            <div key={line.seq} className={SEVERITY_CLASS[line.severity]}>
              {line.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

function Finished({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-adaptive-200 bg-card p-3.5">
      <span className="flex size-[22px] flex-none items-center justify-center rounded-full bg-sev-ok text-background">
        <Check className="size-3" />
      </span>
      <div className="flex min-w-[14rem] flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold">Everything required is installed</span>
        <span className="text-[11.5px] text-adaptive-500">
          Restart Work Alley if you just installed nvm or Bun — both live in your shell
          profile, and the toolchain is resolved at launch.
        </span>
      </div>
      <Button variant="waPrimary" size="wa" onClick={onOpen}>
        Open a workspace
        <ArrowRight className="size-3.5" />
      </Button>
    </div>
  )
}
