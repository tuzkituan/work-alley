import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionLabel } from '@/components/wa/primitives'
import { cn } from '@/lib/utils'

/** A card of related settings. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel>{title}</SectionLabel>
      <div className="flex flex-col overflow-hidden rounded-lg border border-adaptive-200 bg-card">
        {children}
      </div>
    </div>
  )
}

/** Label and explanation on the left, the control on the right. */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  /** What the setting costs or buys. Every number here has one. */
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-4 border-b border-adaptive-200 px-3 py-2.5 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium">{label}</span>
        {hint && <span className="text-[11.5px] text-adaptive-500">{hint}</span>}
      </div>
      <div className="flex flex-none items-center gap-1.5">{children}</div>
    </div>
  )
}

/**
 * Two to five mutually exclusive options, as one control.
 *
 * Built from the app's own Button rather than a Select, which does not exist in
 * `components/ui` — and for this many options a dropdown hides the choice behind a
 * click for no gain.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex items-center overflow-hidden rounded-md border border-adaptive-200">
      {options.map((o) => (
        <Button
          key={String(o.value)}
          variant={o.value === value ? 'waPrimary' : 'waGhost'}
          size="waXs"
          // aria-pressed as well as the variant swap: toggled-ness that lives only
          // in `variant` is something CSS cannot distinguish from any other primary
          // button, so a skin has no way to press these in.
          aria-pressed={o.value === value}
          title={o.title}
          className="rounded-none border-0"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  )
}

/**
 * A number that is saved when it settles, not as it is typed.
 *
 * `set_config` writes config.json on every call, so a save per keystroke would be
 * a file write per keystroke. Blur and Enter commit; Escape reverts to the stored
 * value, which is also what a rejected value snaps back to — Rust clamps, and
 * seeing the clamp is the most honest feedback available.
 */
export function NumberField({
  value,
  min,
  max,
  suffix,
  onCommit,
}: {
  value: number
  min: number
  max: number
  suffix?: string
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(String(value))

  // Follow the stored value whenever it changes underneath — after a clamp, or
  // after another surface wrote it.
  useEffect(() => setText(String(value)), [value])

  const commit = () => {
    const n = Number(text)
    if (!Number.isFinite(n) || n === value) {
      setText(String(value))
      return
    }
    onCommit(n)
  }

  return (
    <>
      <Input
        type="number"
        value={text}
        min={min}
        max={max}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setText(String(value))
            e.currentTarget.blur()
          }
        }}
        className={cn('h-[30px] w-[7rem] text-xs')}
      />
      {suffix && <span className="text-[11.5px] text-adaptive-500">{suffix}</span>}
    </>
  )
}
