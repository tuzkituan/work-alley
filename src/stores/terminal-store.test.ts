import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { TermInfo } from '@/domain/types'

// Closing a tab talks to Rust and destroys a real xterm instance, neither of
// which exists here. Mocked at the module level so `close` can be tested for the
// bookkeeping it does, which is the part with the interesting edge cases.
const disposed: string[] = []
const closed: string[] = []
mock.module('@/features/terminal/xterm-instance', () => ({
  disposeTerm: (id: string) => disposed.push(id),
}))
mock.module('@/ipc/commands', () => ({
  api: { termClose: async (id: string) => void closed.push(id) },
}))

const { useTerminalStore, termScope } = await import('./terminal-store')

function info(
  termId: string,
  repo: TermInfo['repo'] = { category: 'fe', name: 'web' },
  kind = 'shell'
): TermInfo {
  return {
    termId,
    kind,
    title: 'Terminal in fe/web',
    argv: ['/bin/zsh', '-l'],
    cwd: '/w/fe/web',
    repo,
    startedUnix: 1_700_000_000,
    pid: 4242,
    alive: true,
    cols: 80,
    rows: 24,
  }
}

describe('terminal store', () => {
  beforeEach(() => {
    useTerminalStore.setState({ tabs: new Map(), order: [], activeTermId: null })
    disposed.length = 0
    closed.length = 0
  })

  it('records a tab once even if opened twice', () => {
    // A duplicated listener or a replay overlapping a live event must not render
    // two tabs — and two identical React keys — for one session.
    useTerminalStore.getState().open(info('t1'))
    useTerminalStore.getState().open(info('t1'))
    expect(useTerminalStore.getState().order).toEqual(['t1'])
    expect(useTerminalStore.getState().tabs.size).toBe(1)
  })

  it('keeps the session kind, which is what routes a tab to a page', () => {
    // The Toolbox and setup pages render `package` sessions and nothing else, and
    // the bridge refreshes the package queries when one of them exits — both read
    // this field, so losing it would silently break an install's aftermath.
    useTerminalStore.getState().open(info('t1', null, 'package'))
    useTerminalStore.getState().open(info('t2'))
    expect(useTerminalStore.getState().tabs.get('t1')?.kind).toBe('package')
    expect(useTerminalStore.getState().tabs.get('t2')?.kind).toBe('shell')
  })

  it('marks a tab exited without removing it', () => {
    // The tab survives its shell so the scrollback stays readable, exactly as a
    // finished run's chip stays in the strip until dismissed.
    useTerminalStore.getState().open(info('t1'))
    useTerminalStore.getState().exit('t1', 3)
    const tab = useTerminalStore.getState().tabs.get('t1')
    expect(tab?.status).toBe('exited')
    expect(tab?.exitCode).toBe(3)
    expect(useTerminalStore.getState().order).toEqual(['t1'])
  })

  it('ignores exit for a tab that is already gone', () => {
    useTerminalStore.getState().exit('nope', 0)
    expect(useTerminalStore.getState().tabs.size).toBe(0)
  })

  it('renames from an OSC title change', () => {
    useTerminalStore.getState().open(info('t1'))
    useTerminalStore.getState().rename('t1', 'vim README.md')
    expect(useTerminalStore.getState().tabs.get('t1')?.title).toBe('vim README.md')
  })

  it('disposes the instance and hangs up the shell on close', () => {
    useTerminalStore.getState().open(info('t1'))
    useTerminalStore.getState().close('t1')
    expect(disposed).toEqual(['t1'])
    expect(closed).toEqual(['t1'])
    expect(useTerminalStore.getState().tabs.size).toBe(0)
  })

  it('falls back to another tab when the active one is closed', () => {
    useTerminalStore.getState().open(info('t1'))
    useTerminalStore.getState().open(info('t2'))
    useTerminalStore.getState().setActive('t2')
    useTerminalStore.getState().close('t2')
    expect(useTerminalStore.getState().activeTermId).toBe('t1')
  })

  it('falls back to the run log when the last tab is closed', () => {
    // Not to a tab the user cannot see: null is the log view.
    useTerminalStore.getState().open(info('t1'))
    useTerminalStore.getState().setActive('t1')
    useTerminalStore.getState().close('t1')
    expect(useTerminalStore.getState().activeTermId).toBeNull()
  })

  it('leaves the active tab alone when a different one is closed', () => {
    useTerminalStore.getState().open(info('t1'))
    useTerminalStore.getState().open(info('t2'))
    useTerminalStore.getState().setActive('t1')
    useTerminalStore.getState().close('t2')
    expect(useTerminalStore.getState().activeTermId).toBe('t1')
  })

  it('scopes a tab to its repo, and workspace tabs to null', () => {
    // Mirrors runScope, so the output pane's one scope toggle governs both.
    useTerminalStore.getState().open(info('t1'))
    useTerminalStore.getState().open(info('t2', null))
    expect(termScope(useTerminalStore.getState().tabs.get('t1')!)).toBe('fe/web')
    expect(termScope(useTerminalStore.getState().tabs.get('t2')!)).toBeNull()
  })
})
