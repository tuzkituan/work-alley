import { create } from 'zustand'
import { toast } from 'sonner'
import { api } from '@/ipc/commands'
import { IpcError } from '@/ipc/errors'
import { toolFix } from '@/domain/tool-fix'
import { useRunStore } from '@/stores/run-store'
import { useUiStore } from '@/stores/ui-store'
import type { ActionIntent, ActionSpec } from '@/domain/types'

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

      if (intent.readOnly) {
        // Nothing is mutated, so there is nothing to confirm.
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
export function useRunAction() {
  const request = useActionStore((s) => s.request)
  const setActive = useRunStore((s) => s.setActive)
  return (spec: ActionSpec) => {
    void request(spec).then(() => {
      const order = useRunStore.getState().order
      const last = order[order.length - 1]
      if (last) setActive(last)
    })
  }
}
