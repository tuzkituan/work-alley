import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, ChevronDown, FolderOpen, FolderSearch } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { IpcError } from '@/ipc/errors'
import type { Bootstrap } from '@/domain/types'

/** `/home/me/work-alley` -> `~/work-alley` */
export function shortenHome(p: string) {
  const home = '/home/'
  if (!p.startsWith(home)) return p
  const rest = p.slice(home.length)
  const slash = rest.indexOf('/')
  return slash === -1 ? '~' : `~${rest.slice(slash)}`
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
  const set = useMutation({
    mutationFn: (path: string) => api.setWorkspace(path),
    onSuccess: apply,
    onError: report,
  })

  return { pick, set, busy: pick.isPending || set.isPending }
}

/**
 * Topbar control: shows the open workspace and switches between them.
 *
 * Styled as a real button with a folder icon. It used to be plain grey text with a
 * chevron, which did not read as something you could click — the most important
 * control in the header was effectively invisible.
 */
export function WorkspaceSwitcher({ boot }: { boot: Bootstrap | undefined }) {
  const { pick, set, busy } = useSwitchWorkspace()
  const current = boot?.workspaceRoot ?? ''
  const recents = (boot?.recentRoots ?? []).filter((r) => r !== current)
  // The folder name alone is enough here; the full path is on hover and in the menu.
  const name = current.split('/').filter(Boolean).pop() ?? 'no workspace'

  // ⌘O / Ctrl+O is the conventional "open" shortcut, and makes this reachable
  // without hunting for the control at all.
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          title={`Workspace: ${current || 'none'} — click to switch (⌘O to open a folder)`}
          className="flex min-w-0 items-center gap-1.5 rounded-md border border-adaptive-200 bg-background px-2 py-1 text-xs font-medium text-adaptive-800 transition-shadow hover:border-adaptive-950 hover:shadow-focus-ring"
        >
          <FolderOpen className="size-3.5 flex-none text-primary-600" />
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
              <DropdownMenuItem key={r} onClick={() => set.mutate(r)} className="font-mono text-xs">
                <span className="truncate">{shortenHome(r)}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        {current && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled className="font-mono text-xs">
              <Check className="size-3.5" />
              <span className="truncate">{shortenHome(current)}</span>
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
export function WorkspaceWelcome({ boot }: { boot: Bootstrap | undefined }) {
  const { pick, set, busy } = useSwitchWorkspace()
  const recents = boot?.recentRoots ?? []

  return (
    <div className="flex h-full items-center justify-center bg-background p-10">
      <div className="flex w-full max-w-lg flex-col items-center gap-5">
        <div className="flex size-11 items-center justify-center rounded-lg bg-gradient-to-b from-[#EA580C] to-[#F97316] text-lg font-bold text-white">
          W
        </div>

        <div className="text-center">
          <h1 className="text-lg font-semibold tracking-[-0.01em]">Choose a workspace</h1>
          {/* Describes what discovery actually does. An earlier version still
              named be/ fe/ sa/ ui/ long after that stopped being the rule. */}
          <p className="mt-1 text-sm text-adaptive-600">
            Point Work Alley at any folder with git repos in it. Repos in subfolders
            keep those subfolders as groups; repos sitting directly in the folder are
            grouped by what they are — frontend, backend, library. A single project
            folder works too.
          </p>
        </div>

        <Button variant="waPrimary" size="wa" disabled={busy} onClick={() => pick.mutate()}>
          <FolderOpen className="size-3.5" />
          {busy ? 'Opening…' : 'Open folder…'}
        </Button>

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
                  <span className="truncate">{shortenHome(r)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="text-center text-[11px] text-adaptive-400">
          You can also set <code className="font-mono">WORK_ALLEY_ROOT</code> to override this.
        </p>
      </div>
    </div>
  )
}
