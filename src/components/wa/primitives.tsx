import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { TONE_BG, TONE_TEXT, TONE_TINT, type Tone } from '@/domain/severity'

/**
 * The design's vocabulary, as plain styled elements.
 *
 * These are deliberately NOT shadcn components. shadcn's Badge is
 * `rounded-md px-2 py-0.5` with its own focus ring; the design wants
 * `rounded-full px-[9px] py-[4px]` with an rgba tint and a 6px dot. Overriding
 * every class would not be "using shadcn", it would be laundering a div through
 * one. The shadcn primitives are used where they carry real behaviour — dialogs,
 * popovers, the command palette, collapsibles.
 */

export function StatusDot({
  tone,
  size = 7,
  className,
}: {
  tone: Tone
  size?: number
  className?: string
}) {
  return (
    <span
      className={cn('flex-none rounded-full', TONE_BG[tone], className)}
      style={{ width: size, height: size }}
    />
  )
}

/** The "Needs you" chip, and the card's state pill. */
export function Pill({
  tone,
  count,
  label,
  dot = true,
  active = false,
  onClick,
  title,
}: {
  tone: Tone
  count?: number | string
  label: string
  dot?: boolean
  active?: boolean
  onClick?: () => void
  title?: string
}) {
  const Comp = onClick ? 'button' : 'span'
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        'flex flex-none items-center gap-1.5 rounded-full border px-[9px] py-[4px] text-xs',
        TONE_TINT[tone],
        onClick && 'cursor-pointer transition-shadow hover:shadow-focus-ring',
        active && 'ring-2 ring-adaptive-400'
      )}
    >
      {dot && <StatusDot tone={tone} size={6} />}
      {count !== undefined && (
        <span className={cn('wa-num font-semibold', TONE_TEXT[tone])}>{count}</span>
      )}
      <span className="text-adaptive-600">{label}</span>
    </Comp>
  )
}

/** The right-hand pill on a repo card: "build failing" / "stale 9d" / "ready". */
export function StatePill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={cn(
        'flex-none rounded-full border px-[7px] py-[2px] text-[11px] font-semibold',
        TONE_TINT[tone],
        TONE_TEXT[tone]
      )}
    >
      {label}
    </span>
  )
}

/** The bordered mono `fe/` tag. */
export function MonoChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'rounded-sm border border-adaptive-200 px-1 font-mono text-[11px] text-adaptive-400',
        className
      )}
    >
      {children}
    </span>
  )
}

export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'text-[11px] font-bold tracking-[0.06em] text-adaptive-500 uppercase',
        className
      )}
    >
      {children}
    </span>
  )
}

export function KeyCap({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm border border-adaptive-200 px-1 font-mono text-[11px] leading-4">
      {children}
    </span>
  )
}

export function KvRow({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-adaptive-500">{label}</span>
      <span className={cn('wa-num font-mono', tone ? TONE_TEXT[tone] : 'text-adaptive-800')}>
        {value}
      </span>
    </div>
  )
}

export function PanelShell({
  title,
  right,
  children,
  className,
}: {
  title: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-adaptive-200 bg-card',
        className
      )}
    >
      <div className="flex flex-none items-center justify-between border-b border-adaptive-200 px-3 py-2.5">
        <span className="text-[13px] font-semibold">{title}</span>
        {right}
      </div>
      <div className="wa-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}

/** The design's dot separator in the breadcrumb. */
export function Sep() {
  return <span className="text-adaptive-300">·</span>
}
