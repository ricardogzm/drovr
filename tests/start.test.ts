import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  const dir = await mkdtemp(join(tmpdir(), 'drovr-start-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  await writeFile(join(dir, 'README.md'), '# test\n', 'utf8')
  runGit(dir, ['add', 'README.md'])
  runGit(dir, ['commit', '-m', 'init'])
  return dir
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await readFile(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`timed out waiting for file: ${path}`)
}

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('drovr start', () => {
  it('runs a typed no-op Workflow when setup was skipped and lazily creates hygiene files', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'import type { Drovr } from "drovr"\n\nexport default async function workflow(_drovr: Drovr): Promise<void> {}\n',
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      expect(await readFile(join(repo, '.drovr/.gitignore'), 'utf8')).toBe(
        'state.sqlite*\ndrovr.log\nstart.lock*\n',
      )
      const sqliteStat = await stat(join(repo, '.drovr/state.sqlite'))
      expect(sqliteStat.isFile()).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('injects a Drovr handle and awaits the async workflow to completion', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { writeFile } from "node:fs/promises"

export default async function workflow(drovr: Drovr): Promise<void> {
  if (!drovr || typeof drovr.resource !== 'function' || typeof drovr.map !== 'function' || !drovr.issues) {
    throw new Error('invalid drovr handle')
  }
  await writeFile('output.txt', 'workflow-finished', 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      expect(await readFile(join(repo, 'output.txt'), 'utf8')).toBe('workflow-finished')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('succeeds from a nested directory inside the worktree', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { writeFile } from "node:fs/promises"

export default async function workflow(_drovr: Drovr): Promise<void> {
  await writeFile('nested-result.txt', 'ok', 'utf8')
}
`,
        'utf8',
      )

      const nested = join(repo, 'src/deep/sub')
      await mkdir(nested, { recursive: true })

      execFileSync('node', [drovr, 'start'], { cwd: nested, stdio: 'pipe' })
      expect(await readFile(join(nested, 'nested-result.txt'), 'utf8')).toBe('ok')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('preserves existing ignore content and appends missing entries once', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/.gitignore'),
        '# custom comment\nstate.sqlite*\nmy-file.tmp\n',
        'utf8',
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() {}\n',
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      expect(await readFile(join(repo, '.drovr/.gitignore'), 'utf8')).toBe(
        '# custom comment\nstate.sqlite*\nmy-file.tmp\ndrovr.log\nstart.lock*\n',
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with a clear error when .drovr/main.ts does not exist', async () => {
    const repo = await initRepo()

    try {
      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /no Workflow at \.drovr\/main\.ts/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with a clear error when .drovr/main.ts does not export a default function', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(join(repo, '.drovr/main.ts'), 'export const workflow = 123\n', 'utf8')

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /must default export a function/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails and reports workflow execution errors on stderr', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() { throw new Error("workflow failed intentionally") }\n',
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /workflow failed intentionally/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails outside git without creating files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drovr-start-no-git-'))

    try {
      expect(() => execFileSync('node', [drovr, 'start'], { cwd: dir, stdio: 'pipe' })).toThrow(
        /git worktree/,
      )
      await expect(readFile(join(dir, '.drovr/main.ts'), 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('prevents concurrent start invocations in the same checkout with an advisory lock', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { readFile, writeFile } from "node:fs/promises"

export default async function workflow(): Promise<void> {
  await writeFile('started.txt', 'running', 'utf8')
  while (true) {
    try {
      await readFile('finish.txt')
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}
`,
        'utf8',
      )

      const child = spawn('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      const startedPath = join(repo, 'started.txt')
      const finishPath = join(repo, 'finish.txt')

      await waitForFile(startedPath)

      // Concurrent invocation must fail immediately with clear lock error
      let errorOutput = ''
      try {
        execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe', encoding: 'utf8' })
      } catch (err: unknown) {
        if (err && typeof err === 'object') {
          const e = err as { stderr?: string; stdout?: string; message?: string }
          errorOutput = e.stderr || e.stdout || e.message || ''
        }
      }

      expect(errorOutput).toContain('another drovr process is already running in this checkout')

      // Release child by creating finish file
      await writeFile(finishPath, 'done', 'utf8')
      const [exitCode] = await once(child, 'exit')
      expect(exitCode).toBe(0)

      // Subsequent start can run and succeed
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() {}\n',
        'utf8',
      )
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' }),
      ).not.toThrow()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('releases the lock upon operating system process termination (SIGKILL)', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from "node:fs/promises"

export default async function workflow(): Promise<void> {
  await writeFile('started.txt', 'running', 'utf8')
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
`,
        'utf8',
      )

      const child = spawn('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      const startedPath = join(repo, 'started.txt')
      await waitForFile(startedPath)

      // Terminate child abruptly with SIGKILL
      child.kill('SIGKILL')
      await once(child, 'exit')

      // Immediate start must acquire lock and succeed
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() {}\n',
        'utf8',
      )
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' }),
      ).not.toThrow()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('releases the lock when workflow throws and allows subsequent runs', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() { throw new Error("first run failed") }\n',
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /first run failed/,
      )

      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() {}\n',
        'utf8',
      )
      expect(() =>
        execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' }),
      ).not.toThrow()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('appends plain semantic start.begin and start.complete events with RFC 3339 UTC timestamps and mode=fresh to drovr.log on success', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() {}\n',
        'utf8',
      )

      const result = execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      // Normal mode writes orchestration events only to file; stderr should be empty
      expect(result).toBe('')

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const lines = logContent.trim().split('\n')
      expect(lines).toHaveLength(2)

      // Line 1: start.begin
      expect(lines[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+INFO\s+start\.begin\s+mode=fresh$/,
      )

      // Line 2: start.complete
      expect(lines[1]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+INFO\s+start\.complete\s+mode=fresh\s+started=0\s+skipped=0\s+completed=0\s+failed=0$/,
      )

      // No ANSI escapes in the durable log
      expect(logContent).not.toContain('\x1b[')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('appends start.fail event to drovr.log with error and item counts on workflow error', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() { throw new Error("workflow failed intentionally") }\n',
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /workflow failed intentionally/,
      )

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const lines = logContent.trim().split('\n')
      expect(lines).toHaveLength(2)

      expect(lines[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+INFO\s+start\.begin\s+mode=fresh$/,
      )
      expect(lines[1]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+ERROR\s+start\.fail\s+mode=fresh\s+started=0\s+skipped=0\s+completed=0\s+failed=0\s+error=.*workflow failed intentionally.*$/,
      )
      expect(logContent).not.toContain('\x1b[')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('supports start --resume and appends mode=resume start events', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() {}\n',
        'utf8',
      )

      // First run fresh start to create project database
      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      // Second run with --resume
      execFileSync('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' })

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const lines = logContent.trim().split('\n')
      expect(lines).toHaveLength(4)

      expect(lines[0]).toMatch(/INFO\s+start\.begin\s+mode=fresh/)
      expect(lines[1]).toMatch(/INFO\s+start\.complete\s+mode=fresh/)
      expect(lines[2]).toMatch(/INFO\s+start\.begin\s+mode=resume/)
      expect(lines[3]).toMatch(
        /INFO\s+start\.complete\s+mode=resume\s+started=0\s+skipped=0\s+completed=0\s+failed=0/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails start --resume when no project database exists and logs start.fail mode=resume', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() {}\n',
        'utf8',
      )

      let stderrOutput = ''
      try {
        execFileSync('node', [drovr, 'start', '--resume'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        })
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string }
        stderrOutput = e.stderr || e.message || ''
      }

      expect(stderrOutput).toMatch(/Project database/i)

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const lines = logContent.trim().split('\n')
      expect(lines).toHaveLength(2)

      expect(lines[0]).toMatch(/INFO\s+start\.begin\s+mode=resume/)
      expect(lines[1]).toMatch(
        /ERROR\s+start\.fail\s+mode=resume\s+started=0\s+skipped=0\s+completed=0\s+failed=0/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('mirrors events to stderr in verbose mode (--verbose) without adding ANSI escapes to the log', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() {}\n',
        'utf8',
      )

      let stderrOutput = ''
      const child = spawn('node', [drovr, 'start', '--verbose'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stderr.on('data', (chunk) => {
        stderrOutput += chunk.toString()
      })
      const [exitCode] = await once(child, 'exit')
      expect(exitCode).toBe(0)

      expect(stderrOutput).toContain('start.begin mode=fresh')
      expect(stderrOutput).toContain(
        'start.complete mode=fresh started=0 skipped=0 completed=0 failed=0',
      )

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      expect(logContent).toContain('start.begin mode=fresh')
      expect(logContent).toContain('start.complete mode=fresh')
      expect(logContent).not.toContain('\x1b[')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('gates terminal color on stderr TTY state and NO_COLOR', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        'export default async function workflow() {}\n',
        'utf8',
      )

      // Non-TTY (piped child process): no ANSI color codes in stderr
      let nonTtyStderr = ''
      const child1 = spawn('node', [drovr, 'start', '--verbose'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child1.stderr.on('data', (chunk) => {
        nonTtyStderr += chunk.toString()
      })
      const [exit1] = await once(child1, 'exit')
      expect(exit1).toBe(0)
      expect(nonTtyStderr).not.toContain('\x1b[')

      // PTY with NO_COLOR unset: contains ANSI color codes on stderr
      const ptyColorStderr = execFileSync(
        'script',
        ['-qec', `node ${drovr} start --verbose`, '/dev/null'],
        {
          cwd: repo,
          encoding: 'utf8',
          env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NO_COLOR')),
        },
      )
      expect(ptyColorStderr).toContain('\x1b[')

      // PTY with NO_COLOR set: contains NO ANSI color codes
      const ptyNoColorStderr = execFileSync(
        'script',
        ['-qec', `node ${drovr} start --verbose`, '/dev/null'],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            NO_COLOR: '1',
          },
        },
      )
      expect(ptyNoColorStderr).not.toContain('\x1b[')

      // File log never contains ANSI color codes in any mode
      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      expect(logContent).not.toContain('\x1b[')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('falls back to stderr without changing Workflow result if drovr.log cannot be opened', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr/drovr.log'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from "node:fs/promises"

export default async function workflow(): Promise<void> {
  await writeFile('result.txt', 'workflow-succeeded-despite-log-error', 'utf8')
}
`,
        'utf8',
      )

      let stderrOutput = ''
      const child = spawn('node', [drovr, 'start'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stderr.on('data', (chunk) => {
        stderrOutput += chunk.toString()
      })
      const [exitCode] = await once(child, 'exit')

      // Workflow must still succeed and exit 0
      expect(exitCode).toBe(0)
      expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe(
        'workflow-succeeded-despite-log-error',
      )

      // Emits one diagnostic warning to stderr
      expect(stderrOutput).toMatch(/failed to write to.*drovr\.log/i)

      // Moves subsequent events to stderr
      expect(stderrOutput).toMatch(/INFO\s+start\.complete\s+mode=fresh/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
