import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const drovr = join(root, 'dist/cli.mjs')

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drovr-worktree-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  await writeFile(join(dir, 'README.md'), '# test\n', 'utf8')
  await writeFile(join(dir, 'source.txt'), 'version 1\n', 'utf8')
  runGit(dir, ['add', 'README.md', 'source.txt'])
  runGit(dir, ['commit', '-m', 'init'])
  return dir
}

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('Drovr.worktree fresh creation and isolation', () => {
  it('derives branch drovr/<name> and location .worktrees/<name> from Start checkout HEAD', async () => {
    const repo = await initRepo()
    const headSha = runGit(repo, ['rev-parse', 'HEAD'])

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'item-alpha' })
  if (wt.name !== 'item-alpha') {
    throw new Error('wrong name: ' + wt.name)
  }
  if (wt.path !== ${JSON.stringify(join(repo, '.worktrees', 'item-alpha'))}) {
    throw new Error('wrong path: ' + wt.path)
  }
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      const worktreePath = join(repo, '.worktrees', 'item-alpha')
      expect(existsSync(worktreePath)).toBe(true)

      // Branch exists and points to Start checkout HEAD
      const branchSha = runGit(repo, ['rev-parse', 'refs/heads/drovr/item-alpha'])
      expect(branchSha).toBe(headSha)

      // Worktree is a valid git worktree
      const wtTopLevel = runGit(worktreePath, ['rev-parse', '--show-toplevel'])
      expect(wtTopLevel).toBe(worktreePath)

      // Worktree contains committed files from Start checkout HEAD
      const sourceContent = await readFile(join(worktreePath, 'source.txt'), 'utf8')
      expect(sourceContent).toBe('version 1\n')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('warns on a dirty Start checkout but leaves uncommitted files untouched and does not copy them', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'dirty-test' })
}
`,
        'utf8',
      )

      // Dirty the Start checkout with modified, staged, and untracked files
      await writeFile(join(repo, 'source.txt'), 'modified locally\n', 'utf8')
      await writeFile(join(repo, 'staged.txt'), 'staged file\n', 'utf8')
      runGit(repo, ['add', 'staged.txt'])
      await writeFile(join(repo, 'untracked.txt'), 'untracked file\n', 'utf8')

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc.status).toBe(0)
      expect(proc.stderr).toMatch(/warning.*uncommitted/i)
      const worktreePath = join(repo, '.worktrees', 'dirty-test')
      expect(existsSync(worktreePath)).toBe(true)

      // Worktree has clean HEAD content
      const wtSource = await readFile(join(worktreePath, 'source.txt'), 'utf8')
      expect(wtSource).toBe('version 1\n')
      expect(existsSync(join(worktreePath, 'staged.txt'))).toBe(false)
      expect(existsSync(join(worktreePath, 'untracked.txt'))).toBe(false)

      // Start checkout files are completely untouched
      const startSource = await readFile(join(repo, 'source.txt'), 'utf8')
      expect(startSource).toBe('modified locally\n')
      expect(await readFile(join(repo, 'staged.txt'), 'utf8')).toBe('staged file\n')
      expect(await readFile(join(repo, 'untracked.txt'), 'utf8')).toBe('untracked file\n')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('lazily merges clone-local Worktree exclusion /.worktrees/ exactly once before creation', async () => {
    const repo = await initRepo()
    const excludePath = join(repo, '.git', 'info', 'exclude')
    await mkdir(join(repo, '.git', 'info'), { recursive: true })
    await writeFile(excludePath, 'custom-ignore-entry\n', 'utf8')

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'first-item' })
  await drovr.worktree({ name: 'second-item' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      const excludeContent = await readFile(excludePath, 'utf8')
      expect(excludeContent).toContain('custom-ignore-entry\n')
      expect(excludeContent).toContain('/.worktrees/\n')

      // Exactly once
      const occurrences = excludeContent.split('/.worktrees/').length - 1
      expect(occurrences).toBe(1)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails when drovr start is run from beneath this repository managed Worktree area, while unrelated linked worktree succeeds', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {}
`,
        'utf8',
      )

      const managedWt = join(repo, '.worktrees', 'nested-worker')
      runGit(repo, ['worktree', 'add', '-b', 'drovr/nested-worker', managedWt, 'HEAD'])

      // Running drovr start from within .worktrees/nested-worker must fail
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: managedWt, stdio: 'pipe' }),
      ).toThrow(/managed.*worktree|\.worktrees/i)

      // Running drovr start from .worktrees must fail
      const worktreesDir = join(repo, '.worktrees')
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: worktreesDir, stdio: 'pipe' }),
      ).toThrow(/managed.*worktree|\.worktrees/i)

      // Running from an unrelated linked worktree outside .worktrees must succeed
      const unrelated = await mkdtemp(join(tmpdir(), 'drovr-unrelated-'))
      runGit(repo, ['worktree', 'add', '-b', 'unrelated-branch', unrelated, 'HEAD'])
      await mkdir(join(unrelated, '.drovr'), { recursive: true })
      await writeFile(
        join(unrelated, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {}
`,
        'utf8',
      )

      try {
        expect(() =>
          execFileSync('node', [drovr, 'start'], { cwd: unrelated, stdio: 'pipe' }),
        ).not.toThrow()
      } finally {
        runGit(repo, ['worktree', 'remove', '--force', unrelated])
        await rm(unrelated, { recursive: true, force: true })
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with resume guidance when derived branch already exists on fresh start and does not delete or mutate it', async () => {
    const repo = await initRepo()
    runGit(repo, ['branch', 'drovr/preexisting-branch'])

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'preexisting-branch' })
}
`,
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /--resume/,
      )

      // Branch must still exist
      const branchSha = runGit(repo, ['rev-parse', 'refs/heads/drovr/preexisting-branch'])
      expect(branchSha).toBeDefined()

      // Worktree path must NOT be created
      expect(existsSync(join(repo, '.worktrees', 'preexisting-branch'))).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with resume guidance when derived path already exists on fresh start and does not delete or adopt it', async () => {
    const repo = await initRepo()
    const targetDir = join(repo, '.worktrees', 'preexisting-dir')
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'foreign.txt'), 'do not delete\n', 'utf8')

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'preexisting-dir' })
}
`,
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /--resume/,
      )

      // Path and file must still exist untouched
      expect(existsSync(targetDir)).toBe(true)
      expect(await readFile(join(targetDir, 'foreign.txt'), 'utf8')).toBe('do not delete\n')

      // Branch must NOT be created
      expect(() =>
        runGit(repo, ['rev-parse', '--verify', 'refs/heads/drovr/preexisting-dir']),
      ).toThrow(/Command failed/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with resume guidance when both branch and path already exist on fresh start', async () => {
    const repo = await initRepo()
    const targetDir = join(repo, '.worktrees', 'both-exist')
    runGit(repo, ['worktree', 'add', '-b', 'drovr/both-exist', targetDir, 'HEAD'])

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'both-exist' })
}
`,
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /--resume/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rejects illegal Names before git mutation', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  const illegalNames = ['UPPERCASE', '123start', 'has space', 'foo/bar', 'name_is_way_too_long_exceeding_32_characters_limit', '']
  for (const name of illegalNames) {
    try {
      await drovr.worktree({ name: name as unknown as Parameters<typeof drovr.worktree>[0]['name'] })
      throw new Error('should have failed for name: ' + name)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes('Invalid name') && !message.includes('Names must match')) {
        throw err
      }
    }
  }
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      // No branches or worktrees were created
      const branches = runGit(repo, ['branch', '--list', 'drovr/*'])
      expect(branches).toBe('')
      expect(existsSync(join(repo, '.worktrees'))).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('detects managed worktrees beneath external linked Start checkouts and symlinks', async () => {
    const repo = await initRepo()
    const externalLinked = await mkdtemp(join(tmpdir(), 'drovr-ext-linked-'))
    runGit(repo, ['worktree', 'add', '-b', 'feat-ext-linked', externalLinked, 'HEAD'])

    try {
      const nestedInExternal = join(externalLinked, '.worktrees', 'nested-worker')
      runGit(externalLinked, [
        'worktree',
        'add',
        '-b',
        'drovr/nested-worker',
        nestedInExternal,
        'HEAD',
      ])

      // Starting Drovr from nestedInExternal must fail
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: nestedInExternal, stdio: 'pipe' }),
      ).toThrow(/managed.*worktree|\.worktrees/i)

      // Symlink to nested worktree must also fail
      const symlinkPath = join(repo, 'symlink-to-nested')
      await symlink(nestedInExternal, symlinkPath, 'dir')
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: symlinkPath, stdio: 'pipe' }),
      ).toThrow(/managed.*worktree|\.worktrees/i)

      // But starting from externalLinked itself must succeed
      await mkdir(join(externalLinked, '.drovr'), { recursive: true })
      await writeFile(
        join(externalLinked, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {}
`,
        'utf8',
      )
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: externalLinked, stdio: 'pipe' }),
      ).not.toThrow()
    } finally {
      runGit(repo, ['worktree', 'remove', '--force', externalLinked])
      await rm(externalLinked, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('detects managed worktrees when registered roots contain newlines or trailing whitespace', async () => {
    const repo = await initRepo()
    const parentDir = await mkdtemp(join(tmpdir(), 'drovr-special-parent-'))
    const specialRoot = join(parentDir, 'special-\nroot space ')
    await mkdir(specialRoot, { recursive: true })
    runGit(repo, ['worktree', 'add', '-b', 'feat-special-ws', specialRoot, 'HEAD'])
    try {
      const nestedInSpecial = join(specialRoot, '.worktrees', 'worker-ws')
      runGit(specialRoot, ['worktree', 'add', '-b', 'drovr/worker-ws', nestedInSpecial, 'HEAD'])

      // Starting Drovr from nested child of the special root must fail
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: nestedInSpecial, stdio: 'pipe' }),
      ).toThrow(/managed.*worktree|\.worktrees/i)

      // Starting from specialRoot itself succeeds
      await mkdir(join(specialRoot, '.drovr'), { recursive: true })
      await writeFile(
        join(specialRoot, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {}
`,
        'utf8',
      )
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: specialRoot, stdio: 'pipe' }),
      ).not.toThrow()
    } finally {
      runGit(repo, ['worktree', 'remove', '--force', specialRoot])
      await rm(parentDir, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with resume guidance when derived path is a file, directory, valid symlink, or dangling symlink before exclude or git mutation', async () => {
    const repo = await initRepo()
    const wtDir = join(repo, '.worktrees')
    await mkdir(wtDir, { recursive: true })

    // 1. Regular file
    const filePath = join(wtDir, 'file-entry')
    await writeFile(filePath, 'i am a file\n', 'utf8')

    // 2. Directory
    const dirPath = join(wtDir, 'dir-entry')
    await mkdir(dirPath, { recursive: true })
    await writeFile(join(dirPath, 'content.txt'), 'dir content\n', 'utf8')

    // 3. Valid symlink
    const targetFile = join(repo, 'README.md')
    const validSymlinkPath = join(wtDir, 'valid-symlink-entry')
    await symlink(targetFile, validSymlinkPath)

    // 4. Dangling symlink
    const danglingSymlinkPath = join(wtDir, 'dangling-symlink-entry')
    await symlink(join(repo, 'non-existent-target'), danglingSymlinkPath)

    const excludePath = join(repo, '.git', 'info', 'exclude')
    await mkdir(join(repo, '.git', 'info'), { recursive: true })
    await writeFile(excludePath, 'keep-me\n', 'utf8')

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })

      const entriesToTest = [
        'file-entry',
        'dir-entry',
        'valid-symlink-entry',
        'dangling-symlink-entry',
      ]

      for (const name of entriesToTest) {
        await writeFile(
          join(repo, '.drovr/main.ts'),
          `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: ${JSON.stringify(name)} })
}
`,
          'utf8',
        )

        expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
          /--resume/,
        )

        // Branch must NOT be created
        expect(() => runGit(repo, ['rev-parse', '--verify', `refs/heads/drovr/${name}`])).toThrow(
          /Command failed/,
        )
      }

      // File entries must remain untouched
      expect(await readFile(filePath, 'utf8')).toBe('i am a file\n')
      expect(await readFile(join(dirPath, 'content.txt'), 'utf8')).toBe('dir content\n')
      expect(lstatSync(validSymlinkPath).isSymbolicLink()).toBe(true)
      expect(lstatSync(danglingSymlinkPath).isSymbolicLink()).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('propagates fatal git errors and broken refs before exclude or git mutation', async () => {
    const repo = await initRepo()
    const brokenRefPath = join(repo, '.git', 'refs', 'heads', 'drovr', 'broken-ref')
    await mkdir(join(repo, '.git', 'refs', 'heads', 'drovr'), { recursive: true })
    await writeFile(brokenRefPath, 'invalid-broken-sha\n', 'utf8')

    const excludePath = join(repo, '.git', 'info', 'exclude')
    await mkdir(join(repo, '.git', 'info'), { recursive: true })
    await writeFile(excludePath, 'custom-exclude\n', 'utf8')

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'broken-ref' })
}
`,
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /broken or corrupt|not a valid ref|show-ref/i,
      )

      // Exclude must NOT be mutated with /.worktrees/
      const excludeContent = await readFile(excludePath, 'utf8')
      expect(excludeContent).toBe('custom-exclude\n')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('warns on a Start checkout containing only untracked files even when status.showUntrackedFiles is no', async () => {
    const repo = await initRepo()
    runGit(repo, ['config', 'status.showUntrackedFiles', 'no'])

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'untracked-probe' })
}
`,
        'utf8',
      )

      // Only an untracked file
      await writeFile(join(repo, 'untracked-only.txt'), 'untracked content\n', 'utf8')

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc.status).toBe(0)
      expect(proc.stderr).toMatch(/warning.*uncommitted/i)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Issue #27: Drovr.worktree resume reconnect and repair', () => {
  it('preserves matching dirty Worktree in place with uncommitted files untouched on resume', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'dirty-resume' })
  // In pass 1, record uncommitted changes
  const pass = await (async () => {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      return (await readFile(join(${JSON.stringify(repo)}, 'pass.txt'), 'utf8')).trim()
    } catch {
      return '1'
    }
  })()

  if (pass === '1') {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    // Modify existing tracked file
    await writeFile(join(wt.path, 'source.txt'), 'modified in worktree\\n', 'utf8')
    // Create new untracked file
    await writeFile(join(wt.path, 'untracked.txt'), 'untracked content\\n', 'utf8')
    // Create new file and stage it
    await writeFile(join(wt.path, 'staged.txt'), 'staged content\\n', 'utf8')
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['add', 'staged.txt'], { cwd: wt.path })
    // Throw to simulate failure/interruption before completing
    throw new Error('simulated crash in pass 1')
  }

  // Pass 2 (resume): verify worktree identity and uncommitted files
  const { readFile, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const source = await readFile(join(wt.path, 'source.txt'), 'utf8')
  if (source !== 'modified in worktree\\n') {
    throw new Error('source.txt was modified/reset: ' + source)
  }
  const untracked = await readFile(join(wt.path, 'untracked.txt'), 'utf8')
  if (untracked !== 'untracked content\\n') {
    throw new Error('untracked.txt was modified: ' + untracked)
  }
  const staged = await readFile(join(wt.path, 'staged.txt'), 'utf8')
  if (staged !== 'staged content\\n') {
    throw new Error('staged.txt was modified: ' + staged)
  }
  await writeFile(join(${JSON.stringify(repo)}, 'resume-success.txt'), 'ok\\n', 'utf8')
}
`,
        'utf8',
      )

      // Pass 1: fresh start fails
      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /simulated crash in pass 1/,
      )

      const worktreePath = join(repo, '.worktrees', 'dirty-resume')
      expect(existsSync(worktreePath)).toBe(true)

      // Set pass 2
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')

      // Pass 2: resume
      execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' })

      expect(existsSync(join(repo, 'resume-success.txt'))).toBe(true)

      // Verify git status in worktree still has staged, modified, and untracked files
      const wtStatus = runGit(worktreePath, ['status', '--porcelain'])
      expect(wtStatus).toContain('M source.txt')
      expect(wtStatus).toContain('A  staged.txt')
      expect(wtStatus).toContain('?? untracked.txt')

      // Verify branch is still drovr/dirty-resume
      const currentBranch = runGit(worktreePath, ['symbolic-ref', '--short', 'HEAD'])
      expect(currentBranch).toBe('drovr/dirty-resume')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('recreates missing Worktree directory on surviving derived branch after stale git metadata repair', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'recreate-branch' })
  const pass = await (async () => {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      return (await readFile(join(${JSON.stringify(repo)}, 'pass.txt'), 'utf8')).trim()
    } catch {
      return '1'
    }
  })()

  if (pass === '1') {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { execFileSync } = await import('node:child_process')
    // Commit a file on the branch
    await writeFile(join(wt.path, 'branch-step.txt'), 'step 1 committed\\n', 'utf8')
    execFileSync('git', ['add', 'branch-step.txt'], { cwd: wt.path })
    execFileSync('git', ['commit', '-m', 'commit step 1'], { cwd: wt.path })
    throw new Error('crash after commit')
  }

  // Pass 2: verify recreated worktree has surviving branch history
  const { readFile, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const content = await readFile(join(wt.path, 'branch-step.txt'), 'utf8')
  if (content !== 'step 1 committed\\n') {
    throw new Error('branch commit missing in recreated worktree')
  }
  await writeFile(join(${JSON.stringify(repo)}, 'recreated-ok.txt'), 'done\\n', 'utf8')
}
`,
        'utf8',
      )

      // Pass 1: fresh start creates worktree and commits on branch, then crashes
      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /crash after commit/,
      )

      const worktreePath = join(repo, '.worktrees', 'recreate-branch')
      expect(existsSync(worktreePath)).toBe(true)

      // Simulate complete loss/deletion of worktree directory while branch survives
      await rm(worktreePath, { recursive: true, force: true })
      expect(existsSync(worktreePath)).toBe(false)

      // Stale git metadata still exists before resume
      const rawList = runGit(repo, ['worktree', 'list', '--porcelain'])
      expect(rawList).toContain('recreate-branch')

      // Set pass 2
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')

      // Pass 2: resume reconnects by pruning stale metadata and recreating worktree on surviving branch
      execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' })

      expect(existsSync(join(repo, 'recreated-ok.txt'))).toBe(true)
      expect(existsSync(worktreePath)).toBe(true)
      expect(await readFile(join(worktreePath, 'branch-step.txt'), 'utf8')).toBe(
        'step 1 committed\n',
      )

      // Verify worktree is linked to repository and on drovr/recreate-branch
      const wtTopLevel = runGit(worktreePath, ['rev-parse', '--show-toplevel'])
      expect(wtTopLevel).toBe(worktreePath)
      const wtBranch = runGit(worktreePath, ['symbolic-ref', '--short', 'HEAD'])
      expect(wtBranch).toBe('drovr/recreate-branch')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails when present directory is foreign and does not delete, adopt, or mutate it', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Run starter workflow once to initialize project database
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {}
`,
        'utf8',
      )
      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      // Scenario A: Plain foreign directory with uncommitted content
      const foreignDir = join(repo, '.worktrees', 'foreign-dir')
      await mkdir(foreignDir, { recursive: true })
      await writeFile(join(foreignDir, 'foreign-data.txt'), 'precious data\n', 'utf8')

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'foreign-dir' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' }),
      ).toThrow(/foreign/i)

      // Foreign directory and files MUST NOT be deleted, adopted, or modified
      expect(existsSync(foreignDir)).toBe(true)
      expect(await readFile(join(foreignDir, 'foreign-data.txt'), 'utf8')).toBe('precious data\n')
      expect(() => runGit(repo, ['rev-parse', '--verify', 'refs/heads/drovr/foreign-dir'])).toThrow(
        /Command failed/,
      )

      // Scenario B: Independent foreign git repository
      const foreignGit = join(repo, '.worktrees', 'foreign-git')
      await mkdir(foreignGit, { recursive: true })
      runGit(foreignGit, ['init', '-b', 'drovr/foreign-git'])
      await writeFile(join(foreignGit, 'repo-file.txt'), 'repo file\n', 'utf8')

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'foreign-git' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' }),
      ).toThrow(/foreign/i)

      expect(existsSync(foreignGit)).toBe(true)
      expect(await readFile(join(foreignGit, 'repo-file.txt'), 'utf8')).toBe('repo file\n')

      // Scenario C: Plain file at derived worktree location
      const foreignFile = join(repo, '.worktrees', 'foreign-file')
      await writeFile(foreignFile, 'just a file\n', 'utf8')

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'foreign-file' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' }),
      ).toThrow(/foreign|directory/i)

      expect(existsSync(foreignFile)).toBe(true)
      expect(await readFile(foreignFile, 'utf8')).toBe('just a file\n')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails when matching repository Worktree is on the wrong branch and does not switch branches or mutate files', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Run starter workflow to initialize db
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {}
`,
        'utf8',
      )
      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      // Scenario A: Linked worktree on other-branch
      const wtWrong = join(repo, '.worktrees', 'wrong-branch')
      runGit(repo, ['worktree', 'add', '-b', 'other-branch', wtWrong, 'HEAD'])
      await writeFile(join(wtWrong, 'unrelated.txt'), 'unrelated work\n', 'utf8')

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'wrong-branch' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' }),
      ).toThrow(/branch/i)

      // Worktree must still be on other-branch and unmodified
      const currentBranch = runGit(wtWrong, ['symbolic-ref', '--short', 'HEAD'])
      expect(currentBranch).toBe('other-branch')
      expect(await readFile(join(wtWrong, 'unrelated.txt'), 'utf8')).toBe('unrelated work\n')

      // Scenario B: Linked worktree in detached HEAD state
      const wtDetached = join(repo, '.worktrees', 'detached-item')
      runGit(repo, ['worktree', 'add', '-b', 'drovr/detached-item', wtDetached, 'HEAD'])
      runGit(wtDetached, ['checkout', '--detach', 'HEAD'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'detached-item' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' }),
      ).toThrow(/branch|detached/i)

      expect(() => runGit(wtDetached, ['symbolic-ref', '--short', 'HEAD'])).toThrow(
        /Command failed/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails when both Worktree directory and derived branch are lost without creating a fresh branch or path', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {}
`,
        'utf8',
      )
      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'lost-both' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' }),
      ).toThrow(/neither path.*nor branch.*exists/i)

      // No branch or worktree directory created
      expect(() => runGit(repo, ['rev-parse', '--verify', 'refs/heads/drovr/lost-both'])).toThrow(
        /Command failed/,
      )
      expect(existsSync(join(repo, '.worktrees', 'lost-both'))).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('handles multi-item resumed workflow combining skipped completed items, matching dirty reconnect, and missing directory repair', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  const pass = await (async () => {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      return (await readFile(join(${JSON.stringify(repo)}, 'pass.txt'), 'utf8')).trim()
    } catch {
      return '1'
    }
  })()

  await drovr.map(
    ['item-one', 'item-two', 'item-three'],
    { concurrency: 1, name: (x) => x },
    async (item) => {
      const wt = await drovr.worktree({ name: item })
      const { readFile, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { execFileSync } = await import('node:child_process')

      if (pass === '1') {
        if (item === 'item-one') {
          // item-one succeeds and completes
          await writeFile(join(wt.path, 'result.txt'), 'item-one-done\\n', 'utf8')
          return
        }
        if (item === 'item-two') {
          // item-two makes dirty change and throws
          await writeFile(join(wt.path, 'dirty-two.txt'), 'dirty content two\\n', 'utf8')
          throw new Error('item-two interrupted in pass 1')
        }
        if (item === 'item-three') {
          // item-three commits on branch and throws
          await writeFile(join(wt.path, 'committed-three.txt'), 'step 3 commit\\n', 'utf8')
          execFileSync('git', ['add', 'committed-three.txt'], { cwd: wt.path })
          execFileSync('git', ['commit', '-m', 'commit three'], { cwd: wt.path })
          throw new Error('item-three interrupted in pass 1')
        }
      }

      // Pass 2 (resume):
      if (item === 'item-one') {
        throw new Error('item-one should have been skipped on resume!')
      }
      if (item === 'item-two') {
        const dirtyContent = await readFile(join(wt.path, 'dirty-two.txt'), 'utf8')
        if (dirtyContent !== 'dirty content two\\n') {
          throw new Error('item-two dirty content missing: ' + dirtyContent)
        }
        return
      }
      if (item === 'item-three') {
        const branchContent = await readFile(join(wt.path, 'committed-three.txt'), 'utf8')
        if (branchContent !== 'step 3 commit\\n') {
          throw new Error('item-three branch content missing: ' + branchContent)
        }
        return
      }
    }
  )
}
`,
        'utf8',
      )

      // Pass 1: map starts, item-one completes, item-two fails
      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /map items failed: item-two/i,
      )

      const wt3Path = join(repo, '.worktrees', 'item-three')
      expect(existsSync(wt3Path)).toBe(true)
      await rm(wt3Path, { recursive: true, force: true })

      // Set pass 2
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')

      // Pass 2: resume
      execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' })

      // Check log
      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const resumeLines = logContent
        .trim()
        .split('\n')
        .filter((l) => l.includes('mode=resume') || l.includes('name=item-'))

      // item-one was skipped
      expect(
        resumeLines.some((l) => l.includes('map.item.skip') && l.includes('name=item-one')),
      ).toBe(true)
      // item-two was re-run and completed
      expect(
        resumeLines.some((l) => l.includes('map.item.start') && l.includes('name=item-two')),
      ).toBe(true)
      expect(
        resumeLines.some((l) => l.includes('map.item.complete') && l.includes('name=item-two')),
      ).toBe(true)
      // item-three was re-run and completed
      expect(
        resumeLines.some((l) => l.includes('map.item.start') && l.includes('name=item-three')),
      ).toBe(true)
      expect(
        resumeLines.some((l) => l.includes('map.item.complete') && l.includes('name=item-three')),
      ).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
