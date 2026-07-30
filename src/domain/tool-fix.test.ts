import { describe, expect, it } from 'bun:test'
import { toolFix } from './tool-fix'

/**
 * `toolchain::tools()`, mirrored.
 *
 * Kept in the test rather than shipped, because its only job is to fail when the two
 * lists drift — a tool added to the Rust probe with no step that installs it produces a
 * dead-end error toast, which is the whole thing this module exists to prevent.
 */
const TOOLS = [
  'git',
  'bun',
  'npm',
  'pnpm',
  'yarn',
  'node',
  'gh',
  'docker',
  'podman',
  'jq',
  'ss',
  'lsof',
]

/** Diagnostics, present on every Linux and not something this app installs. */
const NOT_INSTALLABLE = ['ss', 'lsof']

describe('toolFix', () => {
  it('has an install route for every tool the probe resolves', () => {
    const orphans = TOOLS.filter((t) => !NOT_INSTALLABLE.includes(t) && !toolFix(t))
    expect(orphans).toEqual([])
  })

  it('does not invent a route for the diagnostics', () => {
    // Claiming setup can install `ss` would send someone to a step that never mentions
    // it. No route is the honest answer, and the toast falls back to the raw message.
    for (const t of NOT_INSTALLABLE) {
      expect(toolFix(t)).toBeNull()
    }
  })

  it('points the git tools at the first step', () => {
    expect(toolFix('git')?.stepId).toBe('essentials')
    expect(toolFix('jq')?.stepId).toBe('essentials')
  })

  it('points npm at the Node step, not js-tools', () => {
    // npm arrives with Node; js-tools installs *through* npm, so sending someone there
    // for a missing npm is a step that cannot run.
    expect(toolFix('npm')?.stepId).toBe('node')
    expect(toolFix('pnpm')?.stepId).toBe('js-tools')
  })

  it('returns null for an unknown tool and for nothing at all', () => {
    expect(toolFix('kubectl-but-fake')).toBeNull()
    expect(toolFix(null)).toBeNull()
    expect(toolFix(undefined)).toBeNull()
    expect(toolFix('')).toBeNull()
  })
})
