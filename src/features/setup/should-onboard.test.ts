import { describe, expect, it } from 'bun:test'
import { shouldOnboard } from './should-onboard'
import type { Bootstrap, Readiness } from '@/domain/types'

function readiness(over: Partial<Readiness> = {}): Readiness {
  return {
    toolsReady: true,
    missingRequired: [],
    gitIdentity: true,
    credentials: true,
    ready: true,
    ...over,
  }
}

/** Only the fields the predicate reads; the rest of Bootstrap is irrelevant here. */
function boot(over: Partial<Bootstrap> = {}): Bootstrap {
  return {
    toolsReady: true,
    hasWorkspace: true,
    onboardingCompleted: false,
    readiness: readiness(),
    ...over,
  } as Bootstrap
}

describe('shouldOnboard', () => {
  it('takes over for a machine with no tools — even when a workspace exists', () => {
    // The actual bug: this case rendered the full dashboard, where every button
    // failed with a toast and nothing pointed at a fix.
    const b = boot({
      hasWorkspace: true,
      readiness: readiness({ missingRequired: ['git'], ready: false }),
    })
    expect(shouldOnboard(b)).toBe(true)
  })

  it('leaves a ready machine alone', () => {
    expect(shouldOnboard(boot())).toBe(false)
  })

  it('does not take over before the probe has looked', () => {
    // Otherwise the takeover flashes for a moment on every launch: nothing is known
    // about the machine until the probe lands, and unknown is not the same as broken.
    const b = boot({
      toolsReady: false,
      readiness: readiness({ toolsReady: false, ready: false }),
    })
    expect(shouldOnboard(b)).toBe(false)
  })

  it('never asks again once completed or skipped', () => {
    // Skipping counts. A screen that comes back tomorrow is one you learn to dismiss.
    const b = boot({
      onboardingCompleted: true,
      readiness: readiness({ missingRequired: ['git', 'node'], ready: false }),
    })
    expect(shouldOnboard(b)).toBe(false)
  })

  it('takes over for a missing git identity, with every tool present', () => {
    // Not cosmetic: every commit the app helps make would be unattributed.
    const b = boot({ readiness: readiness({ gitIdentity: false, ready: false }) })
    expect(shouldOnboard(b)).toBe(true)
  })

  it('does not take over for missing credentials alone', () => {
    // `ready` excludes credentials on purpose — an HTTPS credential helper is fine.
    // The setup page still asks; it just does not seize the window.
    const b = boot({ readiness: readiness({ credentials: false, ready: true }) })
    expect(shouldOnboard(b)).toBe(false)
  })

  it('is false while bootstrap has not arrived', () => {
    expect(shouldOnboard(undefined)).toBe(false)
  })
})
