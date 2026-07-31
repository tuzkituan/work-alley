import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  FolderOpen,
  ListChecks,
  Plus,
  Settings,
  UserRound,
  Wrench,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui-store'
import { shortenHome, useWorkspaceActions } from '@/features/workspace/WorkspacePicker'
import { useSkin, useTheme } from '@/hooks/use-theme'
import type { Bootstrap } from '@/domain/types'

/**
 * The screen a launch lands on when there is nothing to open yet.
 *
 * It replaces two takeovers that used to fight over the same moment: the first-run
 * setup page, which seized the window on a machine missing a tool, and the folder
 * picker, which seized it when no workspace was open. Both answered *for* the user
 * — one deciding that installing git was the most urgent thing, the other that
 * choosing a folder was — and neither could be left without finishing.
 *
 * Tiles instead: four things this machine can do, each saying where it stands, and
 * a way past all of them. Nothing here is a wizard, so nothing has to be completed
 * in order.
 *
 * Metro, deliberately: flat, square, text-led, and sized so the status line is as
 * readable as the label. The status is the point — "3 of 7 required" is what tells
 * you whether to open the tile at all.
 */
export function LauncherPage({
  boot,
  onOpenApp,
  onSetUpFromUrls,
}: {
  boot: Bootstrap | undefined
  /** Past the tiles, into whatever the app would otherwise have shown. */
  onOpenApp: () => void
  /** The clone-from-URLs flow, which owns the whole window while it runs. */
  onSetUpFromUrls: () => void
}) {
  const setPage = useUiStore((s) => s.setPage)
  const { label: themeLabel } = useTheme()
  const { label: skinLabel } = useSkin()
  const { pick, set, forget, busy } = useWorkspaceActions()
  const home = boot?.homeDir ?? null
  const recents = boot?.recentRoots ?? []
  const missing = boot?.readiness.missingRequired ?? []

  // Both are already cached by the pages behind these tiles, so on a second visit
  // the counts are there before the tiles paint.
  const { data: plan } = useQuery({
    queryKey: keys.setupPlan,
    queryFn: () => api.listSetupPlan(),
    enabled: boot?.toolsReady ?? false,
    staleTime: 30_000,
  })
  const { data: stacks } = useQuery({
    queryKey: keys.stacks,
    queryFn: () => api.listStacks(),
    staleTime: 30_000,
  })
  const { data: accounts } = useQuery({
    queryKey: keys.gitAccounts,
    queryFn: () => api.listGitAccounts(),
    staleTime: 30_000,
  })

  const required = (plan?.steps ?? []).filter((s) => !s.optional)
  const done = required.filter((s) => s.done).length
  const ready = boot?.readiness.ready ?? false
  // `path` is the whole test: the probe records one only for a tool it resolved.
  const installed = (boot?.tools ?? []).filter((t) => t.path).length

  // Two at most: the tile has one line, and "web, flutter +2" says as much as
  // naming all four in six-point type.
  const picked = (stacks ?? []).filter((s) => s.chosen)
  const chosenStacks =
    picked.length === 0
      ? ''
      : picked.length <= 2
        ? picked.map((s) => s.label.toLowerCase()).join(', ')
        : `${picked.length} stacks`

  const folder = boot?.hasWorkspace ? workspaceName(boot.workspaceRoot) : null
  const activeAccount = accounts?.accounts.find((a) => a.id === accounts.activeId)

  return (
    <div className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-6">
      <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-[-0.01em]">
            {boot?.onboardingCompleted ? 'Where to?' : 'Welcome'}
          </h1>
          <p className="text-[12.5px] text-adaptive-500">
            {boot?.onboardingCompleted
              ? 'No folder is open. Pick up any of these, or go straight in.'
              : 'Four things worth doing on a new machine. None of them is required, and you can come back to all of them.'}
          </p>
        </div>

        {/* Two columns at any usable width, one when the window is genuinely narrow.
            Not `auto-fit`: with four tiles it would stretch them across a wide
            window, and a 900px-wide tile is a banner, not a tile. */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Tile
            icon={<ListChecks className="size-4" />}
            label="Guided setup"
            hint="Install what this machine is missing, in the order it needs it."
            // The stacks are part of the status because they are what the count is
            // *of*: "3/7 required" means something different once the list is
            // filtered to the two languages this machine actually does.
            status={
              !boot?.toolsReady
                ? 'checking…'
                : required.length === 0
                  ? 'nothing to do'
                  : `${done}/${required.length} required${chosenStacks ? ` · ${chosenStacks}` : ''}`
            }
            tone={ready ? 'ok' : 'warn'}
            onClick={() => setPage('setup')}
          />
          <Tile
            icon={<Wrench className="size-4" />}
            label="Toolbox"
            hint="Every tool this app knows how to install, one at a time."
            status={boot?.toolsReady ? `${installed} installed` : 'checking…'}
            onClick={() => setPage('toolbox')}
          />
          <Tile
            icon={<UserRound className="size-4" />}
            label="Git accounts"
            hint="Who commits, which ssh key pushes, which GitHub login answers."
            status={
              activeAccount
                ? `using ${activeAccount.label}`
                : accounts?.accounts.length
                  ? `${accounts.accounts.length} saved`
                  : accounts?.globalEmail
                    ? 'none saved'
                    : 'no identity set'
            }
            tone={accounts && !accounts.globalEmail ? 'warn' : undefined}
            onClick={() => setPage('accounts')}
          />
          <Tile
            icon={<Settings className="size-4" />}
            label="Settings"
            hint="Theme, fonts, zoom, scanning and background fetch."
            // The two people change first, and the only two this screen can show
            // without opening the page.
            status={`${themeLabel.toLowerCase()} · ${skinLabel.toLowerCase()}`}
            onClick={() => setPage('settings')}
          />
        </div>

        {/* The picker's own list, merged in below the tiles rather than left on a
            screen of its own. Reopening the folder you were in yesterday is the most
            common thing anyone does here, and it was two screens away. */}
        {recents.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold tracking-[0.06em] text-adaptive-500 uppercase">
              Recent
            </span>
            <div className="overflow-hidden rounded-lg border border-adaptive-200">
              {recents.map((r) => (
                // Two actions on one line, so two buttons: nesting one inside the
                // other is invalid, and a row-wide click that sometimes forgets and
                // sometimes opens is worse than either.
                <div
                  key={r}
                  data-slot="recent-folder"
                  className="group flex w-full items-center gap-2 border-b border-adaptive-200 px-3 py-2 last:border-b-0 hover:bg-adaptive-100"
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => set.mutate(r, { onSuccess: () => onOpenApp() })}
                    title={r}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left font-mono text-xs text-adaptive-700"
                  >
                    <FolderOpen className="size-3.5 flex-none text-adaptive-400" />
                    <span className="truncate">{shortenHome(r, home)}</span>
                  </button>
                  {/* On hover only: five paths with a × each reads as a list of
                      delete buttons that happen to have folders next to them. */}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Forget ${r}`}
                    title="Forget this folder. Nothing on disk is deleted."
                    onClick={() => forget.mutate(r)}
                    className="hidden flex-none text-adaptive-400 group-hover:block hover:text-adaptive-900"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Opening a folder leads: it is what almost everyone is here to do, and the
            recents above are the same action with the choice already made. Cloning
            from URLs is the answer to the one case it cannot cover — a machine with
            nothing on it yet — so it follows rather than competes. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            variant="waPrimary"
            size="wa"
            disabled={busy}
            // Choosing a folder is the decision — there is nothing to confirm after
            // it, so it opens the app rather than returning here with a tile ticked.
            onClick={() => pick.mutate(undefined, { onSuccess: (b) => b && onOpenApp() })}
          >
            <FolderOpen className="size-3.5" />
            {busy ? 'Opening…' : 'Open folder…'}
          </Button>
          <Button variant="waOutline" size="wa" onClick={onSetUpFromUrls}>
            <Plus className="size-3.5" />
            Set up from git URLs…
          </Button>
          {missing.length > 0 && (
            <span className="text-[11.5px] text-sev-err">
              {missing.join(', ')} {missing.length > 1 ? 'are' : 'is'} not installed, so a
              folder cannot be scanned yet.
            </span>
          )}
          <span className="text-[11px] text-adaptive-400">
            Or set <code className="font-mono">WORK_ALLEY_ROOT</code> to override this.
          </span>
        </div>

        {/* Only when a folder is already open — which is the setup-not-finished case,
            since otherwise this screen would not be showing. With no workspace there
            is nothing on the other side of it: picking a folder is what goes in, and
            a button that says "go" next to nothing to go to is a dead control. */}
        {folder && (
          <div className="flex items-center gap-2">
            <Button variant="waPrimary" size="wa" onClick={onOpenApp} title={`Open ${folder}`}>
              Open {folder}
              <ArrowRight className="size-3.5" />
            </Button>
            <span className="text-[11.5px] text-adaptive-500">
              {/* Says what it costs, because on a machine genuinely missing git the
                  answer is "most of the app will not work", and that should not be a
                  surprise on the other side of the click. */}
              {ready
                ? 'Everything here stays reachable from the left rail.'
                : 'Anything still missing keeps showing in a bar at the bottom.'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

/** The last segment of a path, which is what people call their workspace. */
function workspaceName(root: string): string {
  const parts = root.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? root
}

function Tile({
  icon,
  label,
  hint,
  status,
  tone,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  hint: string
  status: string
  /** Colours the status line only. Absent means "nothing to say about it". */
  tone?: 'ok' | 'warn'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // A skin handle: Metro squares these off and fills them on hover, Adwaita
      // rounds them. The base styling is the app's own card.
      data-slot="launcher-tile"
      className={cn(
        'group flex min-h-[7.5rem] flex-col items-start gap-1 rounded-lg border border-adaptive-200 bg-card p-3.5 text-left',
        'transition-colors hover:border-adaptive-400 hover:bg-adaptive-100'
      )}
    >
      <span className="flex items-center gap-2 text-adaptive-500 group-hover:text-adaptive-900">
        {icon}
        <span className="text-[13px] font-semibold text-adaptive-900">{label}</span>
      </span>
      <span className="text-[11.5px] leading-[1.45] text-adaptive-500">{hint}</span>
      <span className="flex-1" />
      <span
        className={cn(
          'wa-num font-mono text-[11px]',
          tone === 'warn' ? 'text-sev-warn' : tone === 'ok' ? 'text-sev-ok' : 'text-adaptive-400'
        )}
      >
        {status}
      </span>
    </button>
  )
}
