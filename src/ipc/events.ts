import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  DevServer,
  DockerStatus,
  RunExit,
  RunOutput,
  RunSummary,
  ScanCommits,
  ScanFinished,
  ScanRepo,
  ScanStarted,
} from '@/domain/types'

export interface WaEvents {
  'scan:started': ScanStarted
  'scan:repo': ScanRepo
  'scan:commits': ScanCommits
  'scan:finished': ScanFinished
  'scan:error': { scanId: string; message: string }
  'run:started': { run: RunSummary }
  'run:output': RunOutput
  'run:exit': RunExit
  'dev:changed': { servers: DevServer[] }
  'docker:changed': { status: DockerStatus }
  'app:toast': { level: string; message: string; runId: string | null }
  'tools:ready': null
  'workspace:changed': null
}

type Handler<K extends keyof WaEvents> = (payload: WaEvents[K]) => void

const handlers: { [K in keyof WaEvents]?: Set<Handler<K>> } = {}
let bridge: Promise<void> | null = null
let unlisteners: UnlistenFn[] = []

/**
 * Attaches every Tauri listener exactly once, memoised on the promise.
 *
 * Deliberately NOT a useEffect. React StrictMode double-invokes effects, and
 * `listen()` is async — so the naive effect+cleanup pattern either double-
 * subscribes (duplicate log lines) or unsubscribes the surviving listener.
 */
export function ensureBridge(): Promise<void> {
  if (bridge) return bridge

  bridge = (async () => {
    const names = Object.keys({
      'scan:started': 0,
      'scan:repo': 0,
      'scan:commits': 0,
      'scan:finished': 0,
      'scan:error': 0,
      'run:started': 0,
      'run:output': 0,
      'run:exit': 0,
      'dev:changed': 0,
      'docker:changed': 0,
      'app:toast': 0,
      'tools:ready': 0,
      'workspace:changed': 0,
    }) as (keyof WaEvents)[]

    unlisteners = await Promise.all(
      names.map((name) =>
        listen(name, (event) => {
          const set = handlers[name]
          if (!set) return
          for (const h of set) {
            try {
              ;(h as Handler<typeof name>)(event.payload as WaEvents[typeof name])
            } catch (e) {
              console.error(`handler for ${name} threw`, e)
            }
          }
        })
      )
    )
  })()

  return bridge
}

export function on<K extends keyof WaEvents>(name: K, handler: Handler<K>): () => void {
  let set = handlers[name] as Set<Handler<K>> | undefined
  if (!set) {
    set = new Set<Handler<K>>()
    ;(handlers as Record<string, unknown>)[name] = set
  }
  set.add(handler)
  return () => {
    set.delete(handler)
  }
}

/** Only used on teardown in tests; the app keeps the bridge for its lifetime. */
export async function teardownBridge() {
  for (const u of unlisteners) u()
  unlisteners = []
  bridge = null
}
