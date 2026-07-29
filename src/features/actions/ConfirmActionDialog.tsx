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
import { useActionStore } from '@/hooks/use-action'
import { cn } from '@/lib/utils'

export function ConfirmActionDialog() {
  const intent = useActionStore((s) => s.intent)
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
                  <span className="w-5 font-mono text-[11px] text-adaptive-400">{t.category}</span>
                  <span className="text-adaptive-800">{t.name}</span>
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
