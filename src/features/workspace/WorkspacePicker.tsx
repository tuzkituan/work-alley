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

/** Topbar control: shows the open workspace and switches between them. */
export function WorkspaceSwitcher({ boot }: { boot: Bootstrap | undefined }) {
  const { pick, set, busy } = useSwitchWorkspace()
  const current = boot?.workspaceRoot ?? ''
  const recents = (boot?.recentRoots ?? []).filter((r) => r !== current)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          title="Switch workspace folder"
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-xs text-adaptive-500 hover:bg-adaptive-200 hover:text-adaptive-800"
        >
          <span className="truncate">{current ? shortenHome(current) : 'no workspace'}</span>
          <ChevronDown className="size-3 flex-none" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem onClick={() => pick.mutate()}>
          <FolderSearch className="size-3.5" />
          Open folder…
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
          <p className="mt-1 text-sm text-adaptive-600">
            Point Work Alley at the folder holding your repos. It looks for{' '}
            <code className="font-mono text-xs">be/</code>{' '}
            <code className="font-mono text-xs">fe/</code>{' '}
            <code className="font-mono text-xs">sa/</code>{' '}
            <code className="font-mono text-xs">ui/</code> subfolders, or a{' '}
            <code className="font-mono text-xs">repos.json</code>.
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
