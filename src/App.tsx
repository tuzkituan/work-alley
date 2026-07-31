import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { TopBar } from '@/features/topbar/TopBar'
import { ChromeBar } from '@/features/topbar/ChromeBar'
import { LeftRail } from '@/features/rail/LeftRail'
import { NeedsYouStrip } from '@/features/needs-you/NeedsYouStrip'
import { RepoGrid } from '@/features/repos/RepoGrid'
import { OutputPane } from '@/features/output/OutputPane'
import { ConfirmActionDialog } from '@/features/actions/ConfirmActionDialog'
import { CommandPalette } from '@/features/command/CommandPalette'
import { Toolbox } from '@/features/toolbox/Toolbox'
import { SetupPage } from '@/features/setup/SetupPage'
import { LauncherPage } from '@/features/launcher/LauncherPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { GitAccountsPage } from '@/features/accounts/GitAccountsPage'
import { MachinePage } from '@/features/setup/MachinePage'
import { shouldOnboard } from '@/features/setup/should-onboard'
import { useUiStore } from '@/stores/ui-store'
import { api } from '@/ipc/commands'
import { connectBridge } from '@/ipc/bridge'
import { isTauri } from '@/ipc/guard'
import { InitWorkspace } from '@/features/workspace/InitWorkspace'
import { keepRememberedCategory } from '@/features/workspace/remembered-category'
import { learnNamePrefixes } from '@/domain/severity'
import { repoId } from '@/domain/types'
import { useRepoLists } from '@/stores/repo-lists'
import { useCategoryScan } from '@/hooks/use-category-scan'
import { IpcError } from '@/ipc/errors'
import { keys } from '@/queries/keys'
import { useApplyTheme, useTheme, useZoomKeys } from '@/hooks/use-theme'
import { useAppIdentity } from '@/hooks/use-bootstrap'
import { cn } from '@/lib/utils'

export function App() {
  useApplyTheme()
  useZoomKeys()

  if (!isTauri()) return <NotInTauri />
  return <Dashboard />
}

const LAYOUT_KEY = 'work-alley:panels'

function loadLayout(): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : null
  } catch {
    return null
  }
}

function saveLayout(layout: Record<string, number>) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    // A full or blocked storage quota must not break resizing.
  }
}

// The output pane used to widen itself to 760px whenever a terminal opened, on the
// theory that 44 columns is too few for vim. It also fired on every webview reload,
// because the bridge re-opens restored pty sessions one at a time — so the pane
// jumped out from under a width the user had deliberately chosen. The width is
// theirs; a terminal opening is not a reason to move it.

function Dashboard() {
  const qc = useQueryClient()
  // Read once: re-reading on every render would fight the drag.
  const [savedLayout] = useState(loadLayout)
  const page = useUiStore((s) => s.page)
  const setPage = useUiStore((s) => s.setPage)
  const { theme } = useTheme()
  const [setupMode, setSetupMode] = useState(false)
  // Past the tiles for this run. See the launcher branch for why it is not a page.
  const [launcherDone, setLauncherDone] = useState(false)
  // Toolbox and setup installs run in a terminal session; the dock below only
  // exists once one has been opened.

  // get_bootstrap paints the entire chrome — real counts, every folder, the
  // real scripts list — before a single git process has run.
  // No `isPending` here any more: no screen is rendered at all until boot has
  // landed — the splash covers that window — so the strip that used to say
  // "Starting up…" along the bottom had nothing left to appear over.
  const { data: boot, error } = useQuery({
    queryKey: keys.bootstrap,
    queryFn: () => api.getBootstrap(),
    // State is managed after an async toolchain probe, so an early call can arrive
    // before it exists. Retry that specific case.
    retry: (count, err) =>
      err instanceof IpcError && err.code === 'NOT_READY' ? count < 25 : count < 1,
    retryDelay: 200,
  })

  // Fetched once per launch, here rather than where it is used. The repo row menu
  // offers "Commit as…" from this cache and must not spawn a `git config` read per
  // row to decide whether to draw the submenu; the accounts page and the launcher
  // both read the same key. Cheap — two config reads and one `gh auth status` — and
  // anything that changes it invalidates the key.
  useQuery({
    queryKey: keys.gitAccounts,
    queryFn: () => api.listGitAccounts(),
    enabled: boot?.toolsReady ?? false,
    staleTime: 5 * 60_000,
  })

  // Repo names are abbreviated for display by stripping whatever prefix this
  // workspace's repos happen to share. That has to be learned from the names
  // themselves before anything renders one.
  learnNamePrefixes(useMemo(() => (boot?.repos ?? []).map((r) => r.name), [boot?.repos]))

  // Pins and recents outlive a launch, so a repo that has since been deleted or
  // renamed would sit in the rail forever pointing at nothing. Bootstrap is the
  // authority on what exists.
  const prune = useRepoLists((s) => s.prune)
  useEffect(() => {
    if (!boot?.workspaceRoot) return
    prune(boot.workspaceRoot, new Set(boot.repos.map(repoId)))
  }, [boot, prune])

  // Closing the folder puts you back on the tiles.
  //
  // Without this, "past the tiles" outlived the workspace that justified it: closing
  // a folder left the dashboard mounted with nothing to show — a rail of no folders
  // over a table of repos that are no longer open — and no way back to the picker
  // short of relaunching.
  const hasWorkspace = boot?.hasWorkspace ?? false
  useEffect(() => {
    if (!hasWorkspace) setLauncherDone(false)
  }, [hasWorkspace])

  // The open workspace, mirrored into the store so a folder selection can be
  // stamped with the workspace it was made in. Not persisted — see the field.
  const setWorkspaceRoot = useUiStore((s) => s.setWorkspaceRoot)
  useEffect(() => {
    if (boot) setWorkspaceRoot(boot.workspaceRoot)
  }, [boot, setWorkspaceRoot])

  // The selected folder is remembered across launches, so it can name a folder that
  // no longer exists — or one that belongs to a different workspace entirely, now
  // that launching straight into the last one is an option. Clearing it here stops
  // the scan hook chasing either.
  const setCategory = useUiStore((s) => s.setCategory)
  const selected = useUiStore((s) => s.expandedCategory)
  const categoryRoot = useUiStore((s) => s.expandedCategoryRoot)
  useEffect(() => {
    if (!boot) return
    const categories = boot.categories.map((c) => c.category)
    if (!keepRememberedCategory(selected, categoryRoot, boot.workspaceRoot, categories)) {
      setCategory(null)
    }
  }, [boot, selected, categoryRoot, setCategory])

  // Scans the open folder, once a folder is open *and* the toolchain is resolved.
  useCategoryScan(boot?.toolsReady ?? false)

  // Attach listeners as soon as the backend is up. No scan is started here: with
  // no folder selected there is nothing in view, so scanning every repo
  // would be work nobody asked for.
  useEffect(() => {
    if (!boot) return
    // No local guard: `connectBridge` is memoised on its promise, so calling it
    // twice is a no-op. A local `connected` flag used to sit here, which is what
    // made the double-registration bug look impossible — the real guard was inside
    // the bridge and it was checked after an await.
    void connectBridge(qc)
  }, [boot, qc])

  // Is there a screen to show yet? Bootstrap, and — only when onboarding has never
  // been completed — the toolchain probe that decides between the dashboard and the
  // setup takeover.
  const booting = !boot || (!boot.onboardingCompleted && !boot.toolsReady)

  // The splash outlives `booting` by one animation, which is the whole point: it
  // fades and lifts away while the app fades in behind it. `SPLASH_EXIT_MS` matches
  // `wa-splash-out` in wa-bridge.css — a timer rather than `animationend`, because
  // reduced motion collapses the animation and the event would land at a different
  // time or, with `animation: none`, never.
  const [splashGone, setSplashGone] = useState(false)

  // A floor on how long the mark is up. Bootstrap on a warm machine answers in a
  // few tens of milliseconds, so without this the splash was a flicker — the mark's
  // own entrance had not finished before it was already leaving, which reads as a
  // glitch rather than as a launch. Long enough to land and be seen, short enough
  // that nobody waits on it.
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setHeld(true), SPLASH_MIN_MS)
    return () => clearTimeout(t)
  }, [])

  const leaving = !booting && held
  useEffect(() => {
    if (!leaving || splashGone) return
    const t = setTimeout(() => setSplashGone(true), SPLASH_EXIT_MS)
    return () => clearTimeout(t)
  }, [leaving, splashGone])

  // Which screen, as a value rather than a series of early returns — the splash
  // below has to render *over* whichever one it is, and an early return cannot be
  // wrapped.
  const screen = ((): React.ReactNode => {
    if (error && !boot) return <FatalError message={error.message} />

    // The Toolbox and the setup page describe this machine, not the open folder, so
    // they take the whole window and work with no workspace at all — which is exactly
    // when someone needs to install their tools.
    //
    // Checked before `hasWorkspace` on purpose: that is what makes Guided setup
    // reachable from the workspace picker on a machine that cannot clone yet.
    if (page === 'toolbox' || page === 'setup' || page === 'settings' || page === 'accounts') {
      return (
        <TooltipProvider delayDuration={400}>
          <div className="flex h-full flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900">
            <TopBar boot={boot} />
            <MachinePage>
              {/* Keyed by page so switching Toolbox -> Settings replays the entry,
                  rather than only animating the first full-window page opened. */}
              <div key={page} className="wa-view-enter flex min-h-0 flex-1 flex-col">
                {page === 'setup' ? (
                  <SetupPage toolsReady={boot?.toolsReady ?? false} />
                ) : page === 'settings' ? (
                  <SettingsPage />
                ) : page === 'accounts' ? (
                  <GitAccountsPage />
                ) : (
                  <Toolbox toolsReady={boot?.toolsReady ?? false} />
                )}
              </div>
            </MachinePage>
          </div>
          <ConfirmActionDialog />
          <Toaster theme={theme} position="bottom-left" />
        </TooltipProvider>
      )
    }

    // Nothing decided yet, so render nothing: the splash is over the top of this
    // and it is what the user is looking at.
    //
    // Two windows used to flash the dashboard here. The first is bootstrap itself
    // being in flight — the app rendered its full chrome with `boot` undefined, on
    // the theory that painting early beats a spinner. The second is longer and
    // worse: bootstrap returns before the toolchain probe does, so `toolsReady` is
    // false for about a second, `shouldOnboard` answers "no" on a machine that needs
    // setup, and the dashboard rendered in full before the takeover replaced it. The
    // app appeared to start and then change its mind.
    //
    // The toolchain half is gated on `onboardingCompleted`, so it costs nothing once
    // setup has been finished: that machine goes to the dashboard on an unresolved
    // toolchain exactly as before.
    if (booting) return null

    // The tiles.
    //
    // Shown whenever a launch has nowhere to land: no workspace to reopen, or a
    // machine that has never been through setup. It replaces two takeovers that
    // used to compete for this moment — the setup page and the folder picker — each
    // of which decided *for* the user what the most urgent thing was, and neither of
    // which could be left without finishing it.
    //
    // `launcherDone` rather than a page: this is a launch state, not somewhere you
    // navigate to, and persisting it would mean a relaunch could restore "past the
    // tiles" on a machine with nothing open. Every tile that leads to a page sets
    // `page`, which the branch above catches — so Back from those pages lands here
    // again, which is what makes the tiles read as a home screen.
    if (boot && !launcherDone && (shouldOnboard(boot) || !boot.hasWorkspace)) {
      return (
        <TooltipProvider delayDuration={400}>
          {/* ChromeBar, not TopBar: there is no workspace to switch and no bulk
              action to take, but the window still needs its buttons — a screen with
              no way to close it is the FatalError lesson. */}
          <div className="flex h-full flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900">
            <ChromeBar />
            <MachinePage>
              <div className="wa-view-enter flex min-h-0 flex-1 flex-col">
                {setupMode ? (
                  // Owns the window while it runs: it is a form with a clone
                  // behind it, and half of it behind a tile would be worse.
                  <InitWorkspace
                    boot={boot}
                    onCancel={() => setSetupMode(false)}
                    onDone={(path) => {
                      setSetupMode(false)
                      // The folder only becomes a workspace once something is
                      // cloned into it, so switching is the last step, not the
                      // first.
                      void api.setWorkspace(path).then((b) => {
                        qc.setQueryData(keys.bootstrap, b)
                        // Select the first folder, so the app lands mid-scan
                        // rather than on "Pick a folder". Cloning into a workspace
                        // and then being asked to pick something inside it was one
                        // hop too many, and nothing said that clicking a rail
                        // folder is what starts a scan.
                        const first = b.categories.find((c) => c.repoCount > 0)
                        if (first) useUiStore.getState().setCategory(first.category)
                        setLauncherDone(true)
                      })
                    }}
                  />
                ) : (
                  <LauncherPage
                    boot={boot}
                    onSetUpFromUrls={() => setSetupMode(true)}
                    onOpenApp={() => {
                      setLauncherDone(true)
                      // Going in counts as having been asked, so the next launch with a
                      // workspace open goes straight to the dashboard.
                      if (!boot.onboardingCompleted) {
                        void api
                          .completeOnboarding()
                          .then((b) => qc.setQueryData(keys.bootstrap, b))
                          .catch(() => {})
                      }
                    }}
                  />
                )}
              </div>
            </MachinePage>
          </div>
          <ConfirmActionDialog />
          <Toaster theme={theme} position="bottom-left" />
        </TooltipProvider>
      )
    }

    return (
      <TooltipProvider delayDuration={400}>
        {/* The design's root is a bordered, 10px-radius panel. We render it as an
            inner frame in a decorated window: transparency plus rounded corners on
            Wayland/WebKitGTK is unreliable. */}
        <div className="flex h-full flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900">
          <TopBar boot={boot} />

          {/* Defaults are the design's exact pixel widths. react-resizable-panels
              v3 has no autoSaveId, so the layout is persisted by hand. */}
          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
            defaultLayout={savedLayout ?? undefined}
            onLayoutChanged={(layout, meta) => {
              // Only user drags are worth saving; mount and imperative changes are not.
              if (meta.isUserInteraction) saveLayout(layout)
            }}
          >
            <ResizablePanel id="rail" defaultSize="214px" minSize="160px" maxSize="420px">
              <LeftRail boot={boot} />
            </ResizablePanel>

            <ResizableHandle className="hover:bg-primary data-[dragging]:bg-primary" />

            <ResizablePanel id="main" minSize="420px">
              <div className="flex h-full min-w-0 flex-col overflow-hidden">
                {/* No tab strip: this panel has exactly one view. It used to carry a
                    Repos/Activity pair, but Activity's two panels were both redundant —
                    per-repo commits live on the detail page, and container state is a
                    `docker ps` away in the output pane. Removing it gave the list back
                    the strip's height. */}
                <NeedsYouStrip boot={boot} />
                <RepoGrid boot={boot} />
              </div>
            </ResizablePanel>

            <ResizableHandle className="hover:bg-primary data-[dragging]:bg-primary" />

            <ResizablePanel
              id="output"
              defaultSize="372px"
              minSize="260px"
              maxSize="900px"
            >
              <OutputPane />
            </ResizablePanel>
          </ResizablePanelGroup>

          {boot && (boot.warnings.length > 0 || boot.readiness.missingRequired.length > 0) && (
            <WarningBar
              warnings={boot.warnings}
              missing={boot.readiness.missingRequired}
              onFix={() => setPage('setup')}
            />
          )}
        </div>

        <ConfirmActionDialog />
        <CommandPalette boot={boot} />
        {/* Sonner sniffs the theme itself, so it must be told explicitly. */}
        {/* No per-mount styling: the surface, border and radius live in
            `components/ui/sonner.tsx` and wa-bridge.css, so the toast over the
            dashboard is the same object as the toast over setup. This one used to
            paint itself from `--card` while the other three used `--popover`. */}
        <Toaster theme={theme} position="bottom-left" />
      </TooltipProvider>
    )
  })()

  // The launch sequence: the mark holds the window until there is something real
  // to show, then lifts away while the app settles in behind it. Kept mounted for
  // one animation past `booting` — unmounting it the instant boot lands is what
  // made this a cut rather than an opening.
  return (
    <>
      <div className={cn('h-full', !splashGone && 'wa-app-in')}>{screen}</div>
      {!splashGone && <Splash exiting={leaving} />}
    </>
  )
}

/**
 * Two modes, because two very different things end up here.
 *
 * A *missing required tool* is not a warning — it means the buttons above do not work,
 * so it renders expanded, in error tone, and cannot be folded away. That case used to
 * be indistinguishable from "no docker found": both went into one accordion that was
 * collapsed by default, at the bottom of the window.
 */
function WarningBar({
  warnings,
  missing = [],
  onFix,
}: {
  warnings: string[]
  missing?: string[]
  onFix?: () => void
}) {
  const [open, setOpen] = useState(false)

  if (missing.length > 0) {
    return (
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-t border-error-500/40 bg-red-500/[0.08] px-4 py-1.5">
        <span className="text-[11px] font-semibold text-sev-err">
          {missing.join(', ')} {missing.length > 1 ? 'are' : 'is'} not installed
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-adaptive-600">
          Scanning and most repo actions need {missing.length > 1 ? 'them' : 'it'}.
        </span>
        {onFix && (
          <Button variant="waPrimary" size="waXs" onClick={onFix}>
            Finish setup
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex-none border-t border-adaptive-200 bg-amber-500/[0.08] px-4 py-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left text-[11px] text-warning-500"
      >
        <span className="font-semibold">
          {warnings.length} environment warning{warnings.length > 1 ? 's' : ''}
        </span>
        <span className="text-adaptive-500">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5 pb-1">
          {warnings.map((w, i) => (
            <li key={i} className="text-[11px] text-adaptive-600">
              • {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Matches `wa-splash-out`'s duration in wa-bridge.css. */
const SPLASH_EXIT_MS = 240

/**
 * The shortest the launch screen is up for, exit not included.
 *
 * Comfortably past `wa-splash-in`'s 260ms, so the mark always finishes arriving
 * before it starts leaving.
 */
const SPLASH_MIN_MS = 900

/**
 * The launch screen: the mark, the app's name, and nothing else.
 *
 * It exists because the first frame is not free — bootstrap has to answer, and on a
 * machine that has never been set up the toolchain probe has to answer too, which
 * means two login shells. What used to happen in that window was worse than a wait:
 * the dashboard painted, then the setup takeover replaced it, so the app appeared
 * to start and change its mind.
 *
 * The "Checking your toolchain…" line waits 400ms. On a machine that is already set
 * up this whole screen lives for a few hundred milliseconds, and a message that
 * flashes in and straight back out is worse than no message.
 *
 * ChromeBar, not TopBar: there is no workspace to switch and no counts to show, but
 * the window still needs its buttons — a screen with no way to close it is the
 * FatalError lesson.
 */
function Splash({ exiting }: { exiting: boolean }) {
  const { name, version } = useAppIdentity()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 400)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      className={cn(
        // Over the app, not beside it: the two overlap for the length of the exit,
        // which is what makes it read as opening rather than as a swap.
        'fixed inset-0 z-50 flex flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900',
        exiting && 'wa-splash-out'
      )}
    >
      <ChromeBar />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <div className="wa-splash-mark flex flex-col items-center gap-2.5">
          {/* The same mark as the top bar's, at three times the size. A launch
              screen that shows something the app never shows again is a launch
              screen for a different app. */}
          <div className="flex size-14 items-center justify-center rounded-xl bg-primary text-2xl font-bold text-primary-foreground">
            {name.charAt(0)}
          </div>
          <span className="text-sm font-semibold tracking-[-0.01em]">{name}</span>
          <span className="wa-num font-mono text-[10.5px] text-adaptive-400">{version}</span>
        </div>
        {/* Reserved height, so the line appearing does not shift the mark. */}
        <span className="h-4 text-xs text-adaptive-500">
          {slow ? 'Checking your toolchain…' : ''}
        </span>
      </div>
    </div>
  )
}

function FatalError({ message }: { message: string }) {
  return (
    // The window buttons matter most here: this screen has no other way out, and
    // without them the only way to close a failed launch was to kill the process.
    <div className="flex h-full flex-col overflow-hidden border border-adaptive-200 bg-background text-adaptive-900">
      <ChromeBar />
      <div className="flex min-h-0 flex-1 items-center justify-center p-10">
        <div className="flex max-w-lg flex-col gap-3 rounded-lg border border-error-500 bg-card p-6">
          <h1 className="text-base font-semibold text-error-500">Could not start</h1>
          <p className="text-sm text-adaptive-700">{message}</p>
          <p className="text-xs text-adaptive-500">
            Work Alley opens the folder you last chose, or the nearest one above the
            working directory that contains git repos. Set{' '}
            <code className="font-mono">WORK_ALLEY_ROOT</code> to override.
          </p>
          <Button variant="waPrimary" size="wa" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * No mock layer on purpose. The data is real by requirement, and a mock would
 * quietly become the thing people develop against.
 */
function NotInTauri() {
  return (
    <div className="flex h-full items-center justify-center bg-background p-10 text-center">
      <div className="flex max-w-md flex-col gap-2">
        <h1 className="text-base font-semibold">Run this under Tauri</h1>
        <p className="text-sm text-adaptive-600">
          Work Alley reads real git state through the Rust backend, so the browser
          dev server alone cannot render it.
        </p>
        <code className="mt-2 rounded-md border border-adaptive-200 bg-adaptive-100 px-2 py-1.5 font-mono text-xs">
          bun run tauri dev
        </code>
      </div>
    </div>
  )
}
