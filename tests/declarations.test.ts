import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('published declarations', () => {
  it('exports exactly the six documented type-only names', () => {
    const source = readFileSync(join(root, 'dist/index.d.mts'), 'utf8')
    const exportLine = source.split('\n').find((line) => line.startsWith('export {'))

    expect(exportLine).toBe('export { Drovr, Issue, Name, Resource, Worker, Worktree };')
  })

  it('preserves contract-focused JSDoc on exported types', () => {
    const source = readFileSync(join(root, 'dist/index.d.mts'), 'utf8')

    expect(source).toContain('User-supplied slug that keys Workers')
    expect(source).toContain('Readonly GitHub Issue snapshot returned by')
    expect(source).toContain('Workflow-facing orchestration handle injected by the Drovr CLI')
    expect(source).toContain('prompt(text: string): Promise<void>')
    expect(source).toContain('lease<T>(opts:')
  })

  it('documents the Port Resource declaration union on Drovr.resource', () => {
    const source = readFileSync(join(root, 'dist/index.d.mts'), 'utf8')

    expect(source).toContain('capacity: number')
    expect(source).toContain('ports:')
    expect(source).toContain('from: number')
    expect(source).toContain('to: number')
    expect(source).toContain('reserves its entire normalized port set')
    expect(source).toContain('`name` must be a nonempty string')
    expect(source).toContain('Re-defining a live Port Resource with changed ports fails')
  })

  it('documents map concurrency validation and Completion semantics', () => {
    const source = readFileSync(join(root, 'dist/index.d.mts'), 'utf8')

    expect(source).toContain('`opts.concurrency` must be a positive integer')
    expect(source).toContain('records a Completion for that Name')
    expect(source).toContain('a throw leaves it incomplete')
    expect(source).toContain('callback is replayed on resume')
    expect(source).toContain('at-least-once')
  })

  it('publishes only the root and package metadata subpaths', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      bin: Record<string, string>
    }

    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './package.json'])
    expect(pkg.bin).toEqual({ drovr: './dist/cli.mjs' })
    expect(pkg.exports).not.toHaveProperty('./cli')
  })

  it('compiles a representative consumer Workflow against the built package', () => {
    expect(() =>
      execFileSync(
        'pnpm',
        ['exec', 'tsc', '--noEmit', '-p', 'tests/fixtures/consumer-workflow/tsconfig.json'],
        { cwd: root, stdio: 'pipe' },
      ),
    ).not.toThrow()
  })
})
