import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Check,
  ChevronDown,
  FolderOpen,
  FolderSearch,
  ListChecks,
  Plus,
  Wrench,
  X,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/ui-store'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { IpcError } from '@/ipc/errors'
import type { Bootstrap } from '@/domain/types'

/** Either separator, because a Windows path uses the other one. */
const SEP = /[/\\]/

/**
 * `/home/me/projects` -> `~/projects`, and `C:\Users\me\projects` -> `~\projects`.
 *
 * Takes the home directory rather than assuming `/home/` — that prefix is wrong
 * on macOS (`/Users/`) and for any account outside the default location.
 *
 * The separator check is what makes this safe rather than merely prefix-matching:
 * without it `/home/mel` would shorten under a home of `/home/me`, and on Windows the
 * remainder starts with a backslash that a `/` test would never match.
 */
export function shortenHome(p: string, home: string | null) {
  if (!home || !p.startsWith(home)) return p
  const rest = p.slice(home.length)
  if (rest === '') return '~'
  return SEP.test(rest.charAt(0)) ? `~${rest}` : p
}

/** The last path segment, whichever separator the platform uses. */
export function baseName(p: string) {
  return p.split(SEP).filter(Boolean).pop()
}

/** The home directory, for abbreviating paths. */
export function useHomeDir(): string | null {
  const { data } = useQuery({
    queryKey: keys.bootstrap,
    queryFn: () => api.getBootstrap(),
    select: (b) => b.homeDir,
  })
  return data ?? null
}

export function useWorkspaceActions() {
  return useSwitchWorkspace()
}

function useSwitchWorkspace() {
  const qc = useQueryClient()

  const apply = (boot: Bootstrap | null) => {
    // null means the picker was cancelled, which is not a failure.
    if (boot) qc.setQueryData(keys.bootstrap, boot)
  }

  const report = (e: unknown) => {
    const msg = e instanceof IpcError || e instanceof Error ? e.message : String(e)
    toast.error('Could not open that folder', { description: msg })
  }

  const pick = useMutation({ mutationFn: () => api.pickWorkspace(), onSuccess: apply, onError: report })
  const close = useMutation({
    mutationFn: () => api.closeWorkspace(),
    onSuccess: apply,
    onError: report,
  })
  const set = useMutation({
    mutationFn: (path: string) => api.setWorkspace(path),
    onSuccess: apply,
    onError: report,
  })
  const forget = useMutation({
    mutationFn: (path: string) => api.forgetRecentRoot(path),
    onSuccess: apply,
    onError: (e: unknown) => {
      const msg = e instanceof IpcError || e instanceof Error ? e.message : String(e)
      toast.error('Could not forget that folder', { description: msg })
    },
  })

  return {
    pick,
    set,
    close,
    forget,
    busy: pick.isPending || set.isPending || close.isPending,
  }
}

/**
 * Topbar control: shows the open workspace and switches between them.
 *
 * Styled as a real button with a folder icon. It used to be plain grey text with
 * a chevron, which did not read as something you could click — the most
 * important control in the header was effectively invisible.
 */
/**
 * ⌘O / Ctrl+O — the conventional "open" shortcut.
 *
 * Mounted by the top bar rather than by the switcher, because the switcher is
 * hidden when no workspace is open and that is exactly when opening one matters
 * most. It used to live inside the switcher, so hiding that control silently took
 * the shortcut with it.
 */
export function useOpenFolderKey() {
  const { pick } = useSwitchWorkspace()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'o' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        pick.mutate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pick])
}

export function WorkspaceSwitcher({ boot }: { boot: Bootstrap | undefined }) {
  const { pick, set, close, forget, busy } = useSwitchWorkspace()
  const home = boot?.homeDir ?? null
  const current = boot?.workspaceRoot ?? ''
  const recents = (boot?.recentRoots ?? []).filter((r) => r !== current)
  // The folder name alone is enough here; the full path is on hover and in the menu.
  const name = baseName(current) ?? 'no workspace'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          title={`Workspace: ${current || 'none'} — click to switch (⌘O to open a folder)`}
          className="flex h-[30px] min-w-0 items-center gap-1.5 rounded-md border border-adaptive-300 bg-background px-2 text-xs font-medium text-adaptive-800 transition-shadow hover:border-adaptive-950 hover:shadow-focus-ring"
        >
          <FolderOpen className="size-3.5 flex-none text-primary" />
          <span className="max-w-[180px] truncate">{name}</span>
          <ChevronDown className="size-3 flex-none text-adaptive-400" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem onClick={() => pick.mutate()}>
          <FolderSearch className="size-3.5" />
          Open folder…
          <span className="ml-auto font-mono text-[10px] text-adaptive-400">⌘O</span>
        </DropdownMenuItem>

        {recents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
              Recent
            </DropdownMenuLabel>
            {recents.map((r) => (
              // Not a DropdownMenuItem: the row has two actions now, and an item
              // swallows the click for whichever one you pressed. The × is
              // hover-only — a column of them beside eight paths is more furniture
              // than the paths.
              <div
                key={r}
                className="group flex items-center gap-1 rounded-sm px-2 py-1.5 hover:bg-accent"
              >
                <button
                  type="button"
                  onClick={() => set.mutate(r)}
                  className="min-w-0 flex-1 truncate text-left font-mono text-xs"
                  title={r}
                >
                  {shortenHome(r, home)}
                </button>
                <button
                  type="button"
                  aria-label={`Forget ${r}`}
                  title="Forget this folder. Nothing on disk is deleted."
                  onClick={(e) => {
                    e.stopPropagation()
                    forget.mutate(r)
                  }}
                  className="hidden flex-none text-adaptive-400 group-hover:block hover:text-adaptive-900"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </>
        )}

        {current && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled className="font-mono text-xs">
              <Check className="size-3.5" />
              <span className="truncate">{shortenHome(current, home)}</span>
            </DropdownMenuItem>
            {/* Closing keeps the folder in Recent — "close" means stop looking at
                this, not forget it. */}
            <DropdownMenuItem onClick={() => close.mutate()}>
              <X className="size-3.5" />
              Close folder
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * First run, or a saved folder that has gone away.
 *
 * Deliberately not a modal: there is nothing behind it to interact with, and the
 * only useful action is choosing a folder.
 */
export function WorkspaceWelcome({
  boot,
  onSetUp,
}: {
  boot: Bootstrap | undefined
  onSetUp: () => void
}) {
  const { pick, set, busy } = useSwitchWorkspace()
  const setPage = useUiStore((s) => s.setPage)
  const home = boot?.homeDir ?? null
  const recents = boot?.recentRoots ?? []
  // A folder can only be opened if it contains repos, and repos can only be scanned
  // with git. Asking for one on a machine with no git was the worst screen in the app:
  // whatever the user picked, nothing would work and nothing said why.
  const missing = boot?.readiness.missingRequired ?? []

  return (
    <div className="flex h-full items-center justify-center bg-background p-10">
      <div className="flex w-full max-w-lg flex-col items-center gap-5">
        {/* Above the fold, not in a collapsed accordion at the bottom of a window this
            screen does not even have. */}
        {missing.length > 0 && (
          <div className="w-full rounded-md border border-error-500/40 bg-red-500/[0.08] px-3 py-2 text-[11.5px] text-sev-err">
            {missing.join(', ')} {missing.length > 1 ? 'are' : 'is'} not installed, so a
            folder cannot be scanned yet.
          </div>
        )}
        <div className="flex size-11 items-center justify-center rounded-lg bg-primary text-lg font-bold text-primary-foreground">
          W
        </div>

        <div className="text-center">
          <h1 className="text-lg font-semibold tracking-[-0.01em]">Choose a workspace</h1>
          {/* Describes what discovery actually does. An earlier version still
              named be/ fe/ sa/ ui/ long after that stopped being the rule. */}
          <p className="mt-1 text-sm text-adaptive-600">
            Point it at any folder with git repos in it. Repos in subfolders keep
            those subfolders as groups; repos sitting directly in the folder are
            grouped by what they are — frontend, backend, library. A single project
            folder works too. Nothing cloned yet? Paste the URLs instead.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="waPrimary" size="wa" disabled={busy} onClick={() => pick.mutate()}>
            <FolderOpen className="size-3.5" />
            {busy ? 'Opening…' : 'Open folder…'}
          </Button>
          {/* Opening a folder only works if you already have the repos. On a new
              machine you do not, and without this the first run is a dead end. */}
          <Button variant="waOutline" size="wa" onClick={onSetUp}>
            <Plus className="size-3.5" />
            Set up from git URLs…
          </Button>
        </div>

        {recents.length > 0 && (
          <div className="w-full">
            <div className="mb-1.5 text-[10px] font-semibold tracking-[0.06em] text-adaptive-500 uppercase">
              Recent
            </div>
            <div className="overflow-hidden rounded-lg border border-adaptive-200">
              {recents.map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled={busy}
                  onClick={() => set.mutate(r)}
                  className="flex w-full items-center gap-2 border-b border-adaptive-200 px-3 py-2 text-left font-mono text-xs text-adaptive-700 last:border-b-0 hover:bg-adaptive-100"
                >
                  <FolderOpen className="size-3.5 flex-none text-adaptive-400" />
                  <span className="truncate">{shortenHome(r, home)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Reachable before any folder is open: a fresh machine usually needs git
            and a package manager before it can clone anything at all. Setup leads,
            because on a brand new machine that is the honest first move. */}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
          {missing.length > 0 ? (
            // Promoted from an 11px link to a real button, and given the reason. The
            // links below the fold were the only route to setup from here.
            <Button variant="waPrimary" size="wa" onClick={() => setPage('setup')}>
              <ListChecks className="size-3.5" />
              Install {missing.join(', ')} first
            </Button>
          ) : (
            <button
              type="button"
              onClick={() => setPage('setup')}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-adaptive-700 hover:text-adaptive-950"
            >
              <ListChecks className="size-3" />
              New machine? Install everything you need
            </button>
          )}
          <button
            type="button"
            onClick={() => setPage('toolbox')}
            className="flex items-center gap-1.5 text-[11px] text-adaptive-500 hover:text-adaptive-800"
          >
            <Wrench className="size-3" />
            Check your developer tools
          </button>
        </div>

        <p className="text-center text-[11px] text-adaptive-400">
          You can also set <code className="font-mono">WORK_ALLEY_ROOT</code> to override this.
        </p>
      </div>
    </div>
  )
}
