import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const dir = await mkdtemp(join(tmpdir(), 'drovr-issues-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  await writeFile(join(dir, 'README.md'), '# test\n', 'utf8')
  runGit(dir, ['add', 'README.md'])
  runGit(dir, ['commit', '-m', 'init'])
  return dir
}

interface MockGhState {
  currentUser?: string
  defaultRepo?: string
  issues?: Array<{
    repo: string
    number: number
    title: string
    body: string
    url: string
    state: 'OPEN' | 'CLOSED'
    labels: Array<string | { name: string }>
    assignees: Array<string | { login: string }>
    author: string | { login: string } | null
    createdAt: string
    updatedAt: string
    [key: string]: unknown
  }>
  failNextEdit?: boolean
  failNextClose?: boolean
}

async function setupMockGh(
  dir: string,
  initialState: MockGhState,
): Promise<{ binDir: string; statePath: string }> {
  const binDir = join(dir, '.mock-bin')
  await mkdir(binDir, { recursive: true })
  const statePath = join(dir, 'mock-gh-state.json')
  await writeFile(statePath, JSON.stringify(initialState, null, 2), 'utf8')

  const mockGhScript = `#!/usr/bin/env node
const fs = require('node:fs')

const statePath = process.env.GH_STATE_FILE
if (!statePath || !fs.existsSync(statePath)) {
  console.error('GH_STATE_FILE not found')
  process.exit(1)
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const args = process.argv.slice(2)

function getRepoArg() {
  const rIndex = args.indexOf('-R') !== -1 ? args.indexOf('-R') : args.indexOf('--repo')
  if (rIndex !== -1 && args[rIndex + 1]) {
    return args[rIndex + 1]
  }
  return state.defaultRepo || 'octocat/hello-world'
}

// Command: gh repo view [--json nameWithOwner]
if (args[0] === 'repo' && args[1] === 'view') {
  const repo = getRepoArg()
  console.log(JSON.stringify({ nameWithOwner: repo }))
  process.exit(0)
}

// Command: gh api user
if (args[0] === 'api' && args[1] === 'user') {
  console.log(JSON.stringify({ login: state.currentUser || 'drovr-bot' }))
  process.exit(0)
}

// Command: gh issue list
if (args[0] === 'issue' && args[1] === 'list') {
  const targetRepo = getRepoArg()
  const issues = (state.issues || []).filter((i) => {
    if (i.repo !== targetRepo) return false
    if (args.includes('--state') && args[args.indexOf('--state') + 1]) {
      const st = args[args.indexOf('--state') + 1].toUpperCase()
      if (st !== 'ALL' && i.state !== st) return false
    }
    if (args.includes('--label')) {
      const lbl = args[args.indexOf('--label') + 1]
      const hasLabel = (i.labels || []).some((l) => (typeof l === 'string' ? l : l.name) === lbl)
      if (!hasLabel) return false
    }
    return true
  })
  let limit = 30
  const limitIndex = args.indexOf('--limit') !== -1 ? args.indexOf('--limit') : args.indexOf('-L')
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    limit = parseInt(args[limitIndex + 1], 10)
  }
  const sliced = issues.slice(0, limit)
  console.log(JSON.stringify(sliced))
  process.exit(0)
}

// Command: gh issue view <number>
if (args[0] === 'issue' && args[1] === 'view') {
  const num = parseInt(args[2], 10)
  const targetRepo = getRepoArg()
  const issue = (state.issues || []).find((i) => i.repo === targetRepo && i.number === num)
  if (!issue) {
    console.error('issue not found: #' + num)
    process.exit(1)
  }
  console.log(JSON.stringify(issue))
  process.exit(0)
}

// Command: gh issue edit <number> --add-assignee <login>
if (args[0] === 'issue' && args[1] === 'edit') {
  if (state.failNextEdit) {
    state.failNextEdit = false
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
    console.error('Simulated GitHub API network error')
    process.exit(1)
  }
  const num = parseInt(args[2], 10)
  const targetRepo = getRepoArg()
  const issue = (state.issues || []).find((i) => i.repo === targetRepo && i.number === num)
  if (!issue) {
    console.error('issue not found for edit: #' + num)
    process.exit(1)
  }
  const assigneeIndex = args.indexOf('--add-assignee')
  if (assigneeIndex !== -1 && args[assigneeIndex + 1]) {
    const rawLogin = args[assigneeIndex + 1]
    const login = rawLogin === '@me' ? (state.currentUser || 'drovr-bot') : rawLogin
    const assignees = issue.assignees || []
    const exists = assignees.some((a) => (typeof a === 'string' ? a : a.login) === login)
    if (!exists) {
      assignees.push({ login })
      issue.assignees = assignees
    }
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
  process.exit(0)
}

// Command: gh issue close <number>
if (args[0] === 'issue' && args[1] === 'close') {
  if (state.failNextClose) {
    state.failNextClose = false
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
    console.error('Simulated GitHub API close error')
    process.exit(1)
  }
  const num = parseInt(args[2], 10)
  const targetRepo = getRepoArg()
  const issue = (state.issues || []).find((i) => i.repo === targetRepo && i.number === num)
  if (!issue) {
    console.error('issue not found for close: #' + num)
    process.exit(1)
  }
  issue.state = 'CLOSED'
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
  process.exit(0)
}

console.error('unknown gh command:', args.join(' '))
process.exit(1)
`

  const ghPath = join(binDir, 'gh')
  await writeFile(ghPath, mockGhScript, 'utf8')
  await chmod(ghPath, 0o755)

  return { binDir, statePath }
}

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('Drovr.issues.list', () => {
  it('defaults to open, unassigned, ready-for-agent Issues in the Start checkout repository', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'agent-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 101,
            title: 'Add widget support',
            body: 'Widget body',
            url: 'https://github.com/acme/widget/issues/101',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }, { name: 'feature' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
            rawMeta: 'should-not-leak',
          },
          {
            repo: 'acme/widget',
            number: 102,
            title: 'Assigned to human',
            body: 'Already assigned',
            url: 'https://github.com/acme/widget/issues/102',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [{ login: 'bob' }],
            author: { login: 'bob' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
          {
            repo: 'acme/widget',
            number: 103,
            title: 'Not ready',
            body: 'Needs info',
            url: 'https://github.com/acme/widget/issues/103',
            state: 'OPEN',
            labels: [{ name: 'needs-info' }],
            assignees: [],
            author: { login: 'carol' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from 'node:fs/promises'
export default async function (drovr) {
  const issues = await drovr.issues.list()
  await writeFile('result.json', JSON.stringify(issues), 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const result = JSON.parse(await readFile(join(repo, 'result.json'), 'utf8'))
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        repo: 'acme/widget',
        number: 101,
        title: 'Add widget support',
        body: 'Widget body',
        url: 'https://github.com/acme/widget/issues/101',
        state: 'OPEN',
        labels: ['ready-for-agent', 'feature'],
        assignees: [],
        author: 'alice',
        createdAt: '2026-08-18T00:00:00Z',
        updatedAt: '2026-08-18T01:00:00Z',
      })
      expect(result[0]).not.toHaveProperty('rawMeta')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('supports explicit repository override and returns readonly snapshots', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'agent-bot',
        issues: [
          {
            repo: 'acme/other-project',
            number: 55,
            title: 'Other repo issue',
            body: 'Other repo body',
            url: 'https://github.com/acme/other-project/issues/55',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: null,
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from 'node:fs/promises'
export default async function (drovr) {
  const issues = await drovr.issues.list({ repo: 'acme/other-project' })
  const isListFrozen = Object.isFrozen(issues)
  const isIssueFrozen = Object.isFrozen(issues[0])
  const isLabelsFrozen = Object.isFrozen(issues[0].labels)
  const isAssigneesFrozen = Object.isFrozen(issues[0].assignees)
  await writeFile(
    'result.json',
    JSON.stringify({
      issues,
      frozen: { isListFrozen, isIssueFrozen, isLabelsFrozen, isAssigneesFrozen },
    }),
    'utf8',
  )
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const result = JSON.parse(await readFile(join(repo, 'result.json'), 'utf8'))
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0].repo).toBe('acme/other-project')
      expect(result.issues[0].number).toBe(55)
      expect(result.issues[0].author).toBeNull()
      expect(result.frozen).toEqual({
        isListFrozen: true,
        isIssueFrozen: true,
        isLabelsFrozen: true,
        isAssigneesFrozen: true,
      })
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('includes open Issues already Claimed in this Project database even when GitHub shows an assignee', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'agent-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 201,
            title: 'Unassigned issue',
            body: 'Body 201',
            url: 'https://github.com/acme/widget/issues/201',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
          {
            repo: 'acme/widget',
            number: 202,
            title: 'Already claimed issue',
            body: 'Body 202',
            url: 'https://github.com/acme/widget/issues/202',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [{ login: 'agent-bot' }],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
          {
            repo: 'acme/widget',
            number: 203,
            title: 'Assigned to someone else',
            body: 'Body 203',
            url: 'https://github.com/acme/widget/issues/203',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [{ login: 'stranger' }],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      // First pass claims issue 201 for name 'worker-a' and issue 202 for 'worker-b'
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  const issue201 = issues.find((i) => i.number === 201)
  if (issue201) {
    await drovr.issues.claim(issue201, { name: 'worker-a' })
  }
  const issue202 = {
    repo: 'acme/widget',
    number: 202,
    title: 'Already claimed issue',
    body: 'Body 202',
    url: 'https://github.com/acme/widget/issues/202',
    state: 'OPEN',
    labels: ['ready-for-agent'],
    assignees: ['agent-bot'],
    author: 'alice',
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T01:00:00Z',
  }
  await drovr.issues.claim(issue202, { name: 'worker-b' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      // Second pass lists issues - should return 201 (now assigned to agent-bot and claimed by worker-a) and 202 (claimed by worker-b), but NOT 203 (assigned to stranger)
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from 'node:fs/promises'
export default async function (drovr) {
  const issues = await drovr.issues.list()
  await writeFile('result.json', JSON.stringify(issues.map((i) => i.number)), 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const numbers = JSON.parse(await readFile(join(repo, 'result.json'), 'utf8'))
      expect(numbers.sort()).toEqual([201, 202])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('reconciles and removes stale claims for issues closed on GitHub', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'agent-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 301,
            title: 'Issue to claim then close externally',
            body: 'Body 301',
            url: 'https://github.com/acme/widget/issues/301',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'worker-stale' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      // Simulate issue 301 being closed on GitHub out-of-band
      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      ghState.issues[0].state = 'CLOSED'
      await writeFile(statePath, JSON.stringify(ghState, null, 2), 'utf8')

      // Next list call should reconcile and omit 301
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from 'node:fs/promises'
export default async function (drovr) {
  const issues = await drovr.issues.list()
  await writeFile('result.json', JSON.stringify(issues), 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const issues = JSON.parse(await readFile(join(repo, 'result.json'), 'utf8'))
      expect(issues).toHaveLength(0)

      // After list reconciliation, prove that the stale Claim was deleted through public behavior:
      // attempting to release the issue snapshot must fail with "no local Claim exists"
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issue = {
    repo: 'acme/widget',
    number: 301,
    title: 'Issue to claim then close externally',
    body: 'Body 301',
    url: 'https://github.com/acme/widget/issues/301',
    state: 'CLOSED',
    labels: ['ready-for-agent'],
    assignees: ['agent-bot'],
    author: 'alice',
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T01:00:00Z',
  }
  await drovr.issues.release(issue)
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/no local Claim exists/)

      // If the issue is reopened externally on GitHub, subsequent default list still omits it
      // because it is assigned to agent-bot and no longer locally Claimed
      ghState.issues[0].state = 'OPEN'
      ghState.issues[0].assignees = [{ login: 'agent-bot' }]
      await writeFile(statePath, JSON.stringify(ghState, null, 2), 'utf8')

      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from 'node:fs/promises'
export default async function (drovr) {
  const issues = await drovr.issues.list()
  await writeFile('result.json', JSON.stringify(issues), 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const afterReopenIssues = JSON.parse(await readFile(join(repo, 'result.json'), 'utf8'))
      expect(afterReopenIssues).toHaveLength(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('validates list options and rejects malformed repo overrides', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  await drovr.issues.list({ repo: 'invalid-no-slash' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/must be in owner\/repo form/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fetches more than the gh default 30 issues when explicit limit is used', async () => {
    const repo = await initRepo()
    try {
      const issuesList = []
      for (let i = 1; i <= 35; i++) {
        issuesList.push({
          repo: 'acme/widget',
          number: i,
          title: `Issue ${i}`,
          body: `Body ${i}`,
          url: `https://github.com/acme/widget/issues/${i}`,
          state: 'OPEN' as const,
          labels: [{ name: 'ready-for-agent' }],
          assignees: [],
          author: { login: 'alice' },
          createdAt: '2026-08-18T00:00:00Z',
          updatedAt: '2026-08-18T01:00:00Z',
        })
      }

      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: issuesList,
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from 'node:fs/promises'
export default async function (drovr) {
  const issues = await drovr.issues.list()
  await writeFile('result.json', JSON.stringify({ count: issues.length }), 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const result = JSON.parse(await readFile(join(repo, 'result.json'), 'utf8'))
      expect(result.count).toBe(35)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('returns open locally Claimed issues even if ready-for-agent label was removed out-of-band', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 350,
            title: 'Issue whose label will be removed',
            body: 'Body 350',
            url: 'https://github.com/acme/widget/issues/350',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      // First pass: claim issue 350 for name 'agent-owner'
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'agent-owner' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      // Out-of-band edit on GitHub removes ready-for-agent label (leaving only 'in-progress')
      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      ghState.issues[0].labels = [{ name: 'in-progress' }]
      await writeFile(statePath, JSON.stringify(ghState, null, 2), 'utf8')

      // Second pass: list issues should still return 350 because it is open and locally Claimed
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from 'node:fs/promises'
export default async function (drovr) {
  const issues = await drovr.issues.list()
  await writeFile('result.json', JSON.stringify(issues.map((i) => i.number)), 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const numbers = JSON.parse(await readFile(join(repo, 'result.json'), 'utf8'))
      expect(numbers).toEqual([350])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.issues.claim', () => {
  it('reserves issue in database and assigns authenticated GitHub user while retaining readiness', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 401,
            title: 'Claimable issue',
            body: 'Body 401',
            url: 'https://github.com/acme/widget/issues/401',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }, { name: 'bug' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'agent-one' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      const issue = ghState.issues[0]
      expect(issue.assignees).toEqual([{ login: 'drovr-bot' }])
      const labelNames = issue.labels.map((l: string | { name: string }) =>
        typeof l === 'string' ? l : l.name,
      )
      expect(labelNames).toContain('ready-for-agent')
      expect(labelNames).toContain('bug')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('reconnects same-Name retries idempotently and rejects different-Name collisions', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 501,
            title: 'Collision test issue',
            body: 'Body 501',
            url: 'https://github.com/acme/widget/issues/501',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Claim once under name 'agent-owner'
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'agent-owner' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      // Same-Name retry: should succeed idempotently
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'agent-owner' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
        }),
      ).not.toThrow()

      // Different-Name attempt: should throw collision error without stealing ownership
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'different-agent' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/already claimed by/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('reserves atomically before GitHub assignment and allows same-Name retry on GitHub failure', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        failNextEdit: true, // Will fail the first gh issue edit call
        issues: [
          {
            repo: 'acme/widget',
            number: 601,
            title: 'Recovery test issue',
            body: 'Body 601',
            url: 'https://github.com/acme/widget/issues/601',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'recovering-agent' })
}
`,
        'utf8',
      )

      // First run fails during GitHub assignment (after SQLite reservation)
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/Simulated GitHub API network error/)

      // Different name must be rejected because reservation was already made
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'intruder-agent' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/already claimed by/)

      // Same name retry now succeeds and completes GitHub assignment
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'recovering-agent' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
        }),
      ).not.toThrow()

      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      expect(ghState.issues[0].assignees).toEqual([{ login: 'drovr-bot' }])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('validates claim inputs and rejects invalid Names and malformed Issue objects', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 701,
            title: 'Validation issue',
            body: 'Body 701',
            url: 'https://github.com/acme/widget/issues/701',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: null,
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  // Invalid uppercase name
  await drovr.issues.claim(issues[0], { name: 'INVALID-NAME' })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/Names must match/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.issues.close', () => {
  it('fails before GitHub mutation when the Issue has no local Claim', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 801,
            title: 'Unclaimed close attempt',
            body: 'Body 801',
            url: 'https://github.com/acme/widget/issues/801',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.close(issues[0])
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/no local Claim exists/)

      // Confirm GitHub issue was NOT mutated and remains OPEN
      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      expect(ghState.issues[0].state).toBe('OPEN')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('confirms the GitHub Issue is closed before deleting the Claim and retains assignee and readiness label', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 802,
            title: 'Claim and close issue',
            body: 'Body 802',
            url: 'https://github.com/acme/widget/issues/802',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }, { name: 'feature' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Claim and close in workflow
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'worker-closer' })
  await drovr.issues.close(issues[0])
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      const issue = ghState.issues[0]
      // Confirmed closed on GitHub
      expect(issue.state).toBe('CLOSED')
      // Retains assignee and readiness label
      expect(issue.assignees).toEqual([{ login: 'drovr-bot' }])
      const labelNames = issue.labels.map((l: string | { name: string }) =>
        typeof l === 'string' ? l : l.name,
      )
      expect(labelNames).toContain('ready-for-agent')
      expect(labelNames).toContain('feature')

      // Second run trying to close again should fail because local claim was deleted
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issue = {
    repo: 'acme/widget',
    number: 802,
    title: 'Claim and close issue',
    body: 'Body 802',
    url: 'https://github.com/acme/widget/issues/802',
    state: 'CLOSED',
    labels: ['ready-for-agent', 'feature'],
    assignees: ['drovr-bot'],
    author: 'alice',
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T01:00:00Z',
  }
  await drovr.issues.close(issue)
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/no local Claim exists/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('closes idempotently when GitHub Issue is already closed but has a surviving Claim', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 803,
            title: 'Already closed GitHub issue',
            body: 'Body 803',
            url: 'https://github.com/acme/widget/issues/803',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Claim the issue
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'worker-idempotent' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      // GitHub issue is closed out-of-band, but local claim still survives
      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      ghState.issues[0].state = 'CLOSED'
      await writeFile(statePath, JSON.stringify(ghState, null, 2), 'utf8')

      // Closing with surviving claim must succeed idempotently and delete the claim
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issue = {
    repo: 'acme/widget',
    number: 803,
    title: 'Already closed GitHub issue',
    body: 'Body 803',
    url: 'https://github.com/acme/widget/issues/803',
    state: 'CLOSED',
    labels: ['ready-for-agent'],
    assignees: ['drovr-bot'],
    author: 'alice',
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T01:00:00Z',
  }
  await drovr.issues.close(issue)
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
        }),
      ).not.toThrow()

      // Now the claim has been deleted; calling close again should fail with no local Claim
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/no local Claim exists/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('preserves the Claim on GitHub failure', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 804,
            title: 'Close failure test issue',
            body: 'Body 804',
            url: 'https://github.com/acme/widget/issues/804',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Claim the issue
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'worker-close-fail' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      // Simulate next gh issue close failure
      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      ghState.failNextClose = true
      await writeFile(statePath, JSON.stringify(ghState, null, 2), 'utf8')

      // Attempt to close should fail
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issue = {
    repo: 'acme/widget',
    number: 804,
    title: 'Close failure test issue',
    body: 'Body 804',
    url: 'https://github.com/acme/widget/issues/804',
    state: 'OPEN',
    labels: ['ready-for-agent'],
    assignees: ['drovr-bot'],
    author: 'alice',
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T01:00:00Z',
  }
  await drovr.issues.close(issue)
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/Simulated GitHub API close error/)

      // Claim was preserved! Retrying close succeeds
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
        }),
      ).not.toThrow()

      const finalGhState = JSON.parse(await readFile(statePath, 'utf8'))
      expect(finalGhState.issues[0].state).toBe('CLOSED')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('surfaces Project database Claim deletion failure during Close, leaves GitHub closed, and retains Claim for recovery', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 805,
            title: 'Close Claim deletion failure issue',
            body: 'Body 805',
            url: 'https://github.com/acme/widget/issues/805',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Claim the issue first
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'worker-close-db-fail' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      // Attempt to close while holding a schema-agnostic write lock on the database file from the authored Workflow
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { DatabaseSync } from 'node:sqlite'
export default async function (drovr) {
  const blocker = new DatabaseSync('.drovr/state.sqlite')
  blocker.exec('BEGIN IMMEDIATE;')
  try {
    const issue = {
      repo: 'acme/widget',
      number: 805,
      title: 'Close Claim deletion failure issue',
      body: 'Body 805',
      url: 'https://github.com/acme/widget/issues/805',
      state: 'OPEN',
      labels: ['ready-for-agent'],
      assignees: ['drovr-bot'],
      author: 'alice',
      createdAt: '2026-08-18T00:00:00Z',
      updatedAt: '2026-08-18T01:00:00Z',
    }
    await drovr.issues.close(issue)
  } finally {
    try {
      blocker.exec('ROLLBACK;')
    } catch {}
    blocker.close()
  }
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/busy|locked/)

      // Verify GitHub issue was already closed and retained assignee/labels
      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      expect(ghState.issues[0].state).toBe('CLOSED')
      expect(ghState.issues[0].assignees).toEqual([{ login: 'drovr-bot' }])

      // Retry close without write fault: since Claim was preserved, close succeeds idempotently and deletes the Claim
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issue = {
    repo: 'acme/widget',
    number: 805,
    title: 'Close Claim deletion failure issue',
    body: 'Body 805',
    url: 'https://github.com/acme/widget/issues/805',
    state: 'CLOSED',
    labels: ['ready-for-agent'],
    assignees: ['drovr-bot'],
    author: 'alice',
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T01:00:00Z',
  }
  await drovr.issues.close(issue)
}
`,
        'utf8',
      )
      // Retry close: since Claim was preserved, close succeeds idempotently and deletes the Claim
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
        }),
      ).not.toThrow()

      // Subsequent close fails with no local Claim exists, proving claim was deleted on retry
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/no local Claim exists/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  }, 20_000)

  it('validates close inputs and rejects malformed Issue objects', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  await drovr.issues.close({ repo: 'invalid', number: -1 })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/close issue.number must be a positive integer/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('Drovr.issues.release', () => {
  it('fails when the Issue has no local Claim', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 901,
            title: 'Unclaimed release attempt',
            body: 'Body 901',
            url: 'https://github.com/acme/widget/issues/901',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.release(issues[0])
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/no local Claim exists/)

      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      expect(ghState.issues[0].state).toBe('OPEN')
      expect(ghState.issues[0].assignees).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('deletes only the local Claim and leaves the open Issue assigned, labelled, and outside the default list', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 902,
            title: 'Release issue test',
            body: 'Body 902',
            url: 'https://github.com/acme/widget/issues/902',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }, { name: 'enhancement' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Claim and then Release the issue
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'worker-releaser' })
  await drovr.issues.release(issues[0])
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      const issue = ghState.issues[0]
      // GitHub Issue remains OPEN, assigned, and labelled
      expect(issue.state).toBe('OPEN')
      expect(issue.assignees).toEqual([{ login: 'drovr-bot' }])
      const labelNames = issue.labels.map((l: string | { name: string }) =>
        typeof l === 'string' ? l : l.name,
      )
      expect(labelNames).toContain('ready-for-agent')
      expect(labelNames).toContain('enhancement')

      // Second run: drovr.issues.list() should NOT include issue 902 in the default list because it is assigned and not locally claimed
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { writeFile } from 'node:fs/promises'
export default async function (drovr) {
  const issues = await drovr.issues.list()
  await writeFile('result.json', JSON.stringify(issues), 'utf8')
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      const listResult = JSON.parse(await readFile(join(repo, 'result.json'), 'utf8'))
      expect(listResult).toHaveLength(0)

      // Releasing again should fail because local claim was deleted
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issue = {
    repo: 'acme/widget',
    number: 902,
    title: 'Release issue test',
    body: 'Body 902',
    url: 'https://github.com/acme/widget/issues/902',
    state: 'OPEN',
    labels: ['ready-for-agent', 'enhancement'],
    assignees: ['drovr-bot'],
    author: 'alice',
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T01:00:00Z',
  }
  await drovr.issues.release(issue)
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/no local Claim exists/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('surfaces Project database Claim deletion failure during Release, leaves GitHub open and unchanged, and retains Claim for recovery', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widget',
            number: 903,
            title: 'Release Claim deletion failure issue',
            body: 'Body 903',
            url: 'https://github.com/acme/widget/issues/903',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      // Claim the issue first
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issues = await drovr.issues.list()
  await drovr.issues.claim(issues[0], { name: 'worker-release-db-fail' })
}
`,
        'utf8',
      )

      execFileSync('node', [drovr, 'start'], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          GH_STATE_FILE: statePath,
        },
      })

      // Attempt to release while holding a schema-agnostic write lock on the database file from the authored Workflow
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `import { DatabaseSync } from 'node:sqlite'
export default async function (drovr) {
  const blocker = new DatabaseSync('.drovr/state.sqlite')
  blocker.exec('BEGIN IMMEDIATE;')
  try {
    const issue = {
      repo: 'acme/widget',
      number: 903,
      title: 'Release Claim deletion failure issue',
      body: 'Body 903',
      url: 'https://github.com/acme/widget/issues/903',
      state: 'OPEN',
      labels: ['ready-for-agent'],
      assignees: ['drovr-bot'],
      author: 'alice',
      createdAt: '2026-08-18T00:00:00Z',
      updatedAt: '2026-08-18T01:00:00Z',
    }
    await drovr.issues.release(issue)
  } finally {
    try {
      blocker.exec('ROLLBACK;')
    } catch {}
    blocker.close()
  }
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/busy|locked/)

      // Verify GitHub issue remains OPEN, assigned, and labelled (completely unchanged)
      const ghState = JSON.parse(await readFile(statePath, 'utf8'))
      expect(ghState.issues[0].state).toBe('OPEN')
      expect(ghState.issues[0].assignees).toEqual([{ login: 'drovr-bot' }])

      // Retry release without write fault: since Claim was preserved, release succeeds and deletes the Claim
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  const issue = {
    repo: 'acme/widget',
    number: 903,
    title: 'Release Claim deletion failure issue',
    body: 'Body 903',
    url: 'https://github.com/acme/widget/issues/903',
    state: 'OPEN',
    labels: ['ready-for-agent'],
    assignees: ['drovr-bot'],
    author: 'alice',
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T01:00:00Z',
  }
  await drovr.issues.release(issue)
}
`,
        'utf8',
      )
      // Retry release: since Claim was preserved, release succeeds and deletes the Claim
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
        }),
      ).not.toThrow()

      // Subsequent release fails with no local Claim exists, proving claim was deleted on retry
      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/no local Claim exists/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  }, 20_000)

  it('validates release inputs and rejects malformed Issue objects', async () => {
    const repo = await initRepo()
    try {
      const { binDir, statePath } = await setupMockGh(repo, {
        defaultRepo: 'acme/widget',
        currentUser: 'drovr-bot',
        issues: [],
      })

      await mkdir(join(repo, '.drovr'), { recursive: true })
      await writeFile(
        join(repo, '.drovr/main.ts'),
        `export default async function (drovr) {
  await drovr.issues.release({ repo: '', number: 1 })
}
`,
        'utf8',
      )

      expect(() =>
        execFileSync('node', [drovr, 'start'], {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GH_STATE_FILE: statePath,
          },
          stdio: 'pipe',
        }),
      ).toThrow(/release issue.repo must be a non-empty string/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
