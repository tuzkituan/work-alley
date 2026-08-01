import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/ipc/commands'
import { useConfig, useSetConfig } from '@/features/settings/use-config'
import { SettingRow } from '@/features/settings/sections'
import type { GithubProjectListResult, GithubProjectSummary } from '@/domain/types'

function browseError(result: Exclude<GithubProjectListResult, { kind: 'ok' }>): string {
  switch (result.kind) {
    case 'ghMissing':
      return 'The gh CLI is not installed.'
    case 'notAuthenticated':
      return 'gh is not logged in.'
    case 'missingScope':
      return 'Run `gh auth refresh -s read:project` first.'
    case 'failed':
      return result.message
  }
}

/**
 * Which GitHub Projects v2 board the Projects page shows.
 *
 * Local form state, not instant-save-on-change like most of Settings: picking a
 * project is a two-step flow (type an owner, browse its projects, pick one), and
 * there is nothing sane to persist until both `owner` and `number` are chosen
 * together — unlike a single `Segmented`/`NumberField` control.
 */
export function GithubProjectSetting() {
  const { data: cfg } = useConfig()
  const save = useSetConfig()
  const [owner, setOwner] = useState('')
  const [number, setNumber] = useState('')

  // Follow the stored value whenever it changes underneath.
  useEffect(() => {
    setOwner(cfg?.githubProject?.owner ?? '')
    setNumber(cfg?.githubProject ? String(cfg.githubProject.number) : '')
  }, [cfg?.githubProject])

  const browse = useMutation({ mutationFn: (owner: string) => api.listGithubProjects(owner) })
  const projects: GithubProjectSummary[] = browse.data?.kind === 'ok' ? browse.data.projects : []

  const parsedNumber = Number(number)
  const canSave = owner.trim() !== '' && Number.isInteger(parsedNumber) && parsedNumber > 0

  return (
    <>
      <SettingRow
        label="Owner"
        hint="A GitHub user or org login that owns the board — not a repo."
      >
        <Input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="octocat"
          className="h-[30px] w-[12rem] font-mono text-xs"
        />
        <Button
          variant="waOutline"
          size="waXs"
          disabled={owner.trim() === '' || browse.isPending}
          onClick={() => browse.mutate(owner.trim())}
        >
          {browse.isPending ? 'Browsing…' : 'Browse'}
        </Button>
      </SettingRow>

      {browse.data && browse.data.kind !== 'ok' && (
        <SettingRow label="Browse result">
          <span className="text-[11.5px] text-sev-warn">{browseError(browse.data)}</span>
        </SettingRow>
      )}

      {projects.length > 0 && (
        <SettingRow label="Pick one" hint={`${projects.length} project(s) for ${owner}`}>
          <div className="flex max-w-[26rem] flex-wrap justify-end gap-1.5">
            {projects.map((p) => (
              <button
                key={p.number}
                type="button"
                onClick={() => setNumber(String(p.number))}
                className="rounded-md border border-adaptive-200 px-2 py-1 text-left text-[11.5px] hover:border-primary-600 hover:text-primary-600"
                title={p.url}
              >
                #{p.number} {p.title}
                {p.closed && ' (closed)'}
              </button>
            ))}
          </div>
        </SettingRow>
      )}

      <SettingRow label="Project number" hint="Filled in by Browse, or type one you already know.">
        <Input
          type="number"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="1"
          className="h-[30px] w-[7rem] text-xs"
        />
      </SettingRow>

      <SettingRow label="Save">
        <Button
          variant="waPrimary"
          size="waXs"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate({ githubProject: { owner: owner.trim(), number: parsedNumber } })}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {cfg?.githubProject && (
          <Button
            variant="waGhost"
            size="waXs"
            disabled={save.isPending}
            onClick={() => save.mutate({ githubProject: null })}
          >
            Clear
          </Button>
        )}
      </SettingRow>
    </>
  )
}
