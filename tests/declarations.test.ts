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
