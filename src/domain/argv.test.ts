import { describe, expect, test } from 'bun:test'
import { formatArgv, parseArgv } from './argv'

describe('parseArgv', () => {
  test('splits on whitespace and collapses runs of it', () => {
    expect(parseArgv('npm run dev')).toEqual({ argv: ['npm', 'run', 'dev'] })
    expect(parseArgv('  npm   run\tdev  ')).toEqual({ argv: ['npm', 'run', 'dev'] })
    expect(parseArgv('')).toEqual({ argv: [] })
    expect(parseArgv('   ')).toEqual({ argv: [] })
  })

  test('quotes group, and only group', () => {
    expect(parseArgv('vite --config "my config.ts"')).toEqual({
      argv: ['vite', '--config', 'my config.ts'],
    })
    expect(parseArgv("echo 'a b' c")).toEqual({ argv: ['echo', 'a b', 'c'] })
    // Mid-token quotes close over part of an argument, as a shell would.
    expect(parseArgv('--flag="a b"')).toEqual({ argv: ['--flag=a b'] })
    // An empty pair is a real, empty argument — not nothing.
    expect(parseArgv("prog '' x")).toEqual({ argv: ['prog', '', 'x'] })
  })

  test('nothing is expanded, because nothing runs a shell', () => {
    // These reach the program verbatim. Pretending otherwise is the failure mode
    // this tokeniser exists to make visible.
    expect(parseArgv('echo $HOME')).toEqual({ argv: ['echo', '$HOME'] })
    expect(parseArgv('sh -c "a && b"')).toEqual({ argv: ['sh', '-c', 'a && b'] })
    expect(parseArgv('ls *.ts')).toEqual({ argv: ['ls', '*.ts'] })
  })

  test('an unterminated quote is an error, not a guess', () => {
    expect(parseArgv('vite --config "oops')).toEqual({
      error: 'Unterminated double quote',
    })
    expect(parseArgv("echo 'oops")).toEqual({ error: 'Unterminated single quote' })
  })
})

describe('formatArgv', () => {
  test('leaves an ordinary command alone', () => {
    expect(formatArgv(['npm', 'run', 'dev'])).toBe('npm run dev')
    expect(formatArgv([])).toBe('')
  })

  test('quotes only what needs it', () => {
    expect(formatArgv(['vite', '--config', 'my config.ts'])).toBe("vite --config 'my config.ts'")
    expect(formatArgv(['prog', ''])).toBe("prog ''")
  })

  test('round-trips through parseArgv', () => {
    for (const argv of [
      ['npm', 'run', 'dev'],
      ['vite', '--config', 'my config.ts', '--port', '3000'],
      ['cargo', 'run', '--', '--flag=a b'],
      ['prog', '', 'after-empty'],
    ]) {
      expect(parseArgv(formatArgv(argv))).toEqual({ argv })
    }
  })
})
