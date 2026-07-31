import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
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
import { usePlatform } from '@/hooks/use-platform'
import { StackPicker } from '@/features/stacks/StackPicker'

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
export function SetupPage({
  toolsReady,
  firstRun = false,
}: {
  toolsReady: boolean
  /**
   * This is a brand-new machine and the page is a takeover, not a place the user
   * navigated to. Changes the headline, drops the back arrow — there is nothing
   * behind it yet — and offers Done as the way out instead.
   */
  firstRun?: boolean
}) {
  const setPage = useUiStore((s) => s.setPage)
  const qc = useQueryClient()
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

  // Re-probe, then refetch. Its own pending flag because the probe runs two login
  // shells and `isFetching` only covers the query that follows it.
  const [rechecking, setRechecking] = useState(false)
  const recheck = async () => {
    setRechecking(true)
    try {
      await api.refreshToolchain()
    } catch {
      // Keep going: a failed probe leaves the last good one in place, and the
      // refetch below is still worth doing.
    } finally {
      setRechecking(false)
    }
    await refetch()
  }

  /**
   * Leaving setup for the app.
   *
   * Records onboarding as over on the way out, so a machine that is now set up does not
   * get asked again on the next launch — the routing predicate reads that flag.
   *
   * One function for both exits. There were two identical copies, one named `skip`,
   * from when leaving early was meant to be a different thing from finishing. It
   * never was: the takeover is asked once either way, so both mark it done.
   */
  const finish = async () => {
    try {
      const b = await api.completeOnboarding()
      qc.setQueryData(keys.bootstrap, b)
    } catch {
      // Worst case is being asked once more; not worth blocking the exit.
    }
    setPage('repos')
  }

  // Which step's output to show, derived from the action that actually started
  // rather than from a click: pressing Install only opens the confirmation dialog,
  // and cancelling it must leave no trace. Also keeps one step from claiming
  // another's log — there is a single newest run.
  const lastRan = useActionStore((s) => s.lastRan)

  return (
    // A pinned header above a scrolling body, rather than a `sticky` row inside the
    // scroller. Sticky was tried first and left a gap down either side: the row lived
    // inside the `max-w-[64rem]` column, so the page's own horizontal padding — and,
    // on a wide window, everything outside that column — was not covered by its
    // background, and the step cards scrolled visibly through the strip. Out here its
    // background is the full width of the page, with the same column applied to its
    // contents.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-adaptive-200 bg-background px-4 py-3">
        <div className="mx-auto flex w-full max-w-[64rem] items-center gap-2">
          {/* No back arrow on a first run: there is nothing behind this screen, and a
              dead control is worse than none. */}
          {!firstRun && (
            <Button
              variant="waGhost"
              size="waIcon"
              onClick={() => setPage('repos')}
              title="Back to the workspace"
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <h1 className="text-base font-semibold tracking-[-0.01em]">
            {firstRun ? 'Welcome — let’s set this machine up' : 'Set up this machine'}
          </h1>
          {required.length > 0 && (
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {doneCount}/{required.length} required
            </span>
          )}
          <div className="flex-1" />
          {/* "Done", not "Skip for now": leaving this screen *is* completing
              onboarding, run or not. A takeover that returns tomorrow is one you
              learn to dismiss rather than read, so it is asked once — and the warning
              bar on the dashboard is the ongoing signal for anything still missing.
              Primary, because on a takeover screen the way out should not be the
              quietest control on the row. */}
          {firstRun && (
            <Button
              variant="waPrimary"
              size="waXs"
              title="Go to the app. Anything still missing shows in a bar at the bottom."
              onClick={() => void finish()}
            >
              Done
            </Button>
          )}
          {/* The steps below are filtered by this, so it leads them. On a machine
              that only does web, a Flutter step is not an optional extra — it is
              noise in a list whose whole job is "what is left to do". */}
          <StackPicker />
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
            disabled={isFetching || rechecking}
            // Re-probes *before* refetching. Without that this button refetched a
            // plan built from the toolchain as it was at launch, so pressing it after
            // installing Node changed nothing and the next step stayed blocked.
            onClick={() => void recheck()}
          >
            <RefreshCw className={cn('size-3', (isFetching || rechecking) && 'animate-spin')} />
            Re-check
          </Button>
        </div>
      </div>

      <div className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-3.5">
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
              {allRequiredDone && <Finished onOpen={() => void finish()} />}
            </>
          )}
        </div>
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
      {/* The thing that surprises people, said once here rather than on every step:
          where the output goes, and that the password prompt is in there. */}
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
    // One column. This was multi-column to fit the steps on a wide screen, but a
    // numbered sequence read across two columns is the one layout that makes "what
    // do I do next" ambiguous — and unlike the Toolbox's flat list, order is the
    // whole point of this page.
    <div className="flex flex-col gap-3.5">
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

  // Arrived here from a missing-tool toast: scroll to the step that installs it and
  // ring it, once. Cleared immediately so it does not fire again on the next render or
  // survive into a later visit.
  const focused = useUiStore((s) => s.setupFocusStepId) === step.id
  const clearFocus = useUiStore((s) => s.clearSetupFocus)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focused) return
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    clearFocus()
  }, [focused, clearFocus])

  return (
    <div
      ref={ref}
      className={cn(
        // The list is a flex column now, so its gap does the spacing — the margin
        // and break-inside-avoid this used to carry were for the multi-column
        // layout it no longer has.
        'flex flex-col gap-2.5 rounded-lg border bg-card p-3.5',
        current || focused ? 'border-adaptive-950 shadow-focus-ring' : 'border-adaptive-200'
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

        {/* Neither of these has a command of its own — identity is a form, and
            credentials are two alternative routes the user picks between. */}
        {step.kind !== 'gitIdentity' && step.kind !== 'credentials' && (
          <StepButton
            step={step}
            blocked={blocked}
            onRun={() => run({ kind: 'setupStep', id: step.id })}
          />
        )}
      </div>

      <Items items={step.items} manager={step.manager} />

      {step.kind === 'gitIdentity' && <GitIdentityForm step={step} plan={plan} />}
      {step.kind === 'credentials' && <CredentialsCard step={step} plan={plan} />}

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

  // What is actually left, so a part-finished group says so. A step called "GitHub
  // CLI" with gh already installed showed a bare "Install", which reads as "gh is
  // missing" when the only outstanding item is something else in the group.
  const missing = step.items.filter((i) => !i.installed && i.available)
  const label = step.done
    ? 'Re-run'
    : missing.length > 0 && missing.length < step.items.length
      ? `Install ${missing.map((i) => i.label).join(', ')}`
      : 'Install'

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
      <span className="max-w-40 truncate">{label}</span>
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
 * The one step with two routes and no command of its own.
 *
 * Detection plus instructions, deliberately: running `ssh-keygen` would mean owning a
 * passphrase prompt and `gh auth login` a browser handoff, and neither belongs in this
 * app. What it *does* do is tell you which of the two you already have, which is the
 * part nothing did before — the old signal was a warning saying "start an ssh-agent and
 * relaunch", which is not something a new user can act on.
 */
/**
 * `ssh-add` with a path the platform's own shell will accept.
 *
 * Windows keeps the agent as a service that ships *disabled*, so the command that
 * fails there fails for a different reason than a missing key — which is why the step
 * note names `Start-Service ssh-agent` rather than repeating this.
 */
function sshAddCommand(windows: boolean) {
  return windows
    ? 'ssh-add $env:USERPROFILE\\.ssh\\id_ed25519'
    : 'ssh-add ~/.ssh/id_ed25519'
}

function CredentialsCard({
  step,
  plan,
}: {
  step: SetupStepStatus
  plan: SetupPlan | undefined
}) {
  const ssh = step.items.find((i) => i.id === 'ssh')
  const gh = step.items.find((i) => i.id === 'gh')
  const done = step.done
  const windows = usePlatform() === 'windows'

  // The email git already knows about, so the key comment matches the commits.
  const email = plan?.gitEmail?.trim() || 'you@example.com'
  // A key on disk that the agent is not holding: the fix is `ssh-add`, not keygen.
  const stranded = ssh?.label.includes('not in the agent') ?? false

  if (done) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-success-500/40 bg-green-500/[0.08] px-2.5 py-1.5 text-[11.5px] text-sev-ok">
        <Check className="size-3 flex-none" />
        {gh?.installed ? gh.label : (ssh?.label ?? 'ready')} — cloning will authenticate.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] text-adaptive-500">
        Either one is enough. Run it in a terminal — the app does not do this for you,
        because both prompt for things a window cannot ask for.
      </span>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(20rem,100%),1fr))]">
        <CommandRoute
          title={stranded ? 'Load your existing key' : 'Create an SSH key'}
          commands={
            stranded
              ? [sshAddCommand(windows)]
              : [
                  `ssh-keygen -t ed25519 -C "${email}"`,
                  sshAddCommand(windows),
                  // `cat` is not a PowerShell command, and the separator differs.
                  windows
                    ? 'Get-Content $env:USERPROFILE\\.ssh\\id_ed25519.pub'
                    : 'cat ~/.ssh/id_ed25519.pub',
                ]
          }
          hint={
            stranded
              ? 'The key exists; the agent just is not holding it.'
              : 'Then paste the printed key at github.com/settings/keys.'
          }
        />
        <CommandRoute
          title="Or sign in with the GitHub CLI"
          commands={['gh auth login']}
          hint={
            step.blocked
              ? 'Needs the GitHub CLI from the step above.'
              : 'Opens a browser, and covers HTTPS clones and the pull-request list.'
          }
        />
      </div>
    </div>
  )
}

/** One route: a copyable command block and a line saying what it gets you. */
function CommandRoute({
  title,
  commands,
  hint,
}: {
  title: string
  commands: string[]
  hint: string
}) {
  const [copied, setCopied] = useState(false)
  const text = commands.join('\n')

  return (
    <div className="flex flex-col gap-1 rounded-md border border-adaptive-200 bg-adaptive-100 p-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11.5px] font-semibold">{title}</span>
        <button
          type="button"
          title="Copy to the clipboard"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => {})
          }}
          className="flex flex-none items-center gap-1 text-[10.5px] text-adaptive-500 hover:text-adaptive-900"
        >
          {copied ? <Check className="size-2.5" /> : <Copy className="size-2.5" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto font-mono text-[11px] whitespace-pre text-adaptive-800">
        {text}
      </pre>
      <span className="text-[10.5px] leading-[1.4] text-adaptive-500">{hint}</span>
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
        // The inputs beside it are 30px, and a 26px button on the same baseline as
        // two full-height fields reads as an afterthought rather than as the thing
        // that commits them. `min-w` so it does not resize between Save and Saved.
        size="wa"
        className="min-w-[5.5rem]"
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
          Nothing to restart — the toolchain is re-resolved after every step.
        </span>
      </div>
      <Button variant="waPrimary" size="wa" onClick={onOpen}>
        Open a workspace
        <ArrowRight className="size-3.5" />
      </Button>
    </div>
  )
}
