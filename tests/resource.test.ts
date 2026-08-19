import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
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
  const dir = await mkdtemp(join(tmpdir(), 'drovr-resource-'))
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

describe('Drovr.resource validation', () => {
  it('rejects empty or non-string resource name', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
export default async function workflow(drovr: Drovr) {
  // @ts-expect-error test invalid empty name
  await drovr.resource('', { capacity: 1 })
}
`,
        'utf8',
      )
      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /non-empty string/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rejects invalid or non-positive capacity values', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
export default async function workflow(drovr: Drovr) {
  // @ts-expect-error test invalid capacity 0
  await drovr.resource('res', { capacity: 0 })
}
`,
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /positive integer/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rejects spec containing both capacity and ports', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
export default async function workflow(drovr: Drovr) {
  // @ts-expect-error test mixed spec
  await drovr.resource('res', { capacity: 1, ports: 3000 })
}
`,
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /cannot contain both capacity and ports/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('accepts a single declared port with implicit capacity one', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'
export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('res', { ports: 3000 })
  const value = await res.lease({ name: 'item' }, async () => 'port-lease-ok')
  await writeFile('result.txt', value, 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('port-lease-ok')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rejects malformed port declarations without repairing them', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'
export default async function workflow(drovr: Drovr) {
  const cases: readonly [string, unknown][] = [
    ['duplicate', { ports: [4300, 4300] }],
    ['noninteger', { ports: 4300.5 }],
    ['too-low', { ports: 0 }],
    ['too-high', { ports: 65536 }],
    ['empty', { ports: [] }],
    ['reversed', { ports: { from: 4301, to: 4300 } }],
    ['mixed', { capacity: 1, ports: 4300 }],
  ]
  const errors: string[] = []
  for (const [name, spec] of cases) {
    try {
      await drovr.resource(name, spec as never)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  await writeFile('errors.json', JSON.stringify(errors), 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      const errors = JSON.parse(await readFile(join(repo, 'errors.json'), 'utf8')) as string[]
      expect(errors).toHaveLength(7)
      expect(errors.join('\n')).toMatch(
        /duplicates|integers|nonempty|reversed|both capacity and ports/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('returns a frozen Resource handle', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('res', { capacity: 1 })
  const isFrozen = Object.isFrozen(res)
  await writeFile('frozen.txt', String(isFrozen), 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      expect(await readFile(join(repo, 'frozen.txt'), 'utf8')).toBe('true')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
  it('rejects invalid lease options or invalid Names', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('res', { capacity: 1 })
  // @ts-expect-error test invalid Name
  await res.lease({ name: 'INVALID_NAME' }, async () => {})
}
`,
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /Names must match/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rejects non-function lease callback', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('res', { capacity: 1 })
  // @ts-expect-error test non-function callback
  await res.lease({ name: 'item' }, 'not-a-function')
}
`,
        'utf8',
      )

      expect(() => execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })).toThrow(
        /lease callback must be a function/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.resource callback return value and release semantics', () => {
  it('returns the callback value from lease and releases occupancy after return', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('supabase', { capacity: 1 })
  const value = await res.lease({ name: 'item' }, async () => {
    return 'hello-from-lease'
  })
  await writeFile('result.txt', value, 'utf8')

  // Immediately lease again with another Name to prove occupancy was released
  const value2 = await res.lease({ name: 'item-b' }, async () => {
    return 'second-lease-ok'
  })
  await writeFile('result2.txt', value2, 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('hello-from-lease')
      expect(await readFile(join(repo, 'result2.txt'), 'utf8')).toBe('second-lease-ok')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('releases occupancy after callback throw and propagates the error', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('supabase', { capacity: 1 })

  try {
    await res.lease({ name: 'item-fail' }, async () => {
      throw new Error('deliberate-lease-error')
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    await writeFile('error.txt', message, 'utf8')
  }
  // After throw, next lease must succeed immediately
  const val = await res.lease({ name: 'item-next' }, async () => 'recovered')
  await writeFile('recovered.txt', val, 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      expect(await readFile(join(repo, 'error.txt'), 'utf8')).toBe('deliberate-lease-error')
      expect(await readFile(join(repo, 'recovered.txt'), 'utf8')).toBe('recovered')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.resource capacity serialization and waiting', () => {
  it('serializes concurrent work when capacity is one and waits without failing', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { appendFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('scarce', { capacity: 1 })
  const items = [{ id: 'task-a' }, { id: 'task-b' }]

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    await res.lease({ name: item.id }, async () => {
      await appendFile('timeline.txt', \`enter:\${item.id}\\n\`, 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 80))
      await appendFile('timeline.txt', \`exit:\${item.id}\\n\`, 'utf8')
    })
  })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      const timeline = (await readFile(join(repo, 'timeline.txt'), 'utf8')).trim().split('\n')
      expect(timeline.length).toBe(4)

      // Ensure no interleaving: enter:X, exit:X, enter:Y, exit:Y
      const firstEnter = timeline[0]
      const firstExit = timeline[1]
      const secondEnter = timeline[2]
      const secondExit = timeline[3]

      const firstId = firstEnter.split(':')[1]
      const secondId = secondEnter.split(':')[1]

      expect(firstExit).toBe(`exit:${firstId}`)
      expect(secondExit).toBe(`exit:${secondId}`)
      expect(firstId).not.toBe(secondId)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.resource port declarations', () => {
  it('serializes concurrent Leases for different Names on the same Port Resource under implicit capacity one', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { appendFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('single-port', { ports: 4050 })
  const items = [{ id: 'client-a' }, { id: 'client-b' }]

  await drovr.map(items, { concurrency: 2, name: (item) => item.id }, async (item) => {
    await res.lease({ name: item.id }, async () => {
      await appendFile('timeline.txt', \`enter:\${item.id}\\n\`, 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 80))
      await appendFile('timeline.txt', \`exit:\${item.id}\\n\`, 'utf8')
    })
  })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      const timeline = (await readFile(join(repo, 'timeline.txt'), 'utf8')).trim().split('\n')
      expect(timeline).toHaveLength(4)
      const firstEnter = timeline[0]
      const firstExit = timeline[1]
      const secondEnter = timeline[2]
      const secondExit = timeline[3]
      const firstId = firstEnter.split(':')[1]
      const secondId = secondEnter.split(':')[1]
      expect(firstExit).toBe(`exit:${firstId}`)
      expect(secondExit).toBe(`exit:${secondId}`)
      expect(firstId).not.toBe(secondId)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('blocks overlapping declarations atomically across different Resource names while allowing disjoint declarations', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { appendFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const overlapA = await drovr.resource('overlap-a', { ports: { from: 4100, to: 4101 } })
  const overlapB = await drovr.resource('overlap-b', { ports: [4101, 4102] })
  const disjoint = await drovr.resource('disjoint', { ports: 4103 })
  const resources = { a: overlapA, b: overlapB, c: disjoint }
  const items = [
    { id: 'port-a', resource: 'a' },
    { id: 'port-b', resource: 'b' },
    { id: 'port-c', resource: 'c' },
  ]

  await drovr.map(items, { concurrency: 3, name: (item) => item.id }, async (item) => {
    await resources[item.resource].lease({ name: item.id }, async () => {
      await appendFile('timeline.txt', \`enter:\${item.id}\\n\`, 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 80))
      await appendFile('timeline.txt', \`exit:\${item.id}\\n\`, 'utf8')
    })
  })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      const timeline = (await readFile(join(repo, 'timeline.txt'), 'utf8')).trim().split('\n')
      const enterA = timeline.indexOf('enter:port-a')
      const enterB = timeline.indexOf('enter:port-b')
      const enterC = timeline.indexOf('enter:port-c')
      const firstEnter = Math.min(enterA, enterB)
      const firstExit = timeline.indexOf(firstEnter === enterA ? 'exit:port-a' : 'exit:port-b')
      const secondEnter = Math.max(enterA, enterB)

      expect(enterA).toBeGreaterThanOrEqual(0)
      expect(enterB).toBeGreaterThanOrEqual(0)
      expect(firstExit).toBeGreaterThan(firstEnter)
      expect(secondEnter).toBeGreaterThan(firstExit)
      expect(enterC).toBeLessThan(firstExit)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rejects changing a live Port Resource declaration while it has a live Lease', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('live-port', { ports: 4200 })
  await res.lease({ name: 'item' }, async () => {
    try {
      await drovr.resource('live-port', { ports: 4201 })
      await writeFile('changed.txt', 'unexpected-success', 'utf8')
    } catch (error) {
      await writeFile('changed.txt', error instanceof Error ? error.message : String(error), 'utf8')
    }
  })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      expect(await readFile(join(repo, 'changed.txt'), 'utf8')).toMatch(/cannot change ports/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('emits informational resource.ports.probe logs for IPv4 and IPv6 loopback without gating the Lease', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { createServer } from 'node:net'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('probe-port', { ports: 4250 })
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(4250, '127.0.0.1', resolve))
  const result = await res.lease({ name: 'probe-worker' }, async () => {
    return 'lease-ran-without-gating'
  })
  await writeFile('result.txt', result, 'utf8')
  server.close()
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })
      expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('lease-ran-without-gating')
      const log = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
      expect(log).toMatch(
        /resource\.ports\.probe resource=probe-port name=probe-worker port=4250 address=127\.0\.0\.1 status=in-use/,
      )
      expect(log).toMatch(
        /resource\.ports\.probe resource=probe-port name=probe-worker port=4250 address=::1 status=(available|in-use|unavailable)/,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.resource multi-resource and same-Name single occupancy', () => {
  it('allows one Name to hold multiple different Resources simultaneously', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const resA = await drovr.resource('res-a', { capacity: 1 })
  const resB = await drovr.resource('res-b', { capacity: 1 })

  const result = await resA.lease({ name: 'worker-one' }, async () => {
    return await resB.lease({ name: 'worker-one' }, async () => {
      return 'held-both-resources'
    })
  })

  await writeFile('result.txt', result, 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('held-both-resources')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('occupies at most one slot when same Name re-enters same Resource', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('single-res', { capacity: 1 })

  const result = await res.lease({ name: 'worker-one' }, async () => {
    // Re-entering capacity 1 resource with the same Name must succeed (occupies 1 slot)
    return await res.lease({ name: 'worker-one' }, async () => {
      return 'nested-lease-success'
    })
  })

  await writeFile('result.txt', result, 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      expect(await readFile(join(repo, 'result.txt'), 'utf8')).toBe('nested-lease-success')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.resource crash durability and resume reconnection', () => {
  it('leaves Lease durable across process interruption and reconnects immediately on resume', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { readFile, writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('database-lock', { capacity: 1 })

  let pass = '1'
  try {
    pass = await readFile('pass.txt', 'utf8')
  } catch {}

  await drovr.map([{ id: 'worker-crash' }], { concurrency: 1, name: (x) => x.id }, async (item) => {
    await res.lease({ name: item.id }, async () => {
      if (pass === '1') {
        await writeFile('inside-lease.marker', 'ready', 'utf8')
        // Spin waiting for SIGTERM or kill
        await new Promise((resolve) => setTimeout(resolve, 30000))
      } else {
        await writeFile('resumed-and-completed.marker', 'done', 'utf8')
      }
    })
  })
}
`,
        'utf8',
      )

      await writeFile(join(repo, 'pass.txt'), '1', 'utf8')

      // Start run 1 in background
      const child = spawn('node', [drovr, 'start'], {
        cwd: repo,
        stdio: 'pipe',
      })

      // Wait until inside lease marker appears
      await waitForFile(join(repo, 'inside-lease.marker'))

      // Kill the process (simulating crash)
      child.kill('SIGKILL')
      await once(child, 'exit')

      // Pass 2: resume
      await writeFile(join(repo, 'pass.txt'), '2', 'utf8')

      execFileSync('node', [drovr, 'start', '--resume'], {
        cwd: repo,
        stdio: 'pipe',
      })

      expect(await readFile(join(repo, 'resumed-and-completed.marker'), 'utf8')).toBe('done')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.resource capacity constraints and semantic logging', () => {
  it('cannot reduce capacity below live occupancy', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('scalable', { capacity: 2 })

  await drovr.map(
    [{ id: 'holder-a' }, { id: 'holder-b' }],
    { concurrency: 2, name: (x) => x.id },
    async (item) => {
      await res.lease({ name: item.id }, async () => {
        if (item.id === 'holder-b') {
          // When both holder-a and holder-b are holding leases (occupancy = 2),
          // attempting to reduce capacity to 1 must throw
          try {
            await drovr.resource('scalable', { capacity: 1 })
            await writeFile('reduced.txt', 'unexpected-success', 'utf8')
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            await writeFile('reduced.txt', 'failed-as-expected:' + message, 'utf8')
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, 80))
        }
      })
    },
  )
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      const output = await readFile(join(repo, 'reduced.txt'), 'utf8')
      expect(output).toContain('failed-as-expected')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('records resource.lease.request, one resource.lease.wait transition, and resource.lease.acquire events', async () => {
    const repo = await initRepo()
    try {
      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import type { Drovr } from 'drovr'

export default async function workflow(drovr: Drovr) {
  const res = await drovr.resource('limited', { capacity: 1 })
  const items = [{ id: 'item-first' }, { id: 'item-second' }]

  await drovr.map(items, { concurrency: 2, name: (x) => x.id }, async (item) => {
    await res.lease({ name: item.id }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
  })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], { cwd: repo, stdio: 'pipe' })

      const log = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')

      // Check request events for both items
      expect(log).toMatch(/INFO\s+resource\.lease\.request\s+resource=limited\s+name=item-first/)
      expect(log).toMatch(/INFO\s+resource\.lease\.request\s+resource=limited\s+name=item-second/)

      // Check acquisition events for both items
      expect(log).toMatch(/INFO\s+resource\.lease\.acquire\s+resource=limited\s+name=item-first/)
      expect(log).toMatch(/INFO\s+resource\.lease\.acquire\s+resource=limited\s+name=item-second/)

      // Check that exactly one wait event was logged for the second item (which was blocked)
      const waitMatches = log.match(
        /resource\.lease\.wait\s+resource=limited\s+name=(item-first|item-second)/g,
      )
      expect(waitMatches).not.toBeNull()
      expect(waitMatches?.length).toBe(1)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
