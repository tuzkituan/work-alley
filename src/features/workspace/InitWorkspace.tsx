import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FolderOpen,
  GitBranch,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'
import { api } from '@/ipc/commands'
import { IpcError } from '@/ipc/errors'
import { useRunAction } from '@/hooks/use-action'
import { useRunStore } from '@/stores/run-store'
import { shortenHome } from './WorkspacePicker'
import { parseCloneLog, tally, type CloneResult, type CloneState } from './clone-log'
import type { Bootstrap, ParsedRepoUrl } from '@/domain/types'

const PLACEHOLDER = `git@github.com:acme/web.git
git@github.com:acme/api.git
https://github.com/acme/design-system.git

# blank lines and # comments are ignored`

/**
 * First-run setup: paste the remotes, clone them all into one folder.
 *
 * This exists because the alternative first run is a dead end — the picker only
 * accepts a folder that already contains repos, so someone starting on a new
 * machine had nothing to point it at.
 *
 * Validation runs in the backend as the user types, against the same parser the
 * clone action uses. Two parsers would eventually disagree, and the one that
 * matters is the one deciding what directory gets written to.
 */
export function InitWorkspace({
  boot,
  onCancel,
  onDone,
}: {
  boot: Bootstrap | undefined
  onCancel: () => void
  onDone: (path: string) => void
}) {
  const home = boot?.homeDir ?? null
  const [folder, setFolder] = useState<{ path: string; entryCount: number } | null>(null)
  const [text, setText] = useState('')
  const run = useRunAction()

  const pick = useMutation({
    mutationFn: () => api.pickFolder(),
    onSuccess: (picked) => {
      if (picked) setFolder(picked)
    },
    onError: (e) =>
      toast.error('Could not open that folder', {
        description: e instanceof IpcError || e instanceof Error ? e.message : String(e),
      }),
  })

  // Debounced so a fast typist does not fire a command per keystroke.
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 200)
    return () => clearTimeout(t)
  }, [text])

  const { data: parsed } = useQuery({
    queryKey: ['cloneUrls', debounced],
    queryFn: () => api.parseCloneUrls(debounced),
    enabled: debounced.trim().length > 0,
  })

  const repos = parsed?.repos ?? []
  const rejected = parsed?.rejected ?? []
  const ready = !!folder && repos.length > 0 && rejected.length === 0

  // What the running clone was asked to do. Kept separately from `repos` so the
  // progress screen still knows the full set after the textarea is out of view,
  // and so a retry can resubmit just the failures.
  const [submitted, setSubmitted] = useState<ParsedRepoUrl[]>([])

  // The clone streams into a run; this screen shows it inline, because there is
  // no dashboard to show an output pane in until the clone has succeeded.
  const cloneRunId = useCloneRun()

  const start = (urls: string[]) => {
    if (!folder || urls.length === 0) return
    setSubmitted(repos.filter((r) => urls.includes(r.url)))
    run({ kind: 'cloneUrls', root: folder.path, urls })
  }

  if (cloneRunId) {
    return (
      <CloneProgress
        runId={cloneRunId}
        folder={folder?.path ?? ''}
        home={home}
        urls={submitted}
        onRetry={start}
        onDone={() => folder && onDone(folder.path)}
      />
    )
  }

  return (
    <div className="wa-scroll h-full overflow-y-auto bg-background p-10">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
        <div className="flex items-center gap-2">
          <Button variant="waGhost" size="waIcon" onClick={onCancel} title="Back">
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-lg font-semibold tracking-[-0.01em]">Set up a workspace</h1>
        </div>

        {/* --- step 1: where ------------------------------------------------ */}
        <div className="flex flex-col gap-2">
          <SectionLabel>1 · Folder</SectionLabel>
          <div className="flex items-center gap-2">
            <Button variant="waOutline" size="wa" disabled={pick.isPending} onClick={() => pick.mutate()}>
              <FolderOpen className="size-3.5" />
              {folder ? 'Change folder…' : 'Choose folder…'}
            </Button>
            {folder && (
              <span className="min-w-0 truncate font-mono text-xs text-adaptive-700">
                {shortenHome(folder.path, home)}
              </span>
            )}
          </div>
          {folder && folder.entryCount > 0 && (
            <p className="text-[11px] text-sev-warn">
              That folder already has {folder.entryCount} item
              {folder.entryCount === 1 ? '' : 's'} in it. Existing folders are skipped, never
              overwritten.
            </p>
          )}
        </div>

        {/* --- step 2: what ------------------------------------------------- */}
        <div className="flex flex-col gap-2">
          <SectionLabel>2 · Repository URLs</SectionLabel>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={10}
            placeholder={PLACEHOLDER}
            className="wa-scroll w-full resize-y rounded-lg border border-adaptive-200 bg-card p-3 font-mono text-xs text-adaptive-900 placeholder:text-adaptive-400 focus:border-adaptive-950 focus:shadow-focus-ring focus:outline-none"
          />
          <p className="text-[11px] text-adaptive-500">
            One per line. SSH (<code className="font-mono">git@host:org/repo</code>) or HTTPS.
            Each repo is cloned into a folder named after it, then sorted into groups
            automatically by what it turns out to be.
          </p>
        </div>

        {/* --- validation --------------------------------------------------- */}
        {repos.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <SectionLabel>{repos.length} repositories</SectionLabel>
              <span className="h-px flex-1 bg-adaptive-200" />
            </div>
            <div className="flex flex-wrap gap-1">
              {repos.map((r) => (
                <span
                  key={r.url}
                  title={r.url}
                  className="flex items-center gap-1 rounded-[5px] border border-adaptive-200 bg-card px-1.5 py-0.5 font-mono text-[11px] text-adaptive-700"
                >
                  <GitBranch className="size-2.5 flex-none text-adaptive-400" />
                  {r.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {rejected.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-error-500 bg-card p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-sev-err">
              <CircleAlert className="size-3.5" />
              {rejected.length} line{rejected.length === 1 ? '' : 's'} cannot be used
            </div>
            {rejected.map((r) => (
              <div key={r.line} className="flex gap-2 font-mono text-[11px]">
                <span className="w-8 flex-none text-right text-adaptive-400">{r.line}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-adaptive-700">{r.text}</span>
                  <span className="text-sev-err">{r.reason}</span>
                </span>
              </div>
            ))}
            <p className="text-[11px] text-adaptive-500">
              Fix or remove these lines to continue — cloning a subset silently would
              leave you wondering later which repos you are missing.
            </p>
          </div>
        )}

        {/* --- step 3: go --------------------------------------------------- */}
        <div className="flex items-center gap-2 border-t border-adaptive-200 pt-4">
          <Button
            variant="waPrimary"
            size="wa"
            disabled={!ready}
            onClick={() => start(repos.map((r) => r.url))}
          >
            {repos.length > 0 ? `Clone ${repos.length} repositories` : 'Clone repositories'}
          </Button>
          <Button variant="waOutline" size="wa" onClick={onCancel}>
            Cancel
          </Button>
          {!folder && <span className="text-[11px] text-adaptive-500">Choose a folder first.</span>}
        </div>
      </div>
    </div>
  )
}

/** The id of a running or finished `cloneUrls` run, if this screen started one. */
function useCloneRun(): string | null {
  const runs = useRunStore((s) => s.runs)
  const order = useRunStore((s) => s.order)
  return useMemo(() => {
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i]
      if (!id) continue
      const r = runs.get(id)
      if (r?.summary.kind === 'cloneUrls') return r.runId
    }
    return null
  }, [runs, order])
}

/**
 * Live per-repo clone results.
 *
 * A flat log is the wrong shape here: `git clone --progress` for 40 repos is
 * thousands of lines, and the one thing the user needs afterwards — which repos
 * failed and why — is buried in it. So the log is parsed back into a row per
 * repository, with git's own error text kept against the repo it belongs to.
 */
function CloneProgress({
  runId,
  folder,
  home,
  urls,
  onRetry,
  onDone,
}: {
  runId: string
  folder: string
  home: string | null
  urls: ParsedRepoUrl[]
  onRetry: (urls: string[]) => void
  onDone: () => void
}) {
  const run = useRunStore((s) => s.runs.get(runId))
  const dismiss = useRunStore((s) => s.dismiss)

  const results = useMemo(() => parseCloneLog(run?.lines ?? []), [run?.lines])
  const counts = tally(results)
  const status = run?.summary.status
  const running = status?.kind === 'running'

  // Repos in the request that the log has not mentioned yet.
  const seen = new Set(results.map((r) => r.name))
  const queued = urls.filter((u) => !seen.has(u.name))

  const retryFailed = () => {
    const byName = new Map(urls.map((u) => [u.name, u.url]))
    const again = counts.failed.map((f) => byName.get(f.name)).filter((u): u is string => !!u)
    if (again.length === 0) return
    // The finished run is dismissed first, or this screen would keep rendering it
    // instead of the retry.
    dismiss(runId)
    onRetry(again)
  }

  const title = running
    ? 'Cloning…'
    : counts.failed.length > 0
      ? `${counts.failed.length} of ${results.length} could not be cloned`
      : 'All repositories cloned'

  return (
    <div className="flex h-full flex-col bg-background p-10">
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.01em]">{title}</h1>
          <p className="mt-1 font-mono text-xs text-adaptive-500">{shortenHome(folder, home)}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
          <span className="text-sev-ok">{counts.ok} cloned</span>
          {counts.cloning > 0 && <span className="text-sev-info">{counts.cloning} in progress</span>}
          {queued.length > 0 && <span className="text-adaptive-400">{queued.length} queued</span>}
          {counts.skipped > 0 && <span className="text-sev-warn">{counts.skipped} skipped</span>}
          {counts.failed.length > 0 && (
            <span className="text-sev-err">{counts.failed.length} failed</span>
          )}
        </div>

        <div className="wa-scroll min-h-0 flex-1 overflow-y-auto rounded-lg border border-adaptive-200 bg-card">
          {results.map((r) => (
            <CloneRow key={r.name} result={r} />
          ))}
          {queued.map((u) => (
            <div
              key={u.name}
              className="flex items-center gap-2 border-b border-adaptive-200 px-3 py-2 last:border-b-0"
            >
              <span className="size-1.5 flex-none rounded-full bg-adaptive-300" />
              <span className="flex-1 truncate font-mono text-xs text-adaptive-400">{u.name}</span>
              <span className="text-[11px] text-adaptive-400">queued</span>
            </div>
          ))}
          {results.length === 0 && queued.length === 0 && (
            <div className="px-3 py-2.5 text-xs text-adaptive-500">Starting…</div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              variant="waDanger"
              size="wa"
              onClick={() => void api.cancelRun(runId).catch(() => {})}
            >
              Stop
            </Button>
          ) : (
            <>
              {counts.failed.length > 0 && (
                <Button variant="waPrimary" size="wa" onClick={retryFailed}>
                  <RefreshCw className="size-3.5" />
                  Retry {counts.failed.length} failed
                </Button>
              )}
              <Button
                variant={counts.failed.length > 0 ? 'waOutline' : 'waPrimary'}
                size="wa"
                disabled={counts.ok + counts.skipped === 0}
                onClick={onDone}
              >
                Open the workspace
              </Button>
            </>
          )}
          {!running && counts.failed.length > 0 && (
            <span className="text-[11px] text-adaptive-500">
              Retrying re-clones only the failures; anything already cloned is left
              alone.
            </span>
          )}
          {!running && counts.ok + counts.skipped === 0 && (
            <span className="text-[11px] text-adaptive-500">
              Nothing was cloned, so there is no workspace to open yet.
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

const STATE_DOT: Record<CloneState, string> = {
  cloning: 'bg-sev-info',
  ok: 'bg-sev-ok',
  skipped: 'bg-sev-warn',
  failed: 'bg-sev-err',
}

/**
 * One repository. Failures are expanded by default and carry git's own output —
 * a collapsed failure is a failure nobody reads.
 */
function CloneRow({ result }: { result: CloneResult }) {
  const [open, setOpen] = useState(result.state === 'failed')
  const hasDetail = result.detail.length > 0

  return (
    <div className="border-b border-adaptive-200 last:border-b-0">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className={cn('size-1.5 flex-none rounded-full', STATE_DOT[result.state])}
          style={result.state === 'cloning' ? { animation: 'wa-blink 1.4s step-end infinite' } : undefined}
        />
        <span className="flex-1 truncate font-mono text-xs text-adaptive-800">{result.name}</span>
        {result.state === 'failed' && result.hint && (
          <span className="hidden max-w-[55%] truncate text-[11px] text-sev-err sm:block">
            {result.hint}
          </span>
        )}
        <span
          className={cn(
            'flex-none text-[11px]',
            result.state === 'failed'
              ? 'text-sev-err'
              : result.state === 'ok'
                ? 'text-sev-ok'
                : 'text-adaptive-500'
          )}
        >
          {result.state === 'cloning' ? 'cloning' : result.state}
        </span>
        {hasDetail &&
          (open ? (
            <ChevronDown className="size-3 flex-none text-adaptive-400" />
          ) : (
            <ChevronRight className="size-3 flex-none text-adaptive-400" />
          ))}
      </button>

      {open && hasDetail && (
        <div className="flex flex-col gap-1.5 border-t border-adaptive-200 bg-adaptive-100 px-3 py-2">
          {result.hint && <p className="text-[11.5px] text-adaptive-700">{result.hint}</p>}
          <pre className="wa-scroll max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-adaptive-600">
            {result.detail.join('\n')}
          </pre>
        </div>
      )}
    </div>
  )
}
