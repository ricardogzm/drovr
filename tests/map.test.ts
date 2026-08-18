import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const dir = await mkdtemp(join(tmpdir(), 'drovr-map-'))
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

describe('Drovr.map pre-callback validation', () => {
  it('synchronously rejects invalid Names before invoking any callback', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Workflow attempts to map over items with an invalid Name in the second position
      // It also touches a file in the callback to prove no callback was ever invoked
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'
export default async function workflow(drovr: Drovr) {
  const items = [
    { id: 'valid-first' },
    { id: 'INVALID-NAME' },
    { id: 'valid-third' },
  ]
  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    await writeFile('callback-ran.txt', item.id)
  })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/invalid Name/i)

      // Ensure no callback was invoked
      await expect(readFile(join(repo, 'callback-ran.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('synchronously rejects duplicate Names before invoking any callback', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'
export default async function workflow(drovr: Drovr) {
  const items = [
    { id: 'duplicate-item' },
    { id: 'duplicate-item' },
  ]
  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    await writeFile('callback-ran.txt', item.id)
  })
}
`,
        'utf8',
      )
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/duplicate Name/i)

      // Ensure no callback was invoked
      await expect(readFile(join(repo, 'callback-ran.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('synchronously rejects non-positive or non-integer concurrency before invoking any callback', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'
export default async function workflow(drovr: Drovr) {
  const items = [{ id: 'valid-item' }]
  await drovr.map(items, { concurrency: 0, name: (x) => x.id }, async (item) => {
    await writeFile('callback-ran.txt', item.id)
  })
}
`,
        'utf8',
      )
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/concurrency/i)

      // Ensure no callback was invoked
      await expect(readFile(join(repo, 'callback-ran.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.map bounded concurrency', () => {
  it('runs two callbacks at once and never exceeds the concurrency limit of two', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default async function workflow(drovr: Drovr) {
  const items = [
    { id: 'item-1' },
    { id: 'item-2' },
    { id: 'item-3' },
    { id: 'item-4' },
  ]

  let active = 0
  let maxActive = 0
  const overlapObserved = { 'item-1-with-item-2': false, 'item-3-with-item-4': false }

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    active++
    if (active > maxActive) {
      maxActive = active
    }

    // If item-1 and item-2 are running together, record overlap
    if (item.id === 'item-1' || item.id === 'item-2') {
      if (active === 2) {
        overlapObserved['item-1-with-item-2'] = true
      }
    }

    // Hold the slot briefly so the companion item starts concurrently
    await new Promise((resolve) => setTimeout(resolve, 60))

    if (active > maxActive) {
      maxActive = active
    }

    active--
    await writeFile(\`\${item.id}.done\`, 'done')
  })

  await writeFile('metrics.json', JSON.stringify({ maxActive, overlapObserved }))
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      const metricsRaw = await readFile(join(repo, 'metrics.json'), 'utf8')
      const metrics = JSON.parse(metricsRaw) as {
        maxActive: number
        overlapObserved: { 'item-1-with-item-2': boolean }
      }

      expect(metrics.maxActive).toBe(2)
      expect(metrics.overlapObserved['item-1-with-item-2']).toBe(true)

      expect(await readFile(join(repo, 'item-1.done'), 'utf8')).toBe('done')
      expect(await readFile(join(repo, 'item-2.done'), 'utf8')).toBe('done')
      expect(await readFile(join(repo, 'item-3.done'), 'utf8')).toBe('done')
      expect(await readFile(join(repo, 'item-4.done'), 'utf8')).toBe('done')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.map failure isolation and deferred command failure', () => {
  it('does not cancel other active or pending items when one item throws, failing only after all settle', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const items = [
    { id: 'item-1-slow' },
    { id: 'item-2-fails' },
    { id: 'item-3-pending' },
  ]

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    if (item.id === 'item-1-slow') {
      // Active companion item: takes longer than item-2-fails
      await new Promise((resolve) => setTimeout(resolve, 80))
      await writeFile('item-1.done', 'ok')
      return
    }

    if (item.id === 'item-2-fails') {
      // Fails quickly
      await new Promise((resolve) => setTimeout(resolve, 20))
      await writeFile('item-2-threw.marker', 'threw')
      throw new Error('item 2 failed intentionally')
    }

    if (item.id === 'item-3-pending') {
      // Pending item: launched after item-2 fails
      await new Promise((resolve) => setTimeout(resolve, 20))
      await writeFile('item-3.done', 'ok')
      return
    }
  })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/item 2 failed intentionally/i)

      // Active companion item completed
      expect(await readFile(join(repo, 'item-1.done'), 'utf8')).toBe('ok')
      // Failing item ran and threw
      expect(await readFile(join(repo, 'item-2-threw.marker'), 'utf8')).toBe('threw')
      // Pending item was NOT cancelled and ran to completion
      expect(await readFile(join(repo, 'item-3.done'), 'utf8')).toBe('ok')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.map durable Completion and resume skipping', () => {
  it('records Completion on return immediately and skips completed items on resume while replaying incomplete items', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export default async function workflow(drovr: Drovr) {
  const items = [
    { id: 'item-a' },
    { id: 'item-b' },
    { id: 'item-c' },
  ]

  // Check if we are in pass 1 or pass 2 via a control file
  let pass = 1
  try {
    const passContent = await readFile('pass.txt', 'utf8')
    pass = Number(passContent)
  } catch {}

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    await appendFile(\`\${item.id}-executions.log\`, \`pass-\${pass}\\n\`)

    if (item.id === 'item-b' && pass === 1) {
      throw new Error('item-b fails on pass 1')
    }
  })
}
`,
        'utf8',
      )

      // Pass 1: item-a succeeds, item-b throws, item-c succeeds
      await writeFile(join(repo, 'pass.txt'), '1', 'utf8')

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/item-b fails on pass 1/i)

      // In pass 1, all three executed once
      expect(await readFile(join(repo, 'item-a-executions.log'), 'utf8')).toBe('pass-1\n')
      expect(await readFile(join(repo, 'item-b-executions.log'), 'utf8')).toBe('pass-1\n')
      expect(await readFile(join(repo, 'item-c-executions.log'), 'utf8')).toBe('pass-1\n')

      // Pass 2: resume
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')

      const pass2Result = execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })
      expect(pass2Result).toBe('')

      // In pass 2: item-a and item-c were skipped because they completed in pass 1!
      expect(await readFile(join(repo, 'item-a-executions.log'), 'utf8')).toBe('pass-1\n')
      expect(await readFile(join(repo, 'item-c-executions.log'), 'utf8')).toBe('pass-1\n')
      // item-b had no completion recorded, so it replayed and succeeded in pass 2
      expect(await readFile(join(repo, 'item-b-executions.log'), 'utf8')).toBe('pass-1\npass-2\n')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.map semantic logging and terminal counts', () => {
  it('emits stable start, complete, fail, and skip events with Name and error text, and accurate terminal start counts', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { readFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const items = [
    { id: 'item-first' },
    { id: 'item-second' },
  ]

  let pass = 1
  try {
    const passContent = await readFile('pass.txt', 'utf8')
    pass = Number(passContent)
  } catch {}

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    if (item.id === 'item-second' && pass === 1) {
      throw new Error('second item intentional failure')
    }
  })
}
`,
        'utf8',
      )

      // Pass 1: item-first succeeds, item-second fails
      await writeFile(join(repo, 'pass.txt'), '1', 'utf8')

      try {
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        })
      } catch {}

      const pass1Log = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')

      // Check pass 1 events
      expect(pass1Log).toMatch(/INFO\s+map\.item\.start\s+name=item-first/)
      expect(pass1Log).toMatch(/INFO\s+map\.item\.complete\s+name=item-first/)
      expect(pass1Log).toMatch(/INFO\s+map\.item\.start\s+name=item-second/)
      expect(pass1Log).toMatch(
        /ERROR\s+map\.item\.fail\s+name=item-second\s+error=.*second item intentional failure.*/,
      )
      // Terminal counts in start.fail: started=2, skipped=0, completed=1, failed=1
      expect(pass1Log).toMatch(
        /ERROR\s+start\.fail\s+mode=fresh\s+started=2\s+skipped=0\s+completed=1\s+failed=1\s+error=/,
      )

      // Pass 2: resume with item-second now succeeding
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')

      execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })

      const pass2Log = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      const pass2Lines = pass2Log.trim().split('\n')

      // Slice pass 2 lines (after start.begin mode=resume)
      const resumeIndex = pass2Lines.findIndex((l) => l.includes('start.begin mode=resume'))
      expect(resumeIndex).toBeGreaterThan(-1)
      const resumeSection = pass2Lines.slice(resumeIndex).join('\n')

      // item-first was skipped on resume
      expect(resumeSection).toMatch(/INFO\s+map\.item\.skip\s+name=item-first/)
      // item-second was re-run and completed
      expect(resumeSection).toMatch(/INFO\s+map\.item\.start\s+name=item-second/)
      expect(resumeSection).toMatch(/INFO\s+map\.item\.complete\s+name=item-second/)
      // Terminal counts in start.complete: started=1, skipped=1, completed=1, failed=0
      expect(resumeSection).toMatch(
        /INFO\s+start\.complete\s+mode=resume\s+started=1\s+skipped=1\s+completed=1\s+failed=0/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('handles empty items array and concurrency greater than item count', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  // Empty array
  await drovr.map([] as Array<{ id: string }>, { concurrency: 5, name: (x) => x.id }, async () => {
    await writeFile('empty-ran.txt', 'fail')
  })

  // Concurrency 10 with 2 items
  const items = [{ id: 'item-one' }, { id: 'item-two' }]
  await drovr.map(items, { concurrency: 10, name: (x) => x.id }, async (item) => {
    await writeFile(\`\${item.id}.txt\`, 'ok')
  })
}
`,
        'utf8',
      )

      const result = execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        stdio: 'pipe',
        encoding: 'utf8',
      })
      expect(result).toBe('')

      await expect(readFile(join(repo, 'empty-ran.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
      expect(await readFile(join(repo, 'item-one.txt'), 'utf8')).toBe('ok')
      expect(await readFile(join(repo, 'item-two.txt'), 'utf8')).toBe('ok')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('validates 32-character Name boundary rejecting 33-character Name', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      // 'a' + 31 'b's = 32 chars (valid)
      const valid32 = 'a' + 'b'.repeat(31)
      // 'a' + 32 'b's = 33 chars (invalid)
      const invalid33 = 'a' + 'b'.repeat(32)

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const items = [
    { id: '${valid32}' },
    { id: '${invalid33}' },
  ]

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    await writeFile('boundary-ran.txt', item.id)
  })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/invalid Name/i)

      await expect(readFile(join(repo, 'boundary-ran.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('reports multiple item failures and logs each map.item.fail safely', async () => {
    const repo = await initRepo()

    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const circular: Record<string, unknown> = { key: 'val' }
  circular.self = circular

  const items = [
    { id: 'item-err-1', throwVal: 'string error' },
    { id: 'item-err-2', throwVal: 42 },
    { id: 'item-err-3', throwVal: circular },
  ]

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    await writeFile(\`\${item.id}.ran\`, 'ran')
    throw item.throwVal
  })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      ).toThrow(/3 map items failed/i)

      // All 3 items ran
      expect(await readFile(join(repo, 'item-err-1.ran'), 'utf8')).toBe('ran')
      expect(await readFile(join(repo, 'item-err-2.ran'), 'utf8')).toBe('ran')
      expect(await readFile(join(repo, 'item-err-3.ran'), 'utf8')).toBe('ran')

      const logContent = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      expect(logContent).toMatch(/ERROR\s+map\.item\.fail\s+name=item-err-1\s+error="string error"/)
      expect(logContent).toMatch(/ERROR\s+map\.item\.fail\s+name=item-err-2\s+error="42"/)
      expect(logContent).toMatch(/ERROR\s+map\.item\.fail\s+name=item-err-3\s+error=/)
      expect(logContent).toMatch(
        /ERROR\s+start\.fail\s+mode=fresh\s+started=3\s+skipped=0\s+completed=0\s+failed=3\s+error=/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
