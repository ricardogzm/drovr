import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const dir = await mkdtemp(join(tmpdir(), 'drovr-worktree-setup-'))
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

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
    await exited
  }
}

async function waitForReadiness(
  check: () => boolean,
  options: {
    child?: ChildProcess
    timeoutMs?: number
    description: string
  },
): Promise<void> {
  const { child, timeoutMs = 5000, description } = options
  const startTime = Date.now()

  while (!check()) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `Process exited prematurely with code ${child.exitCode} (signal ${child.signalCode}) while waiting for ${description}`,
      )
    }
    if (Date.now() - startTime >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function lockDatabase(
  dbPath: string,
  timeoutMs = 5000,
): Promise<{ release: () => Promise<void> }> {
  const locker = spawn(
    'node',
    [
      '-e',
      `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout = 100;');
      db.exec('BEGIN EXCLUSIVE;');
      process.stdout.write('LOCKED\\n');
      process.stdin.resume();
      process.stdin.on('data', () => {
        try { db.exec('ROLLBACK;'); } catch {}
        try { db.close(); } catch {}
        process.exit(0);
      });
    `,
      dbPath,
    ],
    { detached: true, stdio: ['pipe', 'pipe', 'inherit'] },
  )

  let locked = false
  locker.stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('LOCKED')) {
      locked = true
    }
  })

  const release = async () => {
    if (locker.exitCode === null && locker.signalCode === null) {
      try {
        locker.stdin.write('RELEASE\n')
      } catch {}
      const exited = new Promise<void>((resolve) => locker.on('exit', () => resolve()))
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 500))
      await Promise.race([exited, timeout])
      await terminateProcess(locker)
    }
  }

  try {
    await waitForReadiness(() => locked, {
      child: locker,
      timeoutMs,
      description: `database lock on ${dbPath}`,
    })
  } catch (error) {
    await release()
    throw error
  }

  return { release }
}

describe('Issue #28: Worktree setup gates readiness', () => {
  it('absent setup configuration succeeds without spawning setup commands', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'no-setup' })
  if (wt.name !== 'no-setup') {
    throw new Error('wrong name: ' + wt.name)
  }
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).toBe(0)
      const worktreePath = join(repo, '.worktrees', 'no-setup')
      expect(existsSync(worktreePath)).toBe(true)
      expect(existsSync(join(worktreePath, '.drovr', 'worktrees.json'))).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('empty setup configuration array succeeds without spawning setup commands', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(join(repo, '.drovr', 'worktrees.json'), '[]\n', 'utf8')
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add empty worktrees.json'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'empty-setup' })
  if (wt.name !== 'empty-setup') {
    throw new Error('wrong name: ' + wt.name)
  }
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).toBe(0)
      const worktreePath = join(repo, '.worktrees', 'empty-setup')
      expect(existsSync(worktreePath)).toBe(true)
      expect(await readFile(join(worktreePath, '.drovr', 'worktrees.json'), 'utf8')).toBe('[]\n')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('runs valid command array sequentially with Worktree as cwd and absolute DROVR_START_CHECKOUT in env', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          'echo step1 > step1.txt && echo "$DROVR_START_CHECKOUT" > start_checkout.txt && pwd -P > cwd.txt',
          'test -f step1.txt && echo step2 > step2.txt',
          'test -f step2.txt && echo step3 > step3.txt',
        ]),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add sequential setup commands'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'seq-item' })
  if (wt.name !== 'seq-item') {
    throw new Error('wrong name')
  }
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).toBe(0)
      const worktreePath = join(repo, '.worktrees', 'seq-item')
      expect(existsSync(worktreePath)).toBe(true)

      const step1 = await readFile(join(worktreePath, 'step1.txt'), 'utf8')
      const step2 = await readFile(join(worktreePath, 'step2.txt'), 'utf8')
      const step3 = await readFile(join(worktreePath, 'step3.txt'), 'utf8')
      expect(step1.trim()).toBe('step1')
      expect(step2.trim()).toBe('step2')
      expect(step3.trim()).toBe('step3')

      const recordedStartCheckout = (
        await readFile(join(worktreePath, 'start_checkout.txt'), 'utf8')
      ).trim()
      const expectedStartCheckout = runGit(repo, ['rev-parse', '--show-toplevel'])
      expect(recordedStartCheckout).toBe(expectedStartCheckout)

      const recordedCwd = (await readFile(join(worktreePath, 'cwd.txt'), 'utf8')).trim()
      const expectedCwd = runGit(worktreePath, ['rev-parse', '--show-toplevel'])
      expect(recordedCwd).toBe(expectedCwd)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('gives each command a fresh process environment so mutations do not leak across commands', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          'export DROVR_TEST_LEAK_VAR="leaked_value"',
          'if [ -n "$DROVR_TEST_LEAK_VAR" ]; then echo "leaked" > leaked.txt && exit 1; else echo "clean" > clean.txt; fi',
        ]),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add fresh env setup test'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'fresh-env-item' })
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).toBe(0)
      const worktreePath = join(repo, '.worktrees', 'fresh-env-item')
      expect(existsSync(join(worktreePath, 'clean.txt'))).toBe(true)
      expect(existsSync(join(worktreePath, 'leaked.txt'))).toBe(false)
      expect((await readFile(join(worktreePath, 'clean.txt'), 'utf8')).trim()).toBe('clean')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('streams stdout and stderr live with Name and command-position identification', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          'echo "building assets" && echo "asset warning" >&2',
          'echo "running pre-flight" && echo "pre-flight note" >&2',
        ]),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add streaming setup commands'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'stream-item' })
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).toBe(0)
      expect(proc.stdout).toContain('[stream-item setup 1/2] building assets')
      expect(proc.stdout).toContain('[stream-item setup 2/2] running pre-flight')
      expect(proc.stderr).toContain('[stream-item setup 1/2] asset warning')
      expect(proc.stderr).toContain('[stream-item setup 2/2] pre-flight note')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
  it('streams identified live stdout immediately without waiting for newline or command exit/delay', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify(['printf "live-token" && sleep 1 && echo " completed"']),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add live unbuffered stdout setup test'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'live-stdout-item' })
}
`,
        'utf8',
      )

      const proc = spawn('node', [drovr, 'start'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let liveTokenSeenBeforeExit = false
      let fullStdout = ''

      proc.stdout.on('data', (chunk: Buffer | string) => {
        fullStdout += chunk.toString()
        if (fullStdout.includes('[live-stdout-item setup 1/1] live-token')) {
          // At the moment live-token is seen, command has not finished and 'completed' is not yet emitted
          if (!fullStdout.includes('completed') && proc.exitCode === null) {
            liveTokenSeenBeforeExit = true
          }
        }
      })

      const exitCode = await new Promise<number | null>((resolve) => {
        proc.on('close', (code) => resolve(code))
      })

      expect(exitCode).toBe(0)
      expect(liveTokenSeenBeforeExit).toBe(true)
      expect(fullStdout).toContain('[live-stdout-item setup 1/1] live-token')
      expect(fullStdout).toContain('[live-stdout-item setup 1/1]  completed')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('streams identified live stderr immediately without waiting for newline or command exit/delay', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify(['printf "live-err-token" >&2 && sleep 1 && echo " err-completed" >&2']),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add live unbuffered stderr setup test'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'live-stderr-item' })
}
`,
        'utf8',
      )

      const proc = spawn('node', [drovr, 'start'], {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let liveErrTokenSeenBeforeExit = false
      let fullStderr = ''

      proc.stderr.on('data', (chunk: Buffer | string) => {
        fullStderr += chunk.toString()
        if (fullStderr.includes('[live-stderr-item setup 1/1] live-err-token')) {
          // At the moment live-err-token is seen, command has not finished and 'err-completed' is not yet emitted
          if (!fullStderr.includes('err-completed') && proc.exitCode === null) {
            liveErrTokenSeenBeforeExit = true
          }
        }
      })

      const exitCode = await new Promise<number | null>((resolve) => {
        proc.on('close', (code) => resolve(code))
      })

      expect(exitCode).toBe(0)
      expect(liveErrTokenSeenBeforeExit).toBe(true)
      expect(fullStderr).toContain('[live-stderr-item setup 1/1] live-err-token')
      expect(fullStderr).toContain('[live-stderr-item setup 1/1]  err-completed')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with clear diagnostic when .drovr/worktrees.json has invalid JSON syntax', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(join(repo, '.drovr', 'worktrees.json'), '{\n  invalid json,\n}\n', 'utf8')
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add malformed worktrees.json'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'syntax-err-item' })
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).not.toBe(0)
      expect(proc.stderr).toMatch(/syntax-err-item/i)
      expect(proc.stderr).toMatch(/invalid json|worktrees\.json/i)

      // Physical Worktree remains intact
      const worktreePath = join(repo, '.worktrees', 'syntax-err-item')
      expect(existsSync(worktreePath)).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with clear diagnostic when .drovr/worktrees.json is not a top-level array', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify({ commands: ['echo 1'] }),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add object worktrees.json'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'non-array-item' })
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).not.toBe(0)
      expect(proc.stderr).toMatch(/non-array-item/i)
      expect(proc.stderr).toMatch(/top-level.*array/i)

      // Physical Worktree remains intact
      const worktreePath = join(repo, '.worktrees', 'non-array-item')
      expect(existsSync(worktreePath)).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with clear diagnostic when .drovr/worktrees.json contains non-string elements', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify(['echo ok', 123, 'echo later']),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add non-string command worktrees.json'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'non-string-cmd-item' })
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).not.toBe(0)
      expect(proc.stderr).toMatch(/non-string-cmd-item/i)
      expect(proc.stderr).toMatch(/position 2.*must be a string|number/i)

      // Physical Worktree remains intact
      const worktreePath = join(repo, '.worktrees', 'non-string-cmd-item')
      expect(existsSync(worktreePath)).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails identifying failing command, position, and exit code on nonzero exit and withholds Worktree handle', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          'echo "first step ok" > first.txt',
          'echo "failing step" >&2 && exit 42',
          'echo "never reached" > never.txt',
        ]),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add failing setup command'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export default async function workflow(drovr: Drovr): Promise<void> {
  let wtHandleReturned = false
  try {
    const wt = await drovr.worktree({ name: 'failing-cmd-item' })
    wtHandleReturned = true
    await writeFile(join(wt.path, 'marker.txt'), 'returned', 'utf8')
  } catch (err) {
    throw err
  }
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).not.toBe(0)
      expect(proc.stderr).toMatch(/failing-cmd-item/i)
      expect(proc.stderr).toMatch(/command 2 of 3/i)
      expect(proc.stderr).toMatch(/exit 42/i)
      expect(proc.stderr).toMatch(/code 42/i)

      // Output from failing command was streamed
      expect(proc.stderr).toContain('[failing-cmd-item setup 2/3] failing step')

      // Physical Worktree remains intact on disk
      const worktreePath = join(repo, '.worktrees', 'failing-cmd-item')
      expect(existsSync(worktreePath)).toBe(true)

      // Step 1 completed before Step 2 failed
      expect(existsSync(join(worktreePath, 'first.txt'))).toBe(true)
      expect((await readFile(join(worktreePath, 'first.txt'), 'utf8')).trim()).toBe('first step ok')

      // Step 3 never ran
      expect(existsSync(join(worktreePath, 'never.txt'))).toBe(false)

      // Workflow never received the Worktree handle
      expect(existsSync(join(worktreePath, 'marker.txt'))).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails identifying failing command, position, and signal on signal termination', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify(['echo "about to kill" && kill -TERM $$']),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add signal terminated setup command'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.worktree({ name: 'signal-item' })
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).not.toBe(0)
      expect(proc.stderr).toMatch(/signal-item/i)
      expect(proc.stderr).toMatch(/command 1 of 1/i)
      expect(proc.stderr).toMatch(/SIGTERM|signal/i)

      // Output before kill was streamed
      expect(proc.stdout).toContain('[signal-item setup 1/1] about to kill')

      // Physical Worktree remains intact
      const worktreePath = join(repo, '.worktrees', 'signal-item')
      expect(existsSync(worktreePath)).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('allows unrelated map items to continue when one item fails setup', async () => {
    const repo = await initRepo()

    try {
      // In main branch, add worktrees.json that checks branch or name or file
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          'if [ "$(basename "$PWD")" = "item-fail" ]; then echo "item-fail setup failed" >&2 && exit 1; else echo "setup ok for $(basename "$PWD")"; fi',
        ]),
        'utf8',
      )
      runGit(repo, ['add', '.drovr/worktrees.json'])
      runGit(repo, ['commit', '-m', 'add conditional setup command'])

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.map(
    ['item-fail', 'item-success'],
    { concurrency: 2, name: (item) => item },
    async (item) => {
      const wt = await drovr.worktree({ name: item })
      await writeFile(join(wt.path, 'completed.txt'), item + ' done\\n', 'utf8')
    }
  )
}
`,
        'utf8',
      )

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      // Overall start failed because one map item failed
      expect(proc.status).not.toBe(0)

      // Both physical worktrees exist
      const failPath = join(repo, '.worktrees', 'item-fail')
      const successPath = join(repo, '.worktrees', 'item-success')
      expect(existsSync(failPath)).toBe(true)
      expect(existsSync(successPath)).toBe(true)

      // item-fail failed setup and did not complete callback
      expect(existsSync(join(failPath, 'completed.txt'))).toBe(false)

      // item-success setup succeeded and completed callback
      expect(existsSync(join(successPath, 'completed.txt'))).toBe(true)
      expect(await readFile(join(successPath, 'completed.txt'), 'utf8')).toBe('item-success done\n')

      // Streamed output showed setup logs for both
      expect(proc.stderr).toContain('[item-fail setup 1/1] item-fail setup failed')
      expect(proc.stdout).toContain('[item-success setup 1/1] setup ok for item-success')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
  it('coordinates concurrent stdout streaming so partial A, full B, and continuation A lines are each fully attributed', async () => {
    const repo = await initRepo()
    const syncDir = await mkdtemp(join(tmpdir(), 'drovr-sync-stdout-'))

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          `name="$(basename "$PWD")"; if [ "$name" = "item-a" ]; then printf "a-partial\n" && touch "${syncDir}/a_started" && while [ ! -f "${syncDir}/b_done" ]; do sleep 0.05; done && echo "-continuation"; else while [ ! -f "${syncDir}/a_started" ]; do sleep 0.05; done && echo "b-full-line" && touch "${syncDir}/b_done"; fi`,
        ]),
        'utf8',
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.map(
    ['item-a', 'item-b'],
    { concurrency: 2, name: (x) => x },
    async (name) => {
      await drovr.worktree({ name })
    }
  )
}
`,
        'utf8',
      )
      runGit(repo, ['add', '.drovr'])
      runGit(repo, ['commit', '-m', 'add concurrent interleaved stdout test'])

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).toBe(0)
      const lines = proc.stdout.trim().split('\n')
      expect(lines).toContain('[item-a setup 1/1] a-partial')
      expect(lines).toContain('[item-b setup 1/1] b-full-line')
      expect(lines).toContain('[item-a setup 1/1] -continuation')

      // Every line in stdout must start with a recognized prefix
      for (const line of lines) {
        expect(line).toMatch(/^\[(?:item-a|item-b) setup 1\/1\] /)
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(syncDir, { recursive: true, force: true })
    }
  })

  it('coordinates concurrent stderr streaming so partial A, full B, and continuation A lines are each fully attributed', async () => {
    const repo = await initRepo()
    const syncDir = await mkdtemp(join(tmpdir(), 'drovr-sync-stderr-'))

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          `name="$(basename "$PWD")"; if [ "$name" = "item-a" ]; then printf "a-err-partial\n" >&2 && touch "${syncDir}/a_err_started" && while [ ! -f "${syncDir}/b_err_done" ]; do sleep 0.05; done && echo "-err-continuation" >&2; else while [ ! -f "${syncDir}/a_err_started" ]; do sleep 0.05; done && echo "b-err-full-line" >&2 && touch "${syncDir}/b_err_done"; fi`,
        ]),
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"

export default async function workflow(drovr: Drovr): Promise<void> {
  await drovr.map(
    ['item-a', 'item-b'],
    { concurrency: 2, name: (x) => x },
    async (name) => {
      await drovr.worktree({ name })
    }
  )
}
`,
        'utf8',
      )
      runGit(repo, ['add', '.drovr'])
      runGit(repo, ['commit', '-m', 'add concurrent interleaved stderr test'])

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).toBe(0)
      const lines = proc.stderr
        .trim()
        .split('\n')
        .filter((l) => !l.startsWith('Warning:'))
      expect(lines).toContain('[item-a setup 1/1] a-err-partial')
      expect(lines).toContain('[item-b setup 1/1] b-err-full-line')
      expect(lines).toContain('[item-a setup 1/1] -err-continuation')

      // Every line in setup stderr must start with a recognized prefix
      for (const line of lines) {
        expect(line).toMatch(/^\[(?:item-a|item-b) setup 1\/1\] /)
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(syncDir, { recursive: true, force: true })
    }
  })
  it('preserves self-identifying setup framing when direct stdout writes interleave between partial setup and continuation', async () => {
    const repo = await initRepo()
    const syncDir = await mkdtemp(join(tmpdir(), 'drovr-direct-stdout-'))

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          `printf "setup-stdout-partial\n" && touch "${syncDir}/partial_emitted" && while [ ! -f "${syncDir}/direct_written" ]; do sleep 0.05; done && echo "setup-stdout-continuation"`,
        ]),
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wtPromise = drovr.worktree({ name: 'direct-stdout-item' })
  while (!existsSync("${syncDir}/partial_emitted")) {
    await new Promise((r) => setTimeout(r, 20))
  }
  process.stdout.write("Direct stdout message\\n")
  await writeFile("${syncDir}/direct_written", "1", "utf8")
  await wtPromise
}
`,
        'utf8',
      )
      runGit(repo, ['add', '.drovr'])
      runGit(repo, ['commit', '-m', 'add direct stdout interleave test'])

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).toBe(0)
      const lines = proc.stdout.trim().split('\n')
      expect(lines).toContain('[direct-stdout-item setup 1/1] setup-stdout-partial')
      expect(lines).toContain('Direct stdout message')
      expect(lines).toContain('[direct-stdout-item setup 1/1] setup-stdout-continuation')
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(syncDir, { recursive: true, force: true })
    }
  })

  it('preserves self-identifying setup framing when direct stderr warning writes interleave between partial setup and continuation', async () => {
    const repo = await initRepo()
    const syncDir = await mkdtemp(join(tmpdir(), 'drovr-direct-stderr-'))

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          `printf "setup-stderr-partial\n" >&2 && touch "${syncDir}/err_partial_emitted" && while [ ! -f "${syncDir}/direct_err_written" ]; do sleep 0.05; done && echo "setup-stderr-continuation" >&2`,
        ]),
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wtPromise = drovr.worktree({ name: 'direct-stderr-item' })
  while (!existsSync("${syncDir}/err_partial_emitted")) {
    await new Promise((r) => setTimeout(r, 20))
  }
  process.stderr.write("Warning: direct diagnostic warning\\n")
  await writeFile("${syncDir}/direct_err_written", "1", "utf8")
  await wtPromise
}
`,
        'utf8',
      )
      runGit(repo, ['add', '.drovr'])
      runGit(repo, ['commit', '-m', 'add direct stderr interleave test'])

      const proc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })

      expect(proc.status).toBe(0)
      const lines = proc.stderr.trim().split('\n')
      expect(lines).toContain('[direct-stderr-item setup 1/1] setup-stderr-partial')
      expect(lines).toContain('Warning: direct diagnostic warning')
      expect(lines).toContain('[direct-stderr-item setup 1/1] setup-stderr-continuation')
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(syncDir, { recursive: true, force: true })
    }
  })
})

describe('Issue #29: Worktree setup replays conservatively after interruption', () => {
  it('commits pending readiness before physical creation and performs no git mutation when persistence fails', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Run starter workflow once to initialize supported Project database via CLI
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {}
`,
        'utf8',
      )
      const initProc = spawnSync('node', [drovr, 'start'], { cwd: repo, encoding: 'utf8' })
      expect(initProc.status).toBe(0)

      // Update workflow to create worktree
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'blocked-creation-item' })
}
`,
        'utf8',
      )

      // Hold exclusive lock on project database
      const lock = await lockDatabase(join(repo, '.drovr', 'state.sqlite'))
      try {
        const failProc = spawnSync('node', [drovr, 'start'], {
          cwd: repo,
          encoding: 'utf8',
        })
        expect(failProc.status).not.toBe(0)
        expect(failProc.stderr).toContain('database is locked')

        // Assert no physical worktree directory was created
        const worktreePath = join(repo, '.worktrees', 'blocked-creation-item')
        expect(existsSync(worktreePath)).toBe(false)

        // Assert no git branch was created
        const branches = runGit(repo, ['branch', '--list', 'drovr/blocked-creation-item'])
        expect(branches.trim()).toBe('')

        // Assert .git/info/exclude is untouched and does not contain worktree exclusion
        const excludePath = join(repo, '.git', 'info', 'exclude')
        const excludeContent = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : ''
        expect(excludeContent).not.toContain('/.worktrees/')
      } finally {
        await lock.release()
      }

      // After release, creation succeeds
      const successProc = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(successProc.status).toBe(0)
      const worktreePath = join(repo, '.worktrees', 'blocked-creation-item')
      expect(existsSync(worktreePath)).toBe(true)
      const branches = runGit(repo, ['branch', '--list', 'drovr/blocked-creation-item'])
      expect(branches.trim()).toContain('drovr/blocked-creation-item')
      const excludeContentAfter = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')
      expect(excludeContentAfter).toContain('/.worktrees/')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  }, 20000)

  it('skips setup on matching reconnect with completed readiness without rereading configuration', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify(['echo pass-1-ran > setup.log']),
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'reconnect-item' })
  const passFile = join(${JSON.stringify(repo)}, 'pass.txt')
  const pass = existsSync(passFile) ? (await readFile(passFile, 'utf8')).trim() : '1'
  if (pass === '1') {
    await writeFile(join(wt.path, 'marker.txt'), 'from-pass-1\\n', 'utf8')
    throw new Error('deliberate-crash-after-worktree-pass-1')
  }
  await writeFile(join(${JSON.stringify(repo)}, 'pass-2-success.txt'), 'ok\\n', 'utf8')
}
`,
        'utf8',
      )
      runGit(repo, ['add', '.drovr'])
      runGit(repo, ['commit', '-m', 'add workflow'])

      // Pass 1: creates worktree, completes setup, writes setup.log, then crashes
      const proc1 = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc1.status).not.toBe(0)
      expect(proc1.stderr).toContain('deliberate-crash-after-worktree-pass-1')

      const worktreePath = join(repo, '.worktrees', 'reconnect-item')
      expect(existsSync(worktreePath)).toBe(true)
      const setupLog1 = await readFile(join(worktreePath, 'setup.log'), 'utf8')
      expect(setupLog1.trim()).toBe('pass-1-ran')

      // Corrupt configuration inside worktree: invalid JSON syntax
      await writeFile(
        join(worktreePath, '.drovr', 'worktrees.json'),
        'INVALID JSON SYNTAX {][}',
        'utf8',
      )

      // Set pass 2
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')

      // Pass 2: resume should succeed and skip reading .drovr/worktrees.json
      const proc2 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc2.status).toBe(0)
      expect(existsSync(join(repo, 'pass-2-success.txt'))).toBe(true)

      // Verify setup.log was NOT overwritten or modified
      const setupLog2 = await readFile(join(worktreePath, 'setup.log'), 'utf8')
      expect(setupLog2.trim()).toBe('pass-1-ran')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rereads current configuration and reruns complete command array from command one on pending readiness', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          'echo cmd-1-pass-1 >> execution.log',
          'echo cmd-2-fail >> execution.log && exit 1',
        ]),
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'pending-rerun-item' })
  await writeFile(join(${JSON.stringify(repo)}, 'workflow-success.txt'), 'ok\\n', 'utf8')
}
`,
        'utf8',
      )
      runGit(repo, ['add', '.drovr'])
      runGit(repo, ['commit', '-m', 'add setup with failure'])

      // Pass 1: fails during setup command 2
      const proc1 = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc1.status).not.toBe(0)
      expect(proc1.stderr).toContain('command 2 of 2')
      expect(proc1.stderr).toContain('process exited with code 1')

      const worktreePath = join(repo, '.worktrees', 'pending-rerun-item')
      expect(existsSync(worktreePath)).toBe(true)
      const logPass1 = await readFile(join(worktreePath, 'execution.log'), 'utf8')
      expect(logPass1).toBe('cmd-1-pass-1\ncmd-2-fail\n')

      // Update configuration in worktree to new command list
      await writeFile(
        join(worktreePath, '.drovr', 'worktrees.json'),
        JSON.stringify([
          'echo cmd-1-pass-2 >> execution.log',
          'echo cmd-2-pass-2 >> execution.log',
        ]),
        'utf8',
      )

      // Pass 2: resume reruns current configuration from command one
      const proc2 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc2.status).toBe(0)
      expect(existsSync(join(repo, 'workflow-success.txt'))).toBe(true)

      const logPass2 = await readFile(join(worktreePath, 'execution.log'), 'utf8')
      expect(logPass2).toBe('cmd-1-pass-1\ncmd-2-fail\ncmd-1-pass-2\ncmd-2-pass-2\n')

      // Pass 3: with readiness complete, corrupting worktrees.json does not affect resume
      await writeFile(join(worktreePath, '.drovr', 'worktrees.json'), 'INVALID JSON {][}', 'utf8')
      const proc3 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc3.status).toBe(0)
      const logPass3 = await readFile(join(worktreePath, 'execution.log'), 'utf8')
      expect(logPass3).toBe('cmd-1-pass-1\ncmd-2-fail\ncmd-1-pass-2\ncmd-2-pass-2\n')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rereads current configuration and runs setup when matching branch and worktree exist without database readiness', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Run starter workflow once to initialize supported Project database via CLI
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
export default async function workflow(drovr: Drovr): Promise<void> {}
`,
        'utf8',
      )
      const initProc = spawnSync('node', [drovr, 'start'], { cwd: repo, encoding: 'utf8' })
      expect(initProc.status).toBe(0)

      // Create matching branch and worktree out-of-band (so database has missing readiness for it)
      const worktreePath = join(repo, '.worktrees', 'oob-missing-item')
      runGit(repo, ['worktree', 'add', '-b', 'drovr/oob-missing-item', worktreePath, 'HEAD'])

      // Add setup configuration in the worktree
      await mkdir(join(worktreePath, '.drovr'), { recursive: true })
      await writeFile(
        join(worktreePath, '.drovr', 'worktrees.json'),
        JSON.stringify(['echo replayed-for-missing > missing.log']),
        'utf8',
      )

      // Update workflow in Start checkout to reference the worktree
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'oob-missing-item' })
  await writeFile(join(${JSON.stringify(repo)}, 'workflow-success.txt'), 'ok\\n', 'utf8')
}
`,
        'utf8',
      )

      // Pass 2: resume connects to out-of-band worktree, detects missing readiness, and executes setup
      const proc2 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc2.status).toBe(0)
      expect(existsSync(join(repo, 'workflow-success.txt'))).toBe(true)
      expect(await readFile(join(worktreePath, 'missing.log'), 'utf8')).toBe(
        'replayed-for-missing\n',
      )

      // Pass 3: now marked complete, skipping setup even if config is corrupted
      await writeFile(join(worktreePath, '.drovr', 'worktrees.json'), 'INVALID JSON {][}', 'utf8')
      const proc3 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc3.status).toBe(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('leaves readiness pending when Drovr process is interrupted mid-setup so resume replays full array from command one', async () => {
    const repo = await initRepo()
    const syncDir = await mkdtemp(join(tmpdir(), 'drovr-interrupt-sync-'))

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          `echo started-pass-1 >> setup.log && touch "${syncDir}/mid_setup" && sleep 10`,
          'echo pass-1-cmd2 >> setup.log',
        ]),
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'interrupted-item' })
  await writeFile(join(${JSON.stringify(repo)}, 'workflow-success.txt'), 'ok\\n', 'utf8')
}
`,
        'utf8',
      )
      runGit(repo, ['add', '.drovr'])
      runGit(repo, ['commit', '-m', 'add setup with mid-step delay'])

      // Spawn Drovr asynchronously in its own process group
      const child = spawn('node', [drovr, 'start'], {
        cwd: repo,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      try {
        // Wait until mid-setup marker file is touched
        await waitForReadiness(() => existsSync(join(syncDir, 'mid_setup')), {
          child,
          timeoutMs: 5000,
          description: 'mid-setup marker file',
        })

        // Terminate the Drovr process group itself while setup is in flight
        await terminateProcess(child)
      } finally {
        await terminateProcess(child)
      }
      const worktreePath = join(repo, '.worktrees', 'interrupted-item')
      expect(existsSync(worktreePath)).toBe(true)
      expect(await readFile(join(worktreePath, 'setup.log'), 'utf8')).toBe('started-pass-1\n')

      // Update configuration in worktree to new command list
      await writeFile(
        join(worktreePath, '.drovr', 'worktrees.json'),
        JSON.stringify(['echo rerun-cmd1 >> setup.log', 'echo rerun-cmd2 >> setup.log']),
        'utf8',
      )

      // Pass 2: resume reruns setup from command one with current configuration
      const proc2 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc2.status).toBe(0)
      expect(existsSync(join(repo, 'workflow-success.txt'))).toBe(true)
      expect(await readFile(join(worktreePath, 'setup.log'), 'utf8')).toBe(
        'started-pass-1\nrerun-cmd1\nrerun-cmd2\n',
      )

      // Pass 3: now marked complete, skipping setup
      await writeFile(join(worktreePath, '.drovr', 'worktrees.json'), 'INVALID JSON {][}', 'utf8')
      const proc3 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc3.status).toBe(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(syncDir, { recursive: true, force: true })
    }
  }, 20000)

  it('leaves readiness pending when database completion write fails so resume replays full array from command one', async () => {
    const repo = await initRepo()
    const syncDir = await mkdtemp(join(tmpdir(), 'drovr-dbfail-sync-'))

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify([
          'echo pass1-cmd1 >> execution.log',
          `touch "${syncDir}/commands_succeeded" && while [ ! -f "${syncDir}/proceed" ]; do sleep 0.02; done`,
        ]),
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'db-fail-item' })
  await writeFile(join(${JSON.stringify(repo)}, 'workflow-success.txt'), 'ok\\n', 'utf8')
}
`,
        'utf8',
      )
      runGit(repo, ['add', '.drovr'])
      runGit(repo, ['commit', '-m', 'add setup with sync barrier'])

      // Spawn Drovr asynchronously in its own process group
      const child = spawn('node', [drovr, 'start'], {
        cwd: repo,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      try {
        // Wait until setup commands have completed
        await waitForReadiness(() => existsSync(join(syncDir, 'commands_succeeded')), {
          child,
          timeoutMs: 5000,
          description: 'commands succeeded marker file',
        })

        // Hold exclusive lock on project database so the completion write fails
        const lock = await lockDatabase(join(repo, '.drovr', 'state.sqlite'))
        try {
          // Allow setup command 2 to exit so runWorktreeSetup returns to drovr.worktree()
          await writeFile(join(syncDir, 'proceed'), '1', 'utf8')

          // Wait for Drovr process to fail on the locked database completion write
          let stderr = ''
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString()
          })
          await waitForReadiness(() => child.exitCode !== null || child.signalCode !== null, {
            timeoutMs: 15000,
            description: 'Drovr exit on locked database write failure',
          })
          expect(child.exitCode).not.toBe(0)
          expect(stderr).toContain('database is locked')
        } finally {
          await lock.release()
        }
      } finally {
        await terminateProcess(child)
      }

      const worktreePath = join(repo, '.worktrees', 'db-fail-item')
      expect(existsSync(worktreePath)).toBe(true)
      // Update configuration in worktree
      await writeFile(
        join(worktreePath, '.drovr', 'worktrees.json'),
        JSON.stringify(['echo pass2-cmd1 >> execution.log', 'echo pass2-cmd2 >> execution.log']),
        'utf8',
      )

      // Pass 2: resume reruns setup from command one because completion write failed
      const proc2 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc2.status).toBe(0)
      expect(existsSync(join(repo, 'workflow-success.txt'))).toBe(true)
      expect(await readFile(join(worktreePath, 'execution.log'), 'utf8')).toBe(
        'pass1-cmd1\npass2-cmd1\npass2-cmd2\n',
      )

      // Pass 3: with readiness complete, corrupted worktrees.json is ignored
      await writeFile(join(worktreePath, '.drovr', 'worktrees.json'), 'INVALID JSON {][}', 'utf8')
      const proc3 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc3.status).toBe(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(syncDir, { recursive: true, force: true })
    }
  }, 20000)

  it('resets readiness before recreation during resume repair and reruns setup', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr', 'worktrees.json'),
        JSON.stringify(['echo setup-for-repair >> repair.log']),
      )
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from "drovr"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export default async function workflow(drovr: Drovr): Promise<void> {
  const wt = await drovr.worktree({ name: 'repair-item' })
  await writeFile(join(${JSON.stringify(repo)}, 'repair-success.txt'), 'ok\\n', 'utf8')
}
`,
        'utf8',
      )
      runGit(repo, ['add', '.drovr'])
      runGit(repo, ['commit', '-m', 'add workflow for repair'])

      // Pass 1: creates worktree and runs setup successfully
      const proc1 = spawnSync('node', [drovr, 'start'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc1.status).toBe(0)
      const worktreePath = join(repo, '.worktrees', 'repair-item')
      expect(existsSync(worktreePath)).toBe(true)
      expect(await readFile(join(worktreePath, 'repair.log'), 'utf8')).toBe('setup-for-repair\n')

      // Delete the physical worktree directory (simulating loss)
      await rm(worktreePath, { recursive: true, force: true })
      expect(existsSync(worktreePath)).toBe(false)

      // Hold lock on database to prove pending reset must succeed before recreation
      const lock = await lockDatabase(join(repo, '.drovr', 'state.sqlite'))
      try {
        const failProc = spawnSync('node', [drovr, 'start', '--resume'], {
          cwd: repo,
          encoding: 'utf8',
        })
        expect(failProc.status).not.toBe(0)
        expect(failProc.stderr).toContain('database is locked')

        // Assert worktree was NOT recreated on filesystem before pending write succeeded
        expect(existsSync(worktreePath)).toBe(false)
      } finally {
        await lock.release()
      }

      // Pass 2: resume repairs worktree and reruns setup
      const proc2 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc2.status).toBe(0)
      expect(existsSync(worktreePath)).toBe(true)
      expect(await readFile(join(worktreePath, 'repair.log'), 'utf8')).toBe('setup-for-repair\n')

      // Pass 3: now marked complete, skipping setup
      await writeFile(join(worktreePath, '.drovr', 'worktrees.json'), 'INVALID JSON {][}', 'utf8')
      const proc3 = spawnSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        encoding: 'utf8',
      })
      expect(proc3.status).toBe(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  }, 20000)
})
