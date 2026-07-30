import type { ReactNode, Ref } from 'react'
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
      data-slot="mono-chip"
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
    <span
      data-slot="keycap"
      className="rounded-sm border border-adaptive-200 px-1 font-mono text-[11px] leading-4"
    >
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
  header,
  bodyRef,
  bodyClassName,
}: {
  title?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
  /** Replaces the whole default header bar, for panels that need more than a title. */
  header?: ReactNode
  /**
   * The scrolling body element.
   *
   * Exposed because a virtualizer has to be handed the real scrollport: measuring
   * the wrong node makes it compute a viewport height of zero and render one row
   * forever. See the same lesson in RepoGrid, which is why that list scrolls a
   * plain div rather than a Radix ScrollArea.
   */
  bodyRef?: Ref<HTMLDivElement>
  bodyClassName?: string
}) {
  return (
    <div
      // The hook the neumorph skin hangs a raised surface on. PanelShell is a
      // bare div with no other stable handle, and the skin cannot reach it any
      // other way; the classes below stay correct for the classic skin.
      data-slot="panel"
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-adaptive-200 bg-card',
        className
      )}
    >
      {header ?? (
        <div
          data-slot="panel-header"
          className="flex flex-none items-center justify-between border-b border-adaptive-200 px-3 py-2.5"
        >
          <span className="text-[13px] font-semibold">{title}</span>
          {right}
        </div>
      )}
      <div
        ref={bodyRef}
        className={cn('wa-scroll min-h-0 flex-1 overflow-y-auto', bodyClassName)}
      >
        {children}
      </div>
    </div>
  )
}

/** The design's dot separator in the breadcrumb. */
export function Sep() {
  return <span className="text-adaptive-300">·</span>
}


const KIND_STYLE: Record<string, string> = {
  frontend: 'border-blue-500/[0.38] bg-blue-500/[0.12] text-sev-info',
  backend: 'border-green-500/[0.38] bg-green-500/[0.12] text-sev-ok',
  library: 'border-assist-500/40 bg-assist-500/[0.12] text-assist-500',
  mobile: 'border-amber-500/[0.38] bg-amber-500/[0.12] text-sev-warn',
  docs: 'border-adaptive-300 bg-adaptive-200/60 text-adaptive-500',
  unknown: 'border-adaptive-300 bg-adaptive-200/40 text-adaptive-400',
}

const KIND_LABEL: Record<string, string> = {
  frontend: 'FE',
  backend: 'BE',
  library: 'LIB',
  mobile: 'APP',
  docs: 'DOC',
  unknown: '?',
}

/**
 * The detected repo kind, as a compact tag.
 *
 * Short by design: it appears on every row, so it has to cost almost no width.
 * The full kind and stack are in the title attribute.
 */
export function KindTag({
  kind,
  stack,
  className,
}: {
  kind: string
  stack?: string[]
  className?: string
}) {
  if (kind === 'unknown' && !stack?.length) return null
  const detail = stack?.length ? `${kind} · ${stack.join(', ')}` : kind
  return (
    <span
      title={`Detected: ${detail}`}
      className={cn(
        'flex-none rounded-sm border px-1 font-mono text-[9.5px] leading-[14px] font-semibold',
        KIND_STYLE[kind] ?? KIND_STYLE.unknown,
        className
      )}
    >
      {KIND_LABEL[kind] ?? '?'}
    </span>
  )
}
