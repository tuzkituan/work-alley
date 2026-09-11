import { create } from 'zustand'
import { toast } from 'sonner'
import { api } from '@/ipc/commands'
import { IpcError } from '@/ipc/errors'
import { toolFix } from '@/domain/tool-fix'
import { useManagerStore } from '@/stores/manager-store'
import { useRunStore } from '@/stores/run-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useUiStore } from '@/stores/ui-store'
import { repoId, type ActionIntent, type ActionSpec } from '@/domain/types'

/**
 * The single funnel for every action. No component calls `run_action` directly.
 *
 * Read-only inspections (`status`, `branchList`, `prList`, `dockerPs`) skip the
 * dialog and run immediately — the intent still comes from `prepare_action`, so
 * there is exactly one code path.
 */
interface ActionState {
  intent: ActionIntent | null
  spec: ActionSpec | null
  pending: boolean
  submitting: boolean
  /** Guards against a double-click firing run_action twice. */
  consumed: Set<string>
  /**
   * The last spec that actually started, so a page can react to "this one is under
   * way" rather than to "the button was pressed".
   *
   * The two are not the same thing: pressing a button only opens the confirmation
   * dialog, and the user can still cancel it or the run can fail to start. The setup
   * page announced "a terminal window opened" from the click, which it said while
   * the dialog was still sitting there unanswered.
   */
  lastRan: ActionSpec | null

  request(spec: ActionSpec): Promise<void>
  /** Re-prepares the open intent with a different package manager. */
  pickManager(manager: string | null): Promise<void>
  recheck(): Promise<void>
  confirm(typedConfirm?: string): Promise<void>
  dismiss(): void
}

export const useActionStore = create<ActionState>()((set, get) => ({
  intent: null,
  spec: null,
  pending: false,
  submitting: false,
  consumed: new Set(),
  lastRan: null,

  request: async (spec) => {
    set({ pending: true })
    try {
      const intent = await api.prepareAction(spec)

      if (intent.readOnly || intent.autoConfirm) {
        // `readOnly` mutates nothing, so there is nothing to confirm. `autoConfirm`
        // does mutate, and Rust has said this particular write does not warrant a
        // dialog: a PR comment or an approve, where the click is the decision.
        // Rust decides which; see `runs_without_confirmation`. Everything else
        // about the gate is unchanged, including that this id is single use.
        armFocus(intent.kind)
        await api.runAction(intent.id)
        set({ pending: false, lastRan: spec })
        return
      }

      set({ intent, spec, pending: false })
    } catch (e) {
      set({ pending: false })
      reportError(e)
    }
  },

  /**
   * Swaps the package manager on the intent currently being confirmed.
   *
   * Here rather than in the components that start these actions, because that is
   * five places and this is one — and it is the one place where the manager is
   * actually visible, spelled out in the argv the dialog is asking you to approve.
   *
   * Also remembered for the repo, so the next Run or script in it agrees with what
   * was chosen here rather than reverting to the detected manager.
   */
  pickManager: async (manager) => {
    const spec = get().spec
    if (!spec) return
    if (spec.kind !== 'runScript' && spec.kind !== 'devStart' && spec.kind !== 'runChore') return

    useManagerStore.getState().set(repoId(spec.ref), manager)
    const next = { ...spec, manager: manager ?? undefined } as ActionSpec

    set({ pending: true })
    try {
      // A fresh intent, not an edited one: argv is resolved in Rust and the whole
      // point of the gate is that the frontend cannot compose what runs.
      const intent = await api.prepareAction(next)
      set({ intent, spec: next, pending: false })
    } catch (e) {
      set({ pending: false })
      reportError(e)
    }
  },

  recheck: async () => {
    const spec = get().spec
    if (!spec) return
    set({ pending: true })
    try {
      // Re-prepared, never silently reused: repo state may have changed while the
      // dialog sat open, so the warnings must be recomputed.
      const intent = await api.prepareAction(spec)
      set({ intent, pending: false })
    } catch (e) {
      set({ pending: false })
      reportError(e)
    }
  },

  confirm: async (typedConfirm) => {
    const { intent, spec, consumed } = get()
    if (!intent || consumed.has(intent.id) || get().submitting) return

    set({ submitting: true })
    try {
      armFocus(intent.kind)
      await api.runAction(intent.id, typedConfirm)
      consumed.add(intent.id)
      set({ intent: null, spec: null, submitting: false, lastRan: spec })
    } catch (e) {
      set({ submitting: false })
      if (e instanceof IpcError && e.code === 'INTENT_EXPIRED') {
        // Expiry can also land mid-flight. Same recovery path as the countdown
        // hitting zero — re-prepare rather than just toasting.
        toast.warning('That confirmation expired', {
          description: 'Re-checking the current state…',
        })
        await get().recheck()
        return
      }
      reportError(e)
    }
  },

  dismiss: () => {
    const intent = get().intent
    if (intent) void api.cancelAction(intent.id).catch(() => {})
    set({ intent: null, spec: null, submitting: false })
  },
}))

/**
 * Kinds that produce neither a run nor a pty tab: they stop something, or hand the
 * work to a window outside this app. Nothing will arrive to consume a flag armed for
 * one, and a flag left armed would hand the pane to whatever started next.
 */
const NO_OUTPUT_KINDS = new Set(['devStop', 'openShell', 'openInTerminal', 'openInEditor'])

/**
 * "Show me the thing I just started."
 *
 * The pane deliberately does not follow runs around on its own — see the note in
 * `bridge.ts` — but that rule was written for runs that merely *happen*. One you
 * pressed a button for is the opposite: pressing Run and then having to find the
 * output by hand is the whole complaint. This is the one place that knows both that a
 * user confirmed an action and which surface its output will land on, so it is where
 * the request is recorded.
 *
 * Split by kind because the two surfaces have separate one-shot flags: a `term*`
 * intent opens a pty tab and emits `term:opened`, everything else emits
 * `run:started`. Arming the wrong one leaves it set for an unrelated session later.
 */
function armFocus(kind: string): void {
  if (NO_OUTPUT_KINDS.has(kind)) return
  if (kind.startsWith('term')) useTerminalStore.getState().requestFocus()
  else useRunStore.getState().requestFocus()
}

function reportError(e: unknown) {
  if (e instanceof IpcError) {
    switch (e.code) {
      case 'NO_TERMINAL':
        toast.error('No terminal emulator found', {
          description: e.message,
          duration: 12_000,
        })
        return
      case 'SCRIPT_INTERACTIVE':
        toast.error('This script needs a terminal', { description: e.message })
        return
      case 'TOOL_MISSING': {
        // The button that produced this stays enabled and will fail identically next
        // time, so the toast is the only place a fix can be offered. Before this it
        // was a bare message that did not even name the page which installs the tool.
        const fix = toolFix(e.detail)
        toast.error(`${e.detail ?? 'A tool'} is not installed`, {
          description: fix
            ? 'Work Alley can install it — the setup page has a step for it.'
            : e.message,
          duration: 12_000,
          action: fix
            ? {
                label: 'Set it up',
                onClick: () => useUiStore.getState().openSetupAt(fix.stepId),
              }
            : undefined,
        })
        return
      }
      case 'NOT_READY':
        toast.info('Still starting up — try again in a moment.')
        return
      default:
        toast.error(e.message)
        return
    }
  }
  toast.error(String(e))
}

/** Convenience: request an action and focus its output. */
/**
 * Stamps the repo's chosen package manager onto the specs that go through one.
 *
 * Here rather than at each call site because the choice has to hold everywhere:
 * the scripts strip, the Run button on a row and on a card, the Build menu, the
 * row menu. A choice honoured by three of those five is worse than not offering
 * it. A spec that names one already — nothing does today, but the field is on the
 * wire — is left alone.
 */
function withManager(spec: ActionSpec): ActionSpec {
  if (spec.kind !== 'runScript' && spec.kind !== 'devStart' && spec.kind !== 'runChore') {
    return spec
  }
  if (spec.manager) return spec
  const manager = useManagerStore.getState().byRepo[repoId(spec.ref)]
  return manager ? { ...spec, manager } : spec
}

export function useRunAction() {
  const request = useActionStore((s) => s.request)
  return (raw: ActionSpec) => {
    const spec = withManager(raw)
    // Selection is the store's, set by `start` when `run:started` lands. This used
    // to grab `order[order.length - 1]` after the request resolved, which was only
    // ever "probably the newest" — and is now wrong outright, since a run that
    // continues a finished one keeps that entry's place in the strip rather than
    // moving to the end.
    void request(spec)
  }
}
