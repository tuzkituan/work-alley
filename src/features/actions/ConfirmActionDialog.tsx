import { useEffect, useMemo, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MANAGERS, repoId } from '@/domain/types'
import { useQuery } from '@tanstack/react-query'
import { useActionStore } from '@/hooks/use-action'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { useScanStore } from '@/stores/scan-store'

export function ConfirmActionDialog() {
  const intent = useActionStore((s) => s.intent)
  const spec = useActionStore((s) => s.spec)
  const useManager = useActionStore((s) => s.useManager)
  const submitting = useActionStore((s) => s.submitting)
  const confirm = useActionStore((s) => s.confirm)
  const recheck = useActionStore((s) => s.recheck)
  const dismiss = useActionStore((s) => s.dismiss)

  const [typed, setTyped] = useState('')
  const [remaining, setRemaining] = useState(0)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const phrase = intent?.requiresTypedConfirm ?? null
  const danger = intent?.danger === 'high'

  useEffect(() => {
    setTyped('')
  }, [intent?.id])

  // One interval, not one per render.
  useEffect(() => {
    if (!intent) return
    const tick = () => setRemaining(Math.max(0, intent.expiresUnix - Math.floor(Date.now() / 1000)))
    tick()
    const h = setInterval(tick, 1000)
    return () => clearInterval(h)
  }, [intent])

  // For a destructive action, autofocus Cancel — a muscle-memory Enter must not
  // hard-reset 18 repos.
  useEffect(() => {
    if (intent && danger) cancelRef.current?.focus()
  }, [intent, danger])

  // Only the three that go through a package manager; `cargo run` has no such
  // choice to offer and a row of greyed buttons would imply it does.
  const managerSpec =
    spec?.kind === 'runScript' || spec?.kind === 'devStart' || spec?.kind === 'runChore'
  const chosen = managerSpec ? (spec.manager ?? null) : null
  // What the repo's own files say, so Auto can name it rather than being a word
  // that means "something, and you would have to read the argv to find out".
  const declared = useScanStore((s) =>
    managerSpec ? (s.repos.get(repoId(spec.ref))?.packageManager ?? null) : null
  )
  // From the bootstrap cache, so this costs nothing — the same trick RepoMenu uses.
  const { data: boot } = useQuery({ queryKey: keys.bootstrap, enabled: false })
  // The repo's own answer, else the machine's. Never a hardcoded name: naming the
  // wrong one on the dialog that says what is about to run is the worst place for
  // it.
  const detected =
    declared ?? (boot as { packageManager?: string | null } | undefined)?.packageManager ?? null

  const expired = remaining <= 0
  const canConfirm = !expired && !submitting && (!phrase || typed === phrase)

  const countdown = useMemo(() => {
    const m = Math.floor(remaining / 60)
    const s = remaining % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }, [remaining])

  if (!intent) return null

  return (
    <AlertDialog open onOpenChange={(open) => !open && dismiss()}>
      <AlertDialogContent className="wa-scroll max-h-[85vh] max-w-[560px] gap-4 overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base">
            {danger && <TriangleAlert className="size-4 text-error-500" />}
            {intent.title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-adaptive-600">
            {intent.description}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* The manager, where the argv that names it is on screen.
            
            This is the one surface every script, dev start and package chore
            passes through, whichever button started it — putting the choice in
            each of those buttons instead meant the list row, the card and the
            Build menu all needed one, and the dialog would still be the first
            place you *saw* which manager was about to run. */}
        {managerSpec && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold tracking-[0.05em] text-adaptive-500 uppercase">
              With
            </span>
            <div className="flex items-center overflow-hidden rounded-md border border-adaptive-200">
              {/* Auto first and selected by default — the repo's own lockfile or
                  `packageManager` field is the right answer almost always, and a
                  row where nothing is selected reads as "no default" rather than
                  "we already worked it out". It names what it detected, so the
                  choice is between two known things. */}
              <Button
                variant={chosen === null ? 'waPrimary' : 'waGhost'}
                size="waXs"
                aria-pressed={chosen === null}
                className="rounded-none border-0"
                disabled={submitting}
                title={
                  declared
                    ? `What this repo's own files say — ${declared}`
                    : detected
                      ? `This repo says nothing, so your default is used — ${detected}`
                      : 'Resolved when it runs'
                }
                onClick={() => void useManager(null)}
              >
                Auto
                {detected && (
                  <span className="font-mono text-[10px] opacity-70">{detected}</span>
                )}
              </Button>
              {MANAGERS.map((m) => (
                <Button
                  key={m}
                  variant={chosen === m ? 'waPrimary' : 'waGhost'}
                  size="waXs"
                  aria-pressed={chosen === m}
                  className="rounded-none border-0 font-mono"
                  disabled={submitting}
                  onClick={() => void useManager(m)}
                >
                  {m}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* What will run. For a bulk action this is the per-repo command plus the
            target list below — dumping the whole generated script here produced an
            unreadable wall of text that overflowed the window. */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-[0.05em] text-adaptive-500 uppercase">
            {intent.perTarget ? `Command — run in each of ${intent.targets.length} repos` : 'Command'}
          </span>
          <pre className="max-h-32 overflow-auto rounded-md border border-adaptive-200 bg-adaptive-100 p-2.5 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap">
            {intent.argvPreview.join(' ')}
          </pre>
          {!intent.perTarget && (
            <span className="font-mono text-[11px] text-adaptive-500">in {intent.cwd}</span>
          )}

          {intent.fullArgv && (
            <details className="mt-0.5">
              <summary className="cursor-pointer text-[11px] text-adaptive-500 hover:text-adaptive-800">
                Show the full script
              </summary>
              <pre className="wa-scroll mt-1 max-h-40 overflow-auto rounded-md border border-adaptive-200 bg-adaptive-100 p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre">
                {intent.fullArgv.join(' ')}
              </pre>
            </details>
          )}
        </div>

        {intent.warnings.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {intent.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-adaptive-700">
                <TriangleAlert className="mt-0.5 size-3.5 flex-none text-warning-500" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}

        {intent.targets.length > 1 && (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold tracking-[0.05em] text-adaptive-500 uppercase">
              {intent.targets.length} repos affected
            </span>
            <div className="wa-scroll max-h-32 overflow-y-auto rounded-md border border-adaptive-200">
              {intent.targets.map((t) => (
                <div
                  key={`${t.category}/${t.name}`}
                  className="flex items-center gap-2 border-b border-adaptive-200 px-2 py-1 text-xs last:border-b-0"
                >
                  {/* `w-16 flex-none truncate`, not `w-5`. The old 20px was sized
                      for two-letter folders like `fe`; a flat-workspace category is
                      a detected kind or a language — "frontend", "mobile", "c++" —
                      and with no truncation and no flex-none those ran straight
                      under the repo name. */}
                  <span
                    className="w-16 flex-none truncate font-mono text-[11px] text-adaptive-400"
                    title={t.category}
                  >
                    {t.category}
                  </span>
                  <span className="min-w-0 truncate text-adaptive-800" title={t.name}>
                    {t.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {phrase && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="typed-confirm" className="text-xs">
              Type <span className="font-mono font-semibold text-error-500">{phrase}</span> to
              confirm
            </Label>
            <Input
              id="typed-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="h-8 font-mono text-xs"
            />
          </div>
        )}

        <AlertDialogFooter className="items-center sm:justify-between">
          <span
            className={cn(
              'wa-num font-mono text-[11px]',
              expired ? 'text-error-500' : remaining < 10 ? 'text-error-500' : 'text-adaptive-400'
            )}
          >
            {expired ? 'confirmation expired' : `expires in ${countdown}`}
          </span>

          <div className="flex items-center gap-2">
            <AlertDialogCancel ref={cancelRef} asChild>
              <Button variant="waOutline" size="wa">
                Cancel
              </Button>
            </AlertDialogCancel>

            {expired ? (
              <Button variant="waPrimary" size="wa" onClick={() => void recheck()}>
                Re-check
              </Button>
            ) : (
              <AlertDialogAction asChild>
                <Button
                  variant={danger ? 'waDanger' : 'waPrimary'}
                  size="wa"
                  disabled={!canConfirm}
                  onClick={(e) => {
                    // Radix closes the dialog on action click; we drive closing
                    // ourselves so a rejected run can keep it open.
                    e.preventDefault()
                    void confirm(phrase ? typed : undefined)
                  }}
                >
                  {submitting ? 'Running…' : danger ? 'Yes, do it' : 'Run'}
                </Button>
              </AlertDialogAction>
            )}
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
