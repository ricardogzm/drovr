import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const drovr = join(root, 'dist/cli.mjs')

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drovr-resume-'))
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
      await readFile(path, 'utf8')
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`timed out waiting for file: ${path}`)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('Issue #23: Resume preconditions and Workflow load sentinels', () => {
  it('fails start --resume before loading Workflow when Project database is absent', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Workflow writes a sentinel on module evaluation (when imported)
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

writeFileSync('loaded-sentinel.txt', 'loaded\\n')

export default async function workflow() {}
`,
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

      // The Workflow file must NEVER have been loaded/imported!
      expect(await fileExists(join(repo, 'loaded-sentinel.txt'))).toBe(false)

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

  it('fails start --resume before loading Workflow when database has unsupported user_version = 2', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      const db = new DatabaseSync(join(repo, '.drovr/state.sqlite'))
      db.exec('PRAGMA user_version = 2;')
      db.close()

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFileSync } from 'node:fs'

writeFileSync('loaded-sentinel.txt', 'loaded\\n')

export default async function workflow() {}
`,
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

      expect(stderrOutput).toMatch(/unsupported database version: 2/i)
      expect(await fileExists(join(repo, 'loaded-sentinel.txt'))).toBe(false)

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const lines = logContent.trim().split('\n')
      expect(lines[0]).toMatch(/INFO\s+start\.begin\s+mode=resume/)
      expect(lines[1]).toMatch(
        /ERROR\s+start\.fail\s+mode=resume\s+started=0\s+skipped=0\s+completed=0\s+failed=0.*unsupported database version: 2/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails start --resume before loading Workflow when database has uninitialized user_version = 0', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      const db = new DatabaseSync(join(repo, '.drovr/state.sqlite'))
      db.exec('PRAGMA user_version = 0;')
      db.close()

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFileSync } from 'node:fs'

writeFileSync('loaded-sentinel.txt', 'loaded\\n')

export default async function workflow() {}
`,
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

      expect(stderrOutput).toMatch(/unsupported database version: 0/i)
      expect(await fileExists(join(repo, 'loaded-sentinel.txt'))).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails fresh start before loading Workflow when database has unsupported user_version = 2', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      const db = new DatabaseSync(join(repo, '.drovr/state.sqlite'))
      db.exec('PRAGMA user_version = 2;')
      db.close()

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFileSync } from 'node:fs'

writeFileSync('loaded-sentinel.txt', 'loaded\\n')

export default async function workflow() {}
`,
        'utf8',
      )

      let stderrOutput = ''
      try {
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        })
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string }
        stderrOutput = e.stderr || e.message || ''
      }

      expect(stderrOutput).toMatch(/unsupported database version: 2/i)
      expect(await fileExists(join(repo, 'loaded-sentinel.txt'))).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Issue #23: Completion skipping before map concurrency', () => {
  it('skips completed Names before scheduling and does not consume concurrency capacity', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { appendFile, readFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  let pass = 1
  try {
    pass = Number(await readFile('pass.txt', 'utf8'))
  } catch {}

  const items = [
    { id: 'item-one' },
    { id: 'item-two' },
  ]

  await drovr.map(items, { concurrency: 1, name: (x) => x.id }, async (item) => {
    await appendFile(\`\${item.id}-invocations.log\`, \`pass-\${pass}\\n\`)
    if (item.id === 'item-two' && pass === 1) {
      throw new Error('item-two fails in pass 1')
    }
  })
}
`,
        'utf8',
      )

      // Pass 1: item-one completes, item-two throws
      await writeFile(join(repo, 'pass.txt'), '1', 'utf8')
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/item-two fails in pass 1/i)

      expect(await readFile(join(repo, 'item-one-invocations.log'), 'utf8')).toBe('pass-1\n')
      expect(await readFile(join(repo, 'item-two-invocations.log'), 'utf8')).toBe('pass-1\n')

      // Pass 2: resume with concurrency 1
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')
      execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      // item-one callback was NEVER invoked in pass 2
      expect(await readFile(join(repo, 'item-one-invocations.log'), 'utf8')).toBe('pass-1\n')
      // item-two was re-invoked in pass 2 and completed
      expect(await readFile(join(repo, 'item-two-invocations.log'), 'utf8')).toBe(
        'pass-1\npass-2\n',
      )

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const resumeLines = logContent
        .trim()
        .split('\n')
        .filter((l) => l.includes('mode=resume') || l.includes('name=item-'))

      expect(
        resumeLines.some((l) => l.includes('map.item.skip') && l.includes('name=item-one')),
      ).toBe(true)
      expect(
        resumeLines.some((l) => l.includes('map.item.start') && l.includes('name=item-two')),
      ).toBe(true)
      expect(
        resumeLines.some((l) => l.includes('map.item.complete') && l.includes('name=item-two')),
      ).toBe(true)
      expect(
        resumeLines.some(
          (l) =>
            l.includes('start.complete mode=resume') &&
            l.includes('started=1') &&
            l.includes('skipped=1') &&
            l.includes('completed=1') &&
            l.includes('failed=0'),
        ),
      ).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('runs remaining incomplete items at full declared concurrency immediately without delay from skipped items', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { appendFile, readFile, writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  let pass = 1
  try {
    pass = Number(await readFile('pass.txt', 'utf8'))
  } catch {}

  const items = [
    { id: 'item-1' },
    { id: 'item-2' },
    { id: 'item-3' },
    { id: 'item-4' },
  ]

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    if (pass === 1) {
      if (item.id === 'item-1' || item.id === 'item-2') {
        await appendFile('completed-pass-1.log', \`\${item.id}\\n\`)
        return
      }
      throw new Error(\`\${item.id} fail pass 1\`)
    }

    // Pass 2: items 3 and 4 should run concurrently
    const startTimestamp = Date.now()
    await appendFile('concurrency.log', \`start:\${item.id}:\${startTimestamp}\\n\`)
    // brief delay to ensure concurrent overlap
    await new Promise((r) => setTimeout(r, 60))
    const endTimestamp = Date.now()
    await appendFile('concurrency.log', \`end:\${item.id}:\${endTimestamp}\\n\`)
  })
}
`,
        'utf8',
      )

      // Pass 1
      await writeFile(join(repo, 'pass.txt'), '1', 'utf8')
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/2 map items failed: item-3, item-4/i)

      expect(await readFile(join(repo, 'completed-pass-1.log'), 'utf8')).toBe('item-1\nitem-2\n')

      // Pass 2: resume with concurrency 2
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')
      execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      const concurrencyLines = (await readFile(join(repo, 'concurrency.log'), 'utf8'))
        .trim()
        .split('\n')

      // Both item-3 and item-4 started
      const starts = concurrencyLines.filter((l) => l.startsWith('start:'))
      expect(starts).toHaveLength(2)
      const start3 = Number(starts.find((s) => s.includes('item-3'))!.split(':')[2])
      const start4 = Number(starts.find((s) => s.includes('item-4'))!.split(':')[2])
      const ends = concurrencyLines.filter((l) => l.startsWith('end:'))
      const end3 = Number(ends.find((e) => e.includes('item-3'))!.split(':')[2])
      const end4 = Number(ends.find((e) => e.includes('item-4'))!.split(':')[2])

      // They overlapped: item-3 started before item-4 ended, and item-4 started before item-3 ended
      expect(start3).toBeLessThan(end4)
      expect(start4).toBeLessThan(end3)

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      expect(logContent).toMatch(
        /INFO\s+start\.complete\s+mode=resume\s+started=2\s+skipped=2\s+completed=2\s+failed=0/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Issue #23: Replaying thrown and interrupted callbacks with at-least-once effects', () => {
  it('replays thrown callbacks from beginning repeating prior side effects', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { appendFile, readFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  let pass = 1
  try {
    pass = Number(await readFile('pass.txt', 'utf8'))
  } catch {}

  await drovr.map([{ id: 'worker-task' }], { concurrency: 1, name: (x) => x.id }, async (item) => {
    await appendFile('side-effects.log', 'stage-1-effect\\n')

    if (pass === 1) {
      throw new Error('crash at stage 2 in pass 1')
    }

    await appendFile('side-effects.log', 'stage-2-effect\\n')
  })
}
`,
        'utf8',
      )

      await writeFile(join(repo, 'pass.txt'), '1', 'utf8')
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/crash at stage 2 in pass 1/i)

      expect(await readFile(join(repo, 'side-effects.log'), 'utf8')).toBe('stage-1-effect\n')

      // Pass 2: resume
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')
      execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      // Callback replayed from beginning: stage-1-effect was executed a second time (at-least-once semantics)
      expect(await readFile(join(repo, 'side-effects.log'), 'utf8')).toBe(
        'stage-1-effect\nstage-1-effect\nstage-2-effect\n',
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('replays interrupted (SIGKILL) callbacks from beginning and verifies via second CLI invocation without DB inspection', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { appendFile, readFile, writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  let pass = 1
  try {
    pass = Number(await readFile('pass.txt', 'utf8'))
  } catch {}

  await drovr.map([{ id: 'interrupted-item' }], { concurrency: 1, name: (x) => x.id }, async (item) => {
    await appendFile('interrupt-effects.log', 'initial-side-effect\\n')

    if (pass === 1) {
      await writeFile('in-flight.txt', 'ready\\n')
      // Keep active timer so Node does not treat top-level await as unsettled
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    await appendFile('interrupt-effects.log', 'final-side-effect\\n')
  })
}
`,
        'utf8',
      )

      await writeFile(join(repo, 'pass.txt'), '1', 'utf8')

      // Spawn fresh start child process
      const child = spawn('node', [drovr, 'start'], {
        cwd: repo,
        stdio: 'pipe',
      })
      const exitPromise = once(child, 'exit')

      await waitForFile(join(repo, 'in-flight.txt'))
      expect(await readFile(join(repo, 'interrupt-effects.log'), 'utf8')).toBe(
        'initial-side-effect\n',
      )

      // Kill the in-flight process with SIGKILL (simulating hard crash/interruption)
      child.kill('SIGKILL')
      await exitPromise

      // In Pass 2: run drovr start --resume
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')
      const pass2Output = execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })
      expect(pass2Output).toBe('')

      // Proves at-least-once: initial-side-effect repeated, then final-side-effect ran
      expect(await readFile(join(repo, 'interrupt-effects.log'), 'utf8')).toBe(
        'initial-side-effect\ninitial-side-effect\nfinal-side-effect\n',
      )

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const resumeLines = logContent.split('\n').filter((l) => l.includes('mode=resume'))
      expect(resumeLines[0]).toMatch(/INFO\s+start\.begin\s+mode=resume/)
      expect(resumeLines[resumeLines.length - 1]).toMatch(
        /INFO\s+start\.complete\s+mode=resume\s+started=1\s+skipped=0\s+completed=1\s+failed=0/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Issue #23: Changed inputs, new Names, modified item data, and omitted Names', () => {
  it('executes new Names, skips completed Names despite modified item data, and preserves omitted Names without sweeping', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { appendFile, readFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const inputJson = await readFile('inputs.json', 'utf8')
  const items = JSON.parse(inputJson) as Array<{ id: string; data: string }>

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    await appendFile('runs.log', \`\${item.id}:\${item.data}\\n\`)
    if (item.data.includes('FAIL')) {
      throw new Error(\`item \${item.id} failed\`)
    }
  })
}
`,
        'utf8',
      )

      // Pass 1: item-1 succeeds, item-2 fails
      await writeFile(
        join(repo, 'inputs.json'),
        JSON.stringify([
          { id: 'item-1', data: 'data-v1-ok' },
          { id: 'item-2', data: 'data-v1-FAIL' },
        ]),
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/item item-2 failed/i)

      expect(await readFile(join(repo, 'runs.log'), 'utf8')).toBe(
        'item-1:data-v1-ok\nitem-2:data-v1-FAIL\n',
      )

      // Pass 2: inputs change!
      // item-1 has changed data ('data-v2-MODIFIED')
      // item-2 has fixed data ('data-v2-ok')
      // item-3 is a brand new item ('data-v1-new')
      await writeFile(
        join(repo, 'inputs.json'),
        JSON.stringify([
          { id: 'item-1', data: 'data-v2-MODIFIED' },
          { id: 'item-2', data: 'data-v2-ok' },
          { id: 'item-3', data: 'data-v1-new' },
        ]),
        'utf8',
      )

      execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      // item-1 was completed in pass 1: its callback was SKIPPED despite data-v2-MODIFIED!
      // item-2 completed with data-v2-ok
      // item-3 executed with data-v1-new
      expect(await readFile(join(repo, 'runs.log'), 'utf8')).toBe(
        'item-1:data-v1-ok\nitem-2:data-v1-FAIL\nitem-2:data-v2-ok\nitem-3:data-v1-new\n',
      )

      // Pass 3: Omit item-1 and item-2, introduce item-4
      await writeFile(
        join(repo, 'inputs.json'),
        JSON.stringify([
          { id: 'item-3', data: 'data-v1-new' },
          { id: 'item-4', data: 'data-v1-four' },
        ]),
        'utf8',
      )

      execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      // item-3 skipped, item-4 executed
      expect(await readFile(join(repo, 'runs.log'), 'utf8')).toBe(
        'item-1:data-v1-ok\nitem-2:data-v1-FAIL\nitem-2:data-v2-ok\nitem-3:data-v1-new\nitem-4:data-v1-four\n',
      )

      // Pass 4: Provide all four items again.
      // If omitted items (item-1, item-2) were swept in pass 3, they would run again here.
      // But Drovr does NOT sweep omitted completions! So all 4 must skip!
      await writeFile(
        join(repo, 'inputs.json'),
        JSON.stringify([
          { id: 'item-1', data: 'data-v3' },
          { id: 'item-2', data: 'data-v3' },
          { id: 'item-3', data: 'data-v3' },
          { id: 'item-4', data: 'data-v3' },
        ]),
        'utf8',
      )

      execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      // No new lines were added to runs.log!
      expect(await readFile(join(repo, 'runs.log'), 'utf8')).toBe(
        'item-1:data-v1-ok\nitem-2:data-v1-FAIL\nitem-2:data-v2-ok\nitem-3:data-v1-new\nitem-4:data-v1-four\n',
      )

      // Check final log counts in pass 4: 0 started, 4 skipped, 0 completed, 0 failed
      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const lines = logContent.trim().split('\n')
      const lastComplete = lines.filter((l) => l.includes('start.complete mode=resume')).pop()
      expect(lastComplete).toMatch(/started=0\s+skipped=4\s+completed=0\s+failed=0/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Issue #23: Shared fresh and resume advisory-lock exclusion', () => {
  it('prevents start --resume when a fresh start is holding the checkout lock', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { readFile, writeFile } from 'node:fs/promises'

export default async function workflow() {
  await writeFile('holding-lock.txt', 'held\\n')
  for (let i = 0; i < 200; i++) {
    try {
      await readFile('release.txt', 'utf8')
      return
    } catch {
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}
`,
        'utf8',
      )

      // Start fresh process A
      const procA = spawn('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      await waitForFile(join(repo, 'holding-lock.txt'))

      // Try running drovr start --resume in process B
      let stderrB = ''
      try {
        execFileSync('node', [drovr, 'start', '--resume'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        })
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string }
        stderrB = e.stderr || e.message || ''
      }

      expect(stderrB).toMatch(/another drovr process is already running in this checkout/)

      // Release proc A
      await writeFile(join(repo, 'release.txt'), 'done\n', 'utf8')
      await once(procA, 'exit')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('prevents fresh start when a resume start is holding the checkout lock', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Run once so state.sqlite exists for resume
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function workflow() {}\n`,
        'utf8',
      )
      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      // Update workflow to hold lock
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { readFile, writeFile } from 'node:fs/promises'

export default async function workflow() {
  await writeFile('holding-lock.txt', 'held\\n')
  for (let i = 0; i < 200; i++) {
    try {
      await readFile('release.txt', 'utf8')
      return
    } catch {
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}
`,
        'utf8',
      )

      // Start resume process A
      const procA = spawn('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' })
      await waitForFile(join(repo, 'holding-lock.txt'))

      // Try running fresh drovr start in process B
      let stderrB = ''
      try {
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        })
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string }
        stderrB = e.stderr || e.message || ''
      }

      expect(stderrB).toMatch(/another drovr process is already running in this checkout/)

      // Release proc A
      await writeFile(join(repo, 'release.txt'), 'done\n', 'utf8')
      await once(procA, 'exit')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('prevents start --resume when another start --resume is holding the checkout lock', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function workflow() {}\n`,
        'utf8',
      )
      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { readFile, writeFile } from 'node:fs/promises'

export default async function workflow() {
  await writeFile('holding-lock.txt', 'held\\n')
  for (let i = 0; i < 200; i++) {
    try {
      await readFile('release.txt', 'utf8')
      return
    } catch {
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}
`,
        'utf8',
      )

      const procA = spawn('node', [drovr, 'start', '--resume'], { cwd: repo, stdio: 'pipe' })
      await waitForFile(join(repo, 'holding-lock.txt'))

      let stderrB = ''
      try {
        execFileSync('node', [drovr, 'start', '--resume'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        })
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string }
        stderrB = e.stderr || e.message || ''
      }

      expect(stderrB).toMatch(/another drovr process is already running in this checkout/)

      await writeFile(join(repo, 'release.txt'), 'done\n', 'utf8')
      await once(procA, 'exit')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
