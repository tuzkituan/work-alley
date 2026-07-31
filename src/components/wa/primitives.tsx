import type { CSSProperties, ReactNode, Ref } from 'react'
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
  style,
}: {
  tone: Tone
  size?: number
  className?: string
  /** Merged over the size, so a caller can add the `wa-blink` animation. */
  style?: CSSProperties
}) {
  return (
    <span
      data-slot="status-dot"
      className={cn('flex-none rounded-full', TONE_BG[tone], className)}
      style={{ width: size, height: size, ...style }}
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
      // The tone as data, not only as a class: TONE_TINT bakes it into arbitrary
      // opacity utilities (`bg-amber-500/[0.12]`), which a skin cannot read. Metro
      // wants these as solid tiles, so it needs to know *which* tone.
      data-slot="pill"
      data-tone={tone}
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
      data-slot="state-pill"
      data-tone={tone}
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
      data-slot="section-label"
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
      // The hook a skin hangs its panel treatment on. PanelShell is a bare div
      // with no other stable handle, and CSS cannot reach it any other way; the
      // classes below stay correct for the classic skin.
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
  // A language tag is a different fact from a kind tag, so it reads differently —
  // legible, but not competing with FE/BE for attention.
  language: 'border-assist-500/25 bg-assist-500/[0.08] text-adaptive-600',
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
 * Short codes for the languages `detect` reports.
 *
 * Only the ones that need shortening are listed — anything else falls back to the
 * first three characters, which is right for CSS, HTML, LUA and QML and harmless
 * for the long tail.
 */
const LANG_LABEL: Record<string, string> = {
  TypeScript: 'TS',
  JavaScript: 'JS',
  Python: 'PY',
  Ruby: 'RB',
  Rust: 'RS',
  Kotlin: 'KT',
  Swift: 'SWIFT',
  Shell: 'SH',
  Elixir: 'EX',
  Haskell: 'HS',
  Scala: 'SCALA',
  Perl: 'PL',
  PowerShell: 'PS',
  Markdown: 'MD',
  'Objective-C': 'OBJC',
  'Objective-C++': 'OBJC',
  'Vim script': 'VIM',
}

function langLabel(language: string): string {
  return LANG_LABEL[language] ?? language.slice(0, 3).toUpperCase()
}

/**
 * Frameworks, most identifying first, mapped to their tag text.
 *
 * Order is the whole point: a repo's stack holds several true things at once, and
 * only the most specific is worth the width. `next` wins over `react`, which wins
 * over `vite` — all three are present in a Next app, and "NEXT" is the one that
 * tells you what you are looking at.
 *
 * Deliberately not here: `storybook` (an addon every UI library has, not its
 * identity) and `cmake` (a build system — the language says more).
 */
const FRAMEWORK_LABEL: [string, string][] = [
  // Mobile first: a React Native repo also has `react`, and the platform is the
  // more useful answer than the view library.
  ['expo', 'EXPO'],
  ['react-native', 'RN'],
  ['flutter', 'FLUTTER'],
  // Backend frameworks before their languages, same reason `next` beats `react`:
  // "DJANGO" says what runs, "PY" says what it is written in.
  ['django', 'DJANGO'],
  ['laravel', 'LARAVEL'],
  ['rails', 'RAILS'],
  ['spring', 'SPRING'],
  ['phoenix', 'PHOENIX'],
  ['fastapi', 'FASTAPI'],
  ['flask', 'FLASK'],
  ['next', 'NEXT'],
  ['nuxt', 'NUXT'],
  ['remix', 'REMIX'],
  ['astro', 'ASTRO'],
  ['gatsby', 'GATSBY'],
  ['qwik', 'QWIK'],
  ['solid', 'SOLID'],
  ['angular', 'NG'],
  ['electron', 'ELECTRON'],
  ['svelte', 'SVELTE'],
  ['vue', 'VUE'],
  ['nestjs', 'NEST'],
  ['fastify', 'FASTIFY'],
  ['express', 'EXPRESS'],
  ['react', 'REACT'],
  ['vite', 'VITE'],
  ['deno', 'DENO'],
  ['qt', 'QT'],
  ['dotnet', '.NET'],
]

/**
 * What the tag says, most specific answer first.
 *
 * Framework, else language, else the kind. The kind alone was all this used to
 * show, which meant every mobile repo read "APP" whether it was Flutter or Kotlin,
 * every frontend read "FE" whether it was React or Angular, and everything outside
 * the JS ecosystem read "?".
 *
 * Generic language-ish stack entries (`rust`, `java`, `python`) are not consulted:
 * the detected language already covers them and is more precise — `build.gradle`
 * puts `java` in the stack for a codebase that is actually Kotlin.
 */
function tagLabel(kind: string, language?: string | null, stack?: string[]): string | null {
  if (stack?.length) {
    const hit = FRAMEWORK_LABEL.find(([id]) => stack.includes(id))
    if (hit) return hit[1]
  }
  if (language) return langLabel(language)
  return KIND_LABEL[kind] ?? null
}

/**
 * What the repo is, as a compact tag.
 *
 * Short by design: it appears on every row, so it has to cost almost no width. The
 * kind, language and full stack are all in the title attribute.
 *
 * Colour still comes from the *kind*, so the column reads as frontend / backend /
 * mobile at a glance while the text names the actual framework.
 */
export function KindTag({
  kind,
  language,
  stack,
  className,
}: {
  kind: string
  language?: string | null
  stack?: string[]
  className?: string
}) {
  const label = tagLabel(kind, language, stack)
  if (!label || label === '?') return null

  // An unknown kind has no colour to lend, so a tag that got its text from the
  // language or the stack takes the neutral style rather than the faint one meant
  // for "we could not tell".
  const style = kind === 'unknown' ? KIND_STYLE.language : (KIND_STYLE[kind] ?? KIND_STYLE.unknown)

  const detail = [kind, language, stack?.length ? stack.join(', ') : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <span
      title={`Detected: ${detail}`}
      data-slot="kind-tag"
      data-kind={kind}
      className={cn(
        'flex-none rounded-sm border px-1 font-mono text-[9.5px] leading-[14px] font-semibold',
        style,
        className
      )}
    >
      {label}
    </span>
  )
}
