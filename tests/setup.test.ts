import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const drovr = join(root, 'dist/cli.mjs')

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drovr-setup-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  await writeFile(join(dir, 'README.md'), '# test\n', 'utf8')
  runGit(dir, ['add', 'README.md'])
  runGit(dir, ['commit', '-m', 'init'])
  return dir
}

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('drovr setup', () => {
  it('creates a typed no-op Workflow and hygiene files from the repo root', async () => {
    const repo = await initRepo()

    try {
      execFileSync('node', [drovr, 'setup'], { cwd: repo, stdio: 'pipe' })

      const workflow = await readFile(join(repo, '.drovr/main.ts'), 'utf8')
      expect(workflow).toBe(
        'import type { Drovr } from "drovr"\n\nexport default async function workflow(_drovr: Drovr): Promise<void> {}\n',
      )
      expect(await readFile(join(repo, '.drovr/.gitignore'), 'utf8')).toBe(
        'state.sqlite*\ndrovr.log\n',
      )

      const gitDir = runGit(repo, ['rev-parse', '--git-dir'])
      const exclude = await readFile(join(repo, gitDir, 'info/exclude'), 'utf8')
      expect(exclude).toContain('/.worktrees/')
      expect(exclude.endsWith('/.worktrees/\n')).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('succeeds from a nested directory inside the worktree', async () => {
    const repo = await initRepo()
    const nested = join(repo, 'apps', 'service')
    await mkdir(nested, { recursive: true })

    try {
      execFileSync('node', [drovr, 'setup'], { cwd: nested, stdio: 'pipe' })
      expect(await readFile(join(repo, '.drovr/main.ts'), 'utf8')).toContain(
        'import type { Drovr }',
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('succeeds from a linked worktree and writes exclude to the common git directory', async () => {
    const main = await initRepo()
    const linked = join(main, 'linked-checkout')
    runGit(main, ['worktree', 'add', linked, '-b', 'feature/linked'])

    try {
      execFileSync('node', [drovr, 'setup'], { cwd: linked, stdio: 'pipe' })
      expect(await readFile(join(linked, '.drovr/main.ts'), 'utf8')).toContain(
        'import type { Drovr }',
      )

      const commonExclude = await readFile(join(main, '.git/info/exclude'), 'utf8')
      expect(commonExclude).toContain('/.worktrees/')

      const worktreeGitDir = runGit(linked, ['rev-parse', '--git-dir'])
      expect(worktreeGitDir).not.toBe(join(main, '.git'))
      await expect(readFile(join(linked, worktreeGitDir, 'info/exclude'), 'utf8')).rejects.toThrow(
        /ENOENT/,
      )
    } finally {
      runGit(main, ['worktree', 'remove', '--force', linked])
      await rm(main, { recursive: true, force: true })
    }
  })

  it('preserves existing ignore content and appends missing entries once', async () => {
    const repo = await initRepo()
    await mkdir(join(repo, '.drovr'), { recursive: true })
    await writeFile(join(repo, '.drovr/.gitignore'), 'notes', 'utf8')

    const gitDir = runGit(repo, ['rev-parse', '--git-dir'])
    await mkdir(join(repo, gitDir, 'info'), { recursive: true })
    await writeFile(join(repo, gitDir, 'info/exclude'), 'local-only\n', 'utf8')

    try {
      execFileSync('node', [drovr, 'setup'], { cwd: repo, stdio: 'pipe' })

      expect(await readFile(join(repo, '.drovr/.gitignore'), 'utf8')).toBe(
        'notes\nstate.sqlite*\ndrovr.log\n',
      )
      expect(await readFile(join(repo, gitDir, 'info/exclude'), 'utf8')).toBe(
        'local-only\n/.worktrees/\n',
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails without partial mutation when a Workflow already exists', async () => {
    const repo = await initRepo()
    await mkdir(join(repo, '.drovr'), { recursive: true })
    const existing = 'export default async function workflow() {}\n'
    await writeFile(join(repo, '.drovr/main.ts'), existing, 'utf8')
    await writeFile(join(repo, '.drovr/.gitignore'), 'custom\n', 'utf8')

    try {
      expect(() => execFileSync('node', [drovr, 'setup'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /existing Workflow/,
      )

      expect(await readFile(join(repo, '.drovr/main.ts'), 'utf8')).toBe(existing)
      expect(await readFile(join(repo, '.drovr/.gitignore'), 'utf8')).toBe('custom\n')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails outside git without creating files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drovr-no-git-'))

    try {
      expect(() => execFileSync('node', [drovr, 'setup'], { cwd: dir, stdio: 'pipe' })).toThrow(
        /git worktree/,
      )
      await expect(readFile(join(dir, '.drovr/main.ts'), 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
