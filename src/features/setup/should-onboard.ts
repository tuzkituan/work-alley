import type { Bootstrap } from '@/domain/types'

/**
 * Whether to open Guided setup instead of the dashboard.
 *
 * The bug this fixes: a machine with no git but an existing workspace folder went
 * straight to the full dashboard, where Pull, Fetch, Status and every script button
 * failed with a toast and nothing offered a way to fix it. The only signal was a
 * warning accordion, collapsed by default, at the bottom of the window.
 *
 * Three terms, each load-bearing:
 *
 * - `!onboardingCompleted` — asked once. Skipping counts as completing, because a
 *   takeover screen that returns tomorrow is a screen you learn to dismiss rather
 *   than read.
 * - `toolsReady` — the probe has actually looked. Without this the takeover flashes
 *   for a second on every launch of a perfectly good machine, since nothing is known
 *   until the probe lands.
 * - `!readiness.ready` — git, Node, a package manager and a git identity. Notably
 *   *not* credentials: cloning over HTTPS with a credential helper is a valid setup
 *   and taking over that window would be wrong.
 */
export function shouldOnboard(boot: Bootstrap | undefined): boolean {
  if (!boot) return false
  if (boot.onboardingCompleted) return false
  if (!boot.toolsReady) return false
  return !boot.readiness.ready
}
