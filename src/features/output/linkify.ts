/**
 * Splits log text into plain runs and URLs, so a dev server's address is clickable.
 *
 * `vite` prints `➜  Local:   http://localhost:5173/` and the whole point of starting
 * it is to open that. Selecting the text out of a virtualized log to paste it into a
 * browser was the only way.
 *
 * A deliberately narrow matcher, not a general URL grammar: only `http://` and
 * `https://`. Log lines are full of things that look URL-ish — `git@host:org/repo`,
 * bare `localhost:5173`, Windows paths — and a wrong match turns text into a dead
 * link, which is worse than leaving it plain.
 */
export type Segment = { text: string; href?: string }

// Trailing punctuation is excluded from the match rather than trimmed after, so the
// offsets stay honest: a URL at the end of a sentence must not swallow the full stop,
// and `(http://x)` must not keep the closing paren.
const URL_RE = /https?:\/\/[^\s<>"'`]+/g

/** Characters that are legal in a URL but almost never end one in prose. */
const TRAILING = new Set(['.', ',', ':', ';', '!', '?', ')', ']', '}', '>', "'", '"'])

export function linkify(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0

  for (const m of text.matchAll(URL_RE)) {
    const start = m.index
    let url = m[0]

    // Walk back over trailing punctuation, keeping a balanced closing paren — a
    // GitHub anchor legitimately ends in one, e.g. .../wiki/Foo_(bar).
    while (url.length > 1 && TRAILING.has(url[url.length - 1]!)) {
      const ch = url[url.length - 1]!
      // `>=`, not `>`: with the paren still attached, balanced counts mean it belongs
      // to the URL. `(see http://a.dev/x)` has one close and no open, so it goes.
      if (ch === ')' && countOf(url, '(') >= countOf(url, ')')) break
      url = url.slice(0, -1)
    }

    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ text: url, href: url })
    last = start + url.length
  }

  if (last < text.length) out.push({ text: text.slice(last) })
  // Always at least one segment, so callers never special-case the empty result.
  return out.length > 0 ? out : [{ text }]
}

function countOf(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}
