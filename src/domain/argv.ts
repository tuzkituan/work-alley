/**
 * A command line as a list of arguments, and back.
 *
 * A tokeniser, not a shell, and the distinction is the point: the argv goes to the
 * child process directly, so there is no expansion, no globbing, no `&&`, no
 * escapes, no environment. Quotes group, and that is the whole grammar. Anything
 * more would be a shell this app deliberately does not run — and a `$(…)` that
 * looks like it works but arrives at the program verbatim is worse than one that
 * plainly does not.
 *
 * The editor renders the parsed tokens back to the user for exactly this reason:
 * the lossy step should be visible before Save, not discovered at Run.
 */
export type ParseResult = { argv: string[] } | { error: string }

export function parseArgv(input: string): ParseResult {
  const argv: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      // An empty pair of quotes is a real, empty argument.
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) {
        argv.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }

  if (quote) return { error: `Unterminated ${quote === '"' ? 'double' : 'single'} quote` }
  if (started) argv.push(current)
  return { argv }
}

/**
 * The inverse: an argv as one editable line.
 *
 * Quotes only what has to be quoted, so the common case reads as the command you
 * would type. Single quotes, matching how the backend's own `shell_join` renders a
 * preview — the two strings sit next to each other in the confirm dialog.
 */
export function formatArgv(argv: string[]): string {
  return argv
    .map((a) => {
      if (a === '') return "''"
      if (!/[\s'"]/.test(a)) return a
      // Escaping a single quote inside single quotes is the one thing this
      // tokeniser cannot round-trip, so those go in double quotes instead.
      return a.includes("'") ? `"${a.replace(/"/g, '')}"` : `'${a}'`
    })
    .join(' ')
}
