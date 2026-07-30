import { describe, expect, it } from 'bun:test'
import { linkify } from './linkify'

/** Just the hrefs, which is what the rendering cares about. */
const hrefs = (s: string) => linkify(s).flatMap((seg) => (seg.href ? [seg.href] : []))
/** Reassembling every segment must reproduce the input exactly. */
const rejoin = (s: string) => linkify(s).map((seg) => seg.text).join('')

describe('linkify', () => {
  it('finds the URL vite prints, which is the whole point', () => {
    expect(hrefs('  ➜  Local:   http://localhost:5173/')).toEqual(['http://localhost:5173/'])
  })

  it('finds several on one line', () => {
    expect(hrefs('see https://a.dev and http://b.dev/x')).toEqual([
      'https://a.dev',
      'http://b.dev/x',
    ])
  })

  it('never loses or duplicates a character', () => {
    // The property that matters: this text is the log, and it must render verbatim.
    for (const s of [
      'plain text',
      'http://a.dev',
      'a http://b.dev c',
      '',
      'ends with http://c.dev/',
      'https://x.dev https://y.dev',
    ]) {
      expect(rejoin(s)).toBe(s)
    }
  })

  it('leaves trailing sentence punctuation out of the link', () => {
    expect(hrefs('open http://a.dev/x.')).toEqual(['http://a.dev/x'])
    expect(hrefs('(see http://a.dev/x)')).toEqual(['http://a.dev/x'])
    expect(hrefs('http://a.dev/x, then')).toEqual(['http://a.dev/x'])
  })

  it('keeps a balanced paren that is part of the URL', () => {
    expect(hrefs('https://w.dev/Foo_(bar)')).toEqual(['https://w.dev/Foo_(bar)'])
  })

  it('ignores things that only look like URLs', () => {
    // A wrong match makes a dead link, which is worse than plain text.
    expect(hrefs('git@github.com:org/repo.git')).toEqual([])
    expect(hrefs('listening on localhost:5173')).toEqual([])
    expect(hrefs('C:\\Users\\me\\file')).toEqual([])
    expect(hrefs('ftp://old.host/file')).toEqual([])
  })

  it('returns one plain segment for text with no links', () => {
    expect(linkify('nothing here')).toEqual([{ text: 'nothing here' }])
  })
})
