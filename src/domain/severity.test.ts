import { describe, expect, test } from 'bun:test'
import { buildTarget, runTarget } from './severity'
import type { BuildTarget, DevServer, RepoRef, RepoStatus } from './types'

const ref: RepoRef = { category: 'fe', name: 'web' }

function server(state: DevServer['state']): DevServer {
  return {
    ref,
    task: 'dev',
    runId: 'r1',
    pid: 42,
    command: ['npm', 'run', 'dev'],
    port: 5173,
    portSource: null,
    state,
    url: null,
    startedUnix: 0,
  }
}

/** Only the fields these two selectors read. */
function status(opts: {
  running?: DevServer['state']
  primaryBuild?: BuildTarget | null
}): RepoStatus {
  return {
    primaryTask: 'dev',
    runnable: [{ id: 'dev', label: 'dev', port: 5173 }],
    primaryBuild: opts.primaryBuild ?? null,
    tasks: opts.running ? [server(opts.running)] : [],
  } as unknown as RepoStatus
}

describe('runTarget', () => {
  test('offers Stop while a server is up or still coming up', () => {
    // 'starting' counts as up, or a server stuck starting could never be stopped.
    for (const state of ['up', 'starting'] as const) {
      const t = runTarget(status({ running: state }))
      expect(t.up).toBe(true)
      expect(t.busy).toBe(false)
      expect(t.crashed).toBe(false)
    }
  })

  test('a stopping server is busy, and neither up nor startable', () => {
    // The state that used to fall through as "not up", so the button offered Start
    // on a process that was still going down.
    const t = runTarget(status({ running: 'stopping' }))
    expect(t.busy).toBe(true)
    expect(t.up).toBe(false)
  })

  test('a crashed server is startable again', () => {
    // The row stays so the crash is readable, but it must not read as running —
    // Start here is a restart, and the backend no longer refuses it.
    const t = runTarget(status({ running: 'crashed' }))
    expect(t.crashed).toBe(true)
    expect(t.up).toBe(false)
    expect(t.busy).toBe(false)
  })

  test('a repo with nothing running has an id but no state', () => {
    const t = runTarget(status({}))
    expect(t.id).toBe('dev')
    expect(t.up).toBe(false)
    expect(t.busy).toBe(false)
    expect(t.crashed).toBe(false)
  })

  test('a repo that runs nothing disables the button rather than guessing', () => {
    const t = runTarget(undefined)
    expect(t.id).toBeNull()
  })
})

describe('buildTarget', () => {
  test('a declared script dispatches runScript', () => {
    const t = buildTarget(status({ primaryBuild: { kind: 'script', name: 'build', label: 'build' } }))
    expect(t?.label).toBe('build')
    expect(t?.spec(ref)).toEqual({ kind: 'runScript', ref, script: 'build' })
  })

  test('an ecosystem build dispatches runChore', () => {
    // The whole reason the target is tagged: the two go to different closed sets in
    // Rust, and a caller inferring which from the label would eventually pick wrong.
    const t = buildTarget(
      status({ primaryBuild: { kind: 'chore', id: 'cargo.build', label: 'cargo build' } })
    )
    expect(t?.label).toBe('cargo build')
    expect(t?.spec(ref)).toEqual({ kind: 'runChore', ref, chore: 'cargo.build' })
  })

  test('a repo with no build step has no button', () => {
    expect(buildTarget(status({}))).toBeNull()
    expect(buildTarget(undefined)).toBeNull()
  })
})
