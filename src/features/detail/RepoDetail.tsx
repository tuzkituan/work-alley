import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MonoChip, SectionLabel, StatePill, StatusDot } from '@/components/wa/primitives'
import { RepoMenu } from '@/features/repos/RepoMenu'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { derive, displayName, taskOf, TONE_TEXT, type Tone } from '@/domain/severity'
import type { ChangedFile, PullRequest, RepoId, RepoRef } from '@/domain/types'
import { useScanStore } from '@/stores/scan-store'
import { useUiStore } from '@/stores/ui-store'
import { useRunStore } from '@/stores/run-store'
import { useRunAction } from '@/hooks/use-action'

export function RepoDetail({ repoId: id }: { repoId: RepoId }) {
  const closeDetail = useUiStore((s) => s.closeDetail)
  const status = useScanStore((s) => s.repos.get(id))
  const uiLatest = useScanStore((s) => s.uiLatest)
  const runningHere = useRunStore((s) => s.runningByScope[id] ?? 0)
  const run = useRunAction()

  const [category, ...rest] = id.split('/')
  const name = rest.join('/')
  const repo = { category, name } as RepoRef
  const { short, prefix } = displayName(name)

  const d = status ? derive(status, uiLatest) : null
  const dev = taskOf(status, 'dev')
  const sb = taskOf(status, 'storybook')
  const devUp = dev?.state === 'up' || dev?.state === 'starting'
  const hasStorybook = status?.availableTasks.includes('storybook') ?? false

  return (
    <div className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
      <div className="flex flex-col gap-3.5">
        {/* --- header ------------------------------------------------------- */}
        <div className="flex flex-col gap-2.5 rounded-lg border border-adaptive-200 bg-card p-3.5">
          <div className="flex items-center gap-2">
            <Button variant="waGhost" size="waIcon" onClick={closeDetail} title="Back to the list">
              <ArrowLeft className="size-4" />
            </Button>
            {d ? <StatusDot tone={d.tone} size={9} /> : <StatusDot tone="idle" size={9} />}
            <h1 className="truncate text-base font-semibold tracking-[-0.01em]">{short}</h1>
            <MonoChip>{category}/</MonoChip>
            {prefix && <span className="font-mono text-[11px] text-adaptive-400">{prefix}</span>}
            {d && <StatePill tone={d.tone} label={d.stateLabel} />}
            <div className="flex-1" />
            {runningHere > 0 && (
              <span className="flex items-center gap-1.5 rounded-full border border-info-500/[0.38] bg-blue-500/[0.12] px-2 py-0.5 text-[11px] text-sev-info">
                <span
                  className="size-1.5 rounded-full bg-sev-info"
                  style={{ animation: 'wa-blink 1.4s step-end infinite' }}
                />
                {runningHere} running
              </span>
            )}
            <RepoMenu repo={repo} status={status} />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-1 font-mono text-[11.5px] text-adaptive-500">
            <span title={status?.path ?? undefined} className="truncate">
              {status?.path ?? id}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2.5 border-t border-adaptive-200 pt-2.5 sm:grid-cols-4">
            <Field label="Branch" value={status?.detached ? '(detached)' : (status?.branch ?? '—')} />
            <Field label="Sync" value={d?.syncLabel ?? '—'} tone={d?.syncTone} />
            <Field label="Changes" value={d?.dirtyLabel ?? '—'} tone={d?.dirtyTone} />
            <Field
              label="blazeup-ui"
              value={status?.uiDep.resolved ?? (status?.uiDep.declared ? 'n/a' : '—')}
              tone={
                status?.uiDep.resolved && uiLatest && status.uiDep.resolved !== uiLatest
                  ? 'warn'
                  : 'idle'
              }
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5 border-t border-adaptive-200 pt-2.5">
            <Button variant="waOutline" size="waSm" onClick={() => run({ kind: 'pull', ref: repo })}>
              Pull
            </Button>
            <Button
              variant="waOutline"
              size="waSm"
              onClick={() => run({ kind: 'fetchAll', ref: repo })}
            >
              Fetch
            </Button>
            <Button
              variant="waOutline"
              size="waSm"
              onClick={() => run({ kind: 'status', ref: repo })}
            >
              Status
            </Button>
            <Button
              variant={devUp ? 'waDanger' : 'waOutline'}
              size="waSm"
              onClick={() => run({ kind: devUp ? 'devStop' : 'devStart', ref: repo, task: 'dev' })}
            >
              {devUp ? `Stop dev${dev?.port ? ` :${dev.port}` : ''}` : 'Start dev'}
            </Button>
            {hasStorybook && (
              <Button
                variant={sb ? 'waDanger' : 'waOutline'}
                size="waSm"
                onClick={() =>
                  run({ kind: sb ? 'devStop' : 'devStart', ref: repo, task: 'storybook' })
                }
              >
                {sb ? `Stop Storybook${sb.port ? ` :${sb.port}` : ''}` : 'Run Storybook'}
              </Button>
            )}
            {dev?.url && devUp && (
              <Button
                variant="waPrimary"
                size="waSm"
                onClick={() => void openUrl(dev.url!).catch(() => {})}
              >
                Open {dev.url.replace('http://', '')}
              </Button>
            )}
          </div>
        </div>

        {/* --- tabs --------------------------------------------------------- */}
        <Tabs defaultValue="prs">
          <TabsList>
            <TabsTrigger value="prs">Pull requests</TabsTrigger>
            <TabsTrigger value="changes">Changes</TabsTrigger>
            <TabsTrigger value="commits">Commits</TabsTrigger>
            <TabsTrigger value="branches">Branches</TabsTrigger>
          </TabsList>

          <TabsContent value="prs">
            <PullRequestsPanel repo={repo} id={id} />
          </TabsContent>
          <TabsContent value="changes">
            <ChangesPanel repo={repo} id={id} />
          </TabsContent>
          <TabsContent value="commits">
            <CommitsPanel repo={repo} id={id} />
          </TabsContent>
          <TabsContent value="branches">
            <BranchesPanel repo={repo} id={id} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function Field({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-semibold tracking-[0.05em] text-adaptive-400 uppercase">
        {label}
      </span>
      <span
        className={cn('wa-num truncate font-mono text-[13px]', tone ? TONE_TEXT[tone] : 'text-adaptive-800')}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-adaptive-200 bg-card">
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-4 text-xs text-adaptive-500">{children}</div>
}

function Rows({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 p-3">{children}</div>
}

// ---------------------------------------------------------------- PRs --------

const REVIEW_META: Record<string, { label: string; tone: Tone }> = {
  APPROVED: { label: 'approved', tone: 'ok' },
  CHANGES_REQUESTED: { label: 'changes requested', tone: 'err' },
  REVIEW_REQUIRED: { label: 'review required', tone: 'warn' },
}

function PullRequestsPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const { data, isPending, isFetching, refetch, error } = useQuery({
    queryKey: keys.prs(id),
    queryFn: () => api.listPullRequests(repo),
    // gh hits the network; don't hammer it while clicking around.
    staleTime: 60_000,
  })

  if (isPending) {
    return (
      <Panel>
        <Rows>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </Rows>
      </Panel>
    )
  }

  if (error) {
    return (
      <Panel>
        <Empty>Could not load pull requests: {error.message}</Empty>
      </Panel>
    )
  }

  // Every failure mode is a state to render, not an exception.
  if (data?.kind === 'ghMissing') {
    return (
      <Panel>
        <Empty>
          The GitHub CLI is not installed, so pull requests cannot be listed. Install{' '}
          <code className="font-mono">gh</code> and reopen this page.
        </Empty>
      </Panel>
    )
  }
  if (data?.kind === 'notAuthenticated') {
    return (
      <Panel>
        <Empty>
          <code className="font-mono">gh</code> is not logged in. Run{' '}
          <code className="font-mono">gh auth login</code> in a terminal.
          <div className="mt-1 font-mono text-[11px] text-adaptive-400">{data.message}</div>
        </Empty>
      </Panel>
    )
  }
  if (data?.kind === 'noRemote') {
    return (
      <Panel>
        <Empty>This repo has no <code className="font-mono">origin</code> remote.</Empty>
      </Panel>
    )
  }
  if (data?.kind === 'failed') {
    return (
      <Panel>
        <Empty>
          Could not list pull requests.
          <div className="mt-1 font-mono text-[11px] text-adaptive-400">{data.message}</div>
        </Empty>
      </Panel>
    )
  }

  const prs = data?.kind === 'ok' ? data.prs : []
  const slug = data?.kind === 'ok' ? data.slug : ''

  return (
    <Panel>
      <div className="flex items-center gap-2 border-b border-adaptive-200 px-3 py-2">
        <GitPullRequest className="size-3.5 text-adaptive-400" />
        <SectionLabel>{prs.length} open</SectionLabel>
        <span className="truncate font-mono text-[11px] text-adaptive-400">{slug}</span>
        <div className="flex-1" />
        <Button
          variant="waOutline"
          size="waXs"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {prs.length === 0 ? (
        <Empty>No open pull requests.</Empty>
      ) : (
        prs.map((pr) => <PrRow key={pr.number} pr={pr} />)
      )}
    </Panel>
  )
}

function PrRow({ pr }: { pr: PullRequest }) {
  const review = REVIEW_META[pr.reviewDecision]
  return (
    <button
      type="button"
      onClick={() => void openUrl(pr.url).catch(() => {})}
      className="flex w-full items-center gap-3 border-b border-adaptive-200 px-3 py-2.5 text-left last:border-b-0 hover:bg-adaptive-100/60"
    >
      <span className="wa-num w-12 flex-none font-mono text-[11px] text-primary-600">
        #{pr.number}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{pr.title}</span>
          {pr.isDraft && (
            <span className="flex-none rounded-sm border border-adaptive-300 px-1 text-[10px] text-adaptive-500">
              draft
            </span>
          )}
          {pr.isMine && (
            <span className="flex-none rounded-sm border border-primary-600 px-1 text-[10px] text-primary-600">
              mine
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-adaptive-500">
          <span className="truncate">{pr.headRef}</span>
          <span className="text-adaptive-300">→</span>
          <span>{pr.baseRef}</span>
          <span className="text-adaptive-300">·</span>
          <span>{pr.author}</span>
        </div>
      </div>

      <span className="wa-num hidden flex-none font-mono text-[11px] lg:block">
        <span className="text-sev-ok">+{pr.additions}</span>{' '}
        <span className="text-sev-err">−{pr.deletions}</span>{' '}
        <span className="text-adaptive-400">
          {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
        </span>
      </span>

      {review && (
        <span className={cn('w-32 flex-none text-right text-[11px]', TONE_TEXT[review.tone])}>
          {review.label}
        </span>
      )}

      <span className="wa-num w-10 flex-none text-right font-mono text-[11px] text-adaptive-400">
        {pr.updatedRelative}
      </span>

      <ExternalLink className="size-3 flex-none text-adaptive-400" />
    </button>
  )
}

// ------------------------------------------------------------- changes -------

function ChangesPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const { data, isPending } = useQuery({
    queryKey: keys.changedFiles(id),
    queryFn: () => api.listChangedFiles(repo),
    staleTime: 10_000,
  })

  if (isPending) {
    return (
      <Panel>
        <Rows>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </Rows>
      </Panel>
    )
  }

  const files = data ?? []
  if (files.length === 0) {
    return (
      <Panel>
        <Empty>The working tree is clean.</Empty>
      </Panel>
    )
  }

  return (
    <Panel>
      {files.map((f) => (
        <FileRow key={f.path} file={f} />
      ))}
    </Panel>
  )
}

function FileRow({ file }: { file: ChangedFile }) {
  const tone: Tone = file.conflicted
    ? 'err'
    : file.untracked
      ? 'info'
      : file.staged
        ? 'ok'
        : 'warn'
  const label = file.conflicted
    ? 'conflict'
    : file.untracked
      ? 'untracked'
      : file.staged
        ? 'staged'
        : 'modified'

  return (
    <div className="flex items-center gap-3 border-b border-adaptive-200 px-3 py-1.5 last:border-b-0">
      <span className={cn('w-8 flex-none font-mono text-[11px]', TONE_TEXT[tone])}>
        {file.code.trim() || '??'}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-adaptive-800">
        {file.path}
      </span>
      <span className={cn('w-20 flex-none text-right text-[11px]', TONE_TEXT[tone])}>{label}</span>
    </div>
  )
}

// ------------------------------------------------------------- commits -------

function CommitsPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const { data, isPending } = useQuery({
    queryKey: keys.repoCommits(id),
    queryFn: () => api.repoCommits(repo, 30),
    staleTime: 30_000,
  })

  if (isPending) {
    return (
      <Panel>
        <Rows>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </Rows>
      </Panel>
    )
  }

  const commits = data ?? []
  if (commits.length === 0) {
    return (
      <Panel>
        <Empty>No commits found.</Empty>
      </Panel>
    )
  }

  return (
    <Panel>
      {commits.map((c) => (
        <div
          key={c.sha}
          className="flex items-center gap-3 border-b border-adaptive-200 px-3 py-2 last:border-b-0"
        >
          <span className="w-14 flex-none font-mono text-[11px] text-primary-600">{c.sha}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-adaptive-800" title={c.subject}>
            {c.subject}
          </span>
          <span className="hidden w-32 flex-none truncate text-[11px] text-adaptive-500 lg:block">
            {c.author}
          </span>
          <span className="wa-num w-10 flex-none text-right text-[11px] text-adaptive-400">
            {c.relative}
          </span>
        </div>
      ))}
    </Panel>
  )
}

// ------------------------------------------------------------ branches -------

function BranchesPanel({ repo, id }: { repo: RepoRef; id: RepoId }) {
  const current = useScanStore((s) => s.repos.get(id)?.branch)
  const { data, isPending } = useQuery({
    queryKey: keys.branches(id),
    queryFn: () => api.listBranches(repo),
    staleTime: 60_000,
  })

  if (isPending) {
    return (
      <Panel>
        <Rows>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </Rows>
      </Panel>
    )
  }

  const branches = data ?? []
  if (branches.length === 0) {
    return (
      <Panel>
        <Empty>No branches found.</Empty>
      </Panel>
    )
  }

  return (
    <Panel>
      {branches.map((b) => (
        <div
          key={b}
          className="flex items-center gap-3 border-b border-adaptive-200 px-3 py-1.5 last:border-b-0"
        >
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-[11.5px]',
              b === current ? 'font-semibold text-primary-600' : 'text-adaptive-800'
            )}
          >
            {b}
          </span>
          {b === current && (
            <span className="flex-none text-[11px] text-adaptive-500">checked out</span>
          )}
        </div>
      ))}
    </Panel>
  )
}
