import { describe, expect, test } from 'bun:test'
import { buildSections, flattenSections } from './sections'
import { repoId, type RepoKind, type RepoRef, type RepoStatus } from './types'

function ref(name: string, category = 'ws'): RepoRef {
  return { category, name }
}

/** Only the fields `buildSections` reads; the rest of RepoStatus is irrelevant here. */
function status(opts: {
  ref: RepoRef
  kind?: RepoKind
  language?: string | null
  running?: 'up' | 'starting' | 'crashed'
}): RepoStatus {
  return {
    ref: opts.ref,
    shape: {
      kind: opts.kind ?? 'unknown',
      language: opts.language ?? null,
      stack: [],
      hasDockerfile: false,
      isMonorepo: false,
    },
    tasks: opts.running
      ? [
          {
            ref: opts.ref,
            task: 'dev',
            runId: 'r1',
            pid: 1,
            command: [],
            port: null,
            portSource: null,
            state: opts.running,
            url: null,
            startedUnix: 0,
          },
        ]
      : [],
  } as unknown as RepoStatus
}

function map(list: RepoStatus[]): Map<string, RepoStatus> {
  return new Map(list.map((s) => [repoId(s.ref), s]))
}

const labels = (refs: RepoRef[], statuses: Map<string, RepoStatus>) =>
  buildSections(refs, statuses as never).map((s) => `${s.label}:${s.repos.length}`)

describe('buildSections', () => {
  test('groups by language when a folder holds more than one', () => {
    const refs = [ref('a'), ref('b'), ref('c')]
    const statuses = map([
      status({ ref: refs[0]!, language: 'C++' }),
      status({ ref: refs[1]!, language: 'C++' }),
      status({ ref: refs[2]!, language: 'Shell' }),
    ])
    // Biggest group first, so the bulk of the folder is not under a one-repo heading.
    expect(labels(refs, statuses)).toEqual(['C++:2', 'Shell:1'])
  })

  test('falls back to kind when every repo shares one language', () => {
    // Language separates nothing here, so it must not be the axis.
    const refs = [ref('web'), ref('api'), ref('ui')]
    const statuses = map([
      status({ ref: refs[0]!, language: 'TypeScript', kind: 'frontend' }),
      status({ ref: refs[1]!, language: 'TypeScript', kind: 'backend' }),
      status({ ref: refs[2]!, language: 'TypeScript', kind: 'library' }),
    ])
    expect(labels(refs, statuses)).toEqual(['Frontend:1', 'Backend:1', 'Libraries:1'])
  })

  test('running is its own section, ahead of everything', () => {
    const refs = [ref('a'), ref('b'), ref('c')]
    const statuses = map([
      status({ ref: refs[0]!, language: 'C++' }),
      status({ ref: refs[1]!, language: 'Shell', running: 'up' }),
      status({ ref: refs[2]!, language: 'Shell' }),
    ])
    expect(labels(refs, statuses)).toEqual(['Running:1', 'C++:1', 'Shell:1'])
  })

  test('a crashed task is not "running" — it belongs with its language', () => {
    // Otherwise a dead server hides the repo under a heading that claims it is up.
    const refs = [ref('a'), ref('b')]
    const statuses = map([
      status({ ref: refs[0]!, language: 'Rust', running: 'crashed' }),
      status({ ref: refs[1]!, language: 'Go' }),
    ])
    expect(labels(refs, statuses)).toEqual(['Go:1', 'Rust:1'])
  })

  test('repos with no detected language trail the ones that have one', () => {
    const refs = [ref('a'), ref('b'), ref('c')]
    const statuses = map([
      status({ ref: refs[0]!, language: null }),
      status({ ref: refs[1]!, language: null }),
      status({ ref: refs[2]!, language: 'Rust' }),
    ])
    // Sorted last despite being the larger group: "Other" is not a group you scan.
    expect(labels(refs, statuses)).toEqual(['Rust:1', 'Other:2'])
  })

  test('an unscanned folder produces one section rather than a language split', () => {
    // Every language is null before the scan lands, which is one group, so this
    // takes the kind path and lands entirely in Other.
    const refs = [ref('a'), ref('b')]
    expect(labels(refs, map([]))).toEqual(['Other:2'])
  })

  test('equal-sized language groups are ordered by name, not by discovery', () => {
    const refs = [ref('z'), ref('a')]
    const statuses = map([
      status({ ref: refs[0]!, language: 'Rust' }),
      status({ ref: refs[1]!, language: 'Go' }),
    ])
    expect(labels(refs, statuses)).toEqual(['Go:1', 'Rust:1'])
  })
})

describe('flattenSections', () => {
  test('omits headers when there is only one section', () => {
    const sections = [{ key: 'lang:C++', label: 'C++', repos: [ref('a'), ref('b')] }]
    expect(flattenSections(sections, 1).map((i) => i.kind)).toEqual(['row', 'row'])
  })

  test('card pairing never crosses a section boundary', () => {
    const sections = [
      { key: 'lang:C++', label: 'C++', repos: [ref('a')] },
      { key: 'lang:Shell', label: 'Shell', repos: [ref('b'), ref('c')] },
    ]
    const items = flattenSections(sections, 2)
    expect(items.map((i) => i.kind)).toEqual(['header', 'row', 'header', 'row'])
    // The lone C++ repo keeps its own row rather than pairing with a Shell one.
    expect(items[1]!.kind === 'row' && items[1]!.repos.length).toBe(1)
    expect(items[3]!.kind === 'row' && items[3]!.repos.length).toBe(2)
  })

  test('section keys stay unique across the two grouping axes', () => {
    // `key` feeds the virtualizer's row keys, so a collision would drop rows.
    const sections = [
      { key: 'lang:Other', label: 'Other', repos: [ref('a')] },
      { key: 'kind:other', label: 'Other', repos: [ref('b')] },
    ]
    const keys = flattenSections(sections, 1).map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
