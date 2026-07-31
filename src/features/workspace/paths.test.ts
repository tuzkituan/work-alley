import { describe, expect, test } from 'bun:test'
import { baseName, shortenHome } from './WorkspacePicker'
import { normalize } from '@/hooks/use-platform'

describe('shortenHome', () => {
  test('abbreviates a home-relative path on either separator', () => {
    expect(shortenHome('/home/me/projects', '/home/me')).toBe('~/projects')
    expect(shortenHome('/Users/me/projects', '/Users/me')).toBe('~/projects')
    // The case the `/`-only check used to miss entirely, leaving the full path.
    expect(shortenHome('C:\\Users\\me\\projects', 'C:\\Users\\me')).toBe('~\\projects')
  })

  test('the home directory itself is just ~', () => {
    expect(shortenHome('/home/me', '/home/me')).toBe('~')
    expect(shortenHome('C:\\Users\\me', 'C:\\Users\\me')).toBe('~')
  })

  test('a sibling that merely shares the prefix is left alone', () => {
    // `/home/mel` starts with `/home/me`, so prefix-matching alone would turn it
    // into `~l`. The separator check is what prevents that.
    expect(shortenHome('/home/mel/projects', '/home/me')).toBe('/home/mel/projects')
    expect(shortenHome('C:\\Users\\melissa', 'C:\\Users\\me')).toBe('C:\\Users\\melissa')
  })

  test('an unrelated path or an unknown home is returned unchanged', () => {
    expect(shortenHome('/opt/work', '/home/me')).toBe('/opt/work')
    expect(shortenHome('/home/me/x', null)).toBe('/home/me/x')
  })
})

describe('baseName', () => {
  test('takes the last segment whichever separator is used', () => {
    expect(baseName('/home/me/projects')).toBe('projects')
    expect(baseName('C:\\Users\\me\\projects')).toBe('projects')
    // A trailing separator must not yield an empty name.
    expect(baseName('/home/me/projects/')).toBe('projects')
    expect(baseName('C:\\work\\')).toBe('work')
  })

  test('a root or empty path has no base name', () => {
    expect(baseName('')).toBeUndefined()
    expect(baseName('/')).toBeUndefined()
  })
})

describe('platform normalize', () => {
  test('maps the Rust OS constants onto the three cases the UI handles', () => {
    expect(normalize('windows')).toBe('windows')
    expect(normalize('macos')).toBe('macos')
    expect(normalize('linux')).toBe('linux')
  })

  test('defaults rather than throwing, because every use of it is cosmetic', () => {
    // Read on the first render, before the bootstrap query resolves.
    expect(normalize(undefined)).toBe('linux')
    expect(normalize('freebsd')).toBe('linux')
  })
})
