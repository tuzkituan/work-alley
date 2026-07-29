import { useEffect, useMemo, useState } from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { displayName } from '@/domain/severity'
import { repoId, type Bootstrap } from '@/domain/types'
import { useUiStore } from '@/stores/ui-store'
import { useScanStore } from '@/stores/scan-store'
import { useRunAction } from '@/hooks/use-action'
import { useTheme } from '@/hooks/use-theme'
import { shortenHome, useWorkspaceActions } from '@/features/workspace/WorkspacePicker'

/**
 * A real palette, not the decorative pill the design shows.
 *
 * cmdk's default scorer is wrong for this corpus: 43 of 63 names share the prefix
 * `blazeup-subapp-`, and people type `fe/emp` or `subapp-task`. So filtering is
 * ours: match on category/name, the prefix-stripped display name and the branch,
 * with a prefix-match boost.
 */
export function CommandPalette({ boot }: { boot: Bootstrap | undefined }) {
  const open = useUiStore((s) => s.paletteOpen)
  const setOpen = useUiStore((s) => s.setPaletteOpen)
  const setActiveRepo = useUiStore((s) => s.setActiveRepo)
  const setFilterText = useUiStore((s) => s.setFilterText)
  const statuses = useScanStore((s) => s.repos)
  const run = useRunAction()
  const { toggleTheme } = useTheme()
  const workspace = useWorkspaceActions()
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const repoMatches = useMemo(() => {
    const repos = boot?.repos ?? []
    const q = query.trim().toLowerCase()
    const scored = repos.map((r) => {
      const id = repoId(r)
      const { short } = displayName(r.name)
      const branch = statuses.get(id)?.branch ?? ''
      const haystacks = [id, short, r.name, branch].map((h) => h.toLowerCase())
      let score = -1
      for (const h of haystacks) {
        if (!q) {
          score = 0
          break
        }
        const idx = h.indexOf(q)
        if (idx === 0) score = Math.max(score, 3)
        else if (idx > 0) score = Math.max(score, 1)
      }
      return { repo: r, id, short, branch, score }
    })
    return scored
      .filter((s) => s.score >= 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 40)
  }, [boot?.repos, query, statuses])

  const scriptMatches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (boot?.scripts ?? []).filter(
      (s) => !q || s.id.includes(q) || s.title.toLowerCase().includes(q) || s.file.includes(q)
    )
  }, [boot?.scripts, query])

  return (
    <CommandDialog open={open} onOpenChange={setOpen} showCloseButton={false}>
      <Command_ query={query} setQuery={setQuery}>
        <CommandList className="max-h-[420px]">
          <CommandEmpty>Nothing matches that.</CommandEmpty>

          {repoMatches.length > 0 && (
            <CommandGroup heading={`Repos (${repoMatches.length})`}>
              {repoMatches.map(({ repo, id, short, branch }) => (
                <CommandItem
                  key={id}
                  value={id}
                  onSelect={() => {
                    setActiveRepo(id)
                    setFilterText('')
                    setOpen(false)
                  }}
                >
                  <span className="w-5 font-mono text-[11px] text-adaptive-400">
                    {repo.category}
                  </span>
                  <span className="flex-1 truncate">{short}</span>
                  {branch && (
                    <span className="font-mono text-[11px] text-adaptive-400">{branch}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {scriptMatches.length > 0 && (
            <CommandGroup heading="Scripts">
              {scriptMatches.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`script:${s.id}`}
                  onSelect={() => {
                    setOpen(false)
                    run(
                      s.mode === 'headless'
                        ? { kind: 'script', script: s.id, args: [] }
                        : { kind: 'openInTerminal', script: s.id, ref: null }
                    )
                  }}
                >
                  <span className="flex-1">{s.title}</span>
                  <span className="font-mono text-[11px] text-adaptive-400">{s.file}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          <CommandGroup heading="Workspace">
            <CommandItem
              value="workspace:open"
              onSelect={() => {
                setOpen(false)
                workspace.pick.mutate()
              }}
            >
              Open a different folder…
              <span className="ml-auto font-mono text-[10px] text-adaptive-400">⌘O</span>
            </CommandItem>
            {(boot?.recentRoots ?? [])
              .filter((r) => r !== boot?.workspaceRoot)
              .map((r) => (
                <CommandItem
                  key={r}
                  value={`workspace:${r}`}
                  onSelect={() => {
                    setOpen(false)
                    workspace.set.mutate(r)
                  }}
                >
                  <span className="truncate font-mono text-xs">{shortenHome(r)}</span>
                </CommandItem>
              ))}
          </CommandGroup>

          <CommandGroup heading="Actions">
            <CommandItem
              value="action:fetch-all"
              onSelect={() => {
                setOpen(false)
                run({ kind: 'fetchAll', ref: null })
              }}
            >
              Fetch all repos
            </CommandItem>
            <CommandItem
              value="action:pull-all"
              onSelect={() => {
                setOpen(false)
                run({ kind: 'pullMany', refs: boot?.repos ?? [] })
              }}
            >
              Pull all repos
            </CommandItem>
            <CommandItem
              value="action:theme"
              onSelect={() => {
                setOpen(false)
                toggleTheme()
              }}
            >
              Toggle theme
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command_>
    </CommandDialog>
  )
}

/** Wraps the input so we control filtering entirely. */
function Command_({
  query,
  setQuery,
  children,
}: {
  query: string
  setQuery: (v: string) => void
  children: React.ReactNode
}) {
  return (
    <>
      <CommandInput
        placeholder="Search repos, branches, scripts…"
        value={query}
        onValueChange={setQuery}
      />
      {children}
    </>
  )
}
