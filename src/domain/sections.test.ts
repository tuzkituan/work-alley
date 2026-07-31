import { describe, expect, test } from 'bun:test'
import { buildSections, flattenSections, splitByPrefix } from './sections'
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

describe('splitByPrefix', () => {
  const section = (names: string[], label = 'TypeScript') => ({
    key: `lang:${label}`,
    label,
    repos: names.map((n) => ref(n)),
  })

  const names = (out: ReturnType<typeof splitByPrefix>) =>
    out.map((s) => `${s.label}:${s.repos.length}`)

  test('splits a long section into its naming families, biggest first', () => {
    const out = splitByPrefix(
      section([
        ...Array.from({ length: 6 }, (_, i) => `blazeup-subapp-${i}`),
        'blazeup-hostapp-partner',
        'blazeup-hostapp-superadmin',
        'blazeup-hostapp-engineering',
        'blazeup-lib-forms',
        'blazeup-lib-charts',
        'blazeup-lib-tables',
      ])
    )
    expect(names(out)).toEqual([
      'blazeup-subapp:6',
      'blazeup-hostapp:3',
      'blazeup-lib:3',
    ])
  })

  test('the longest shared prefix wins, not the one everything carries', () => {
    // Every repo here starts `blazeup-`, so that prefix separates nothing — the
    // families are one segment further in.
    const out = splitByPrefix(
      section([
        ...Array.from({ length: 4 }, (_, i) => `blazeup-subapp-${i}`),
        ...Array.from({ length: 4 }, (_, i) => `blazeup-lib-${i}`),
        ...Array.from({ length: 4 }, (_, i) => `blazeup-hostapp-${i}`),
      ])
    )
    expect(names(out).sort()).toEqual([
      'blazeup-hostapp:4',
      'blazeup-lib:4',
      'blazeup-subapp:4',
    ])
  })

  test('a short section is left alone', () => {
    // Under SPLIT_MIN it is already scannable, and headings would be pure noise.
    const short = section(Array.from({ length: 11 }, (_, i) => `blazeup-subapp-${i}`))
    expect(splitByPrefix(short)).toEqual([short])
  })

  test('one family is no answer, so nothing is split', () => {
    // Everything in the same family means the heading would say what the section
    // already says.
    const one = section(Array.from({ length: 20 }, (_, i) => `blazeup-subapp-${i}`))
    expect(splitByPrefix(one)).toEqual([one])
  })

  test('repos following no convention keep the section label, last', () => {
    const out = splitByPrefix(
      section([
        ...Array.from({ length: 5 }, (_, i) => `blazeup-subapp-${i}`),
        ...Array.from({ length: 5 }, (_, i) => `blazeup-lib-${i}`),
        'Social-Pulse-FE',
        'skeleton',
      ])
    )
    // Equal-sized families tie-break alphabetically; the leftovers go last
    // whatever their size, keeping the section's own label.
    expect(names(out)).toEqual(['blazeup-lib:5', 'blazeup-subapp:5', 'TypeScript:2'])
  })

  test('a prefix can only end where a name segment does', () => {
    // Without separator-terminated prefixes, `blazeup-s` is a candidate and siem,
    // smartassess and subapp all look like one family.
    const out = splitByPrefix(
      section([
        'blazeup-siem-a',
        'blazeup-siem-b',
        'blazeup-siem-c',
        'blazeup-smartassess-a',
        'blazeup-smartassess-b',
        'blazeup-smartassess-c',
        ...Array.from({ length: 6 }, (_, i) => `blazeup-task-${i}`),
      ])
    )
    expect(names(out)).toEqual(['blazeup-task:6', 'blazeup-siem:3', 'blazeup-smartassess:3'])
  })

  test('section keys stay unique once a section has been split', () => {
    // They feed the virtualizer's row keys; a collision drops rows.
    const out = splitByPrefix(
      section([
        ...Array.from({ length: 6 }, (_, i) => `a-${i}`),
        ...Array.from({ length: 6 }, (_, i) => `b-${i}`),
      ])
    )
    expect(new Set(out.map((s) => s.key)).size).toBe(out.length)
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
