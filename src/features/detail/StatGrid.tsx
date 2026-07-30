import { cn } from '@/lib/utils'
import { TONE_TEXT, type Tone } from '@/domain/severity'

export function Field({
  label,
  value,
  tone,
  title,
  onClick,
}: {
  label: string
  value: string
  tone?: Tone
  title?: string
  /** Makes the cell a button — used where the value implies an obvious action. */
  onClick?: () => void
}) {
  const body = (
    <>
      <span className="text-[10px] font-semibold tracking-[0.05em] text-adaptive-400 uppercase">
        {label}
      </span>
      <span
        className={cn(
          'wa-num truncate font-mono text-[13px]',
          tone ? TONE_TEXT[tone] : 'text-adaptive-800'
        )}
      >
        {value}
      </span>
    </>
  )

  if (!onClick) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5" title={title ?? value}>
        {body}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? value}
      className="flex min-w-0 flex-col gap-0.5 rounded-sm text-left hover:bg-adaptive-100"
    >
      {body}
    </button>
  )
}
