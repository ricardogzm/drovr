import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
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
  const dir = await mkdtemp(join(tmpdir(), 'drovr-workflow-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  await writeFile(join(dir, 'README.md'), '# test repository\n', 'utf8')
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test-app', type: 'module' }, null, 2),
    'utf8',
  )
  runGit(dir, ['add', 'README.md', 'package.json'])
  runGit(dir, ['commit', '-m', 'initial commit'])
  return dir
}

interface MockGhIssue {
  repo: string
  number: number
  title: string
  body: string
  url: string
  state: 'OPEN' | 'CLOSED'
  labels: Array<{ name: string } | string>
  assignees: Array<{ login: string } | string>
  author: { login: string } | string | null
  createdAt: string
  updatedAt: string
}

interface MockGhState {
  currentUser?: string
  defaultRepo?: string
  issues?: MockGhIssue[]
}

interface MockHerdrWorkspace {
  workspace_id: string
  number: number
  label?: string
  focused: boolean
  pane_count: number
  tab_count: number
  active_tab_id: string
  agent_status: string
}

interface MockHerdrPane {
  pane_id: string
  terminal_id: string
  workspace_id: string
  tab_id: string
  focused: boolean
  agent_status: string
  revision: number
  cwd: string
}

interface MockHerdrAgent {
  terminal_id: string
  agent_status: string
  workspace_id: string
  tab_id: string
  pane_id: string
  focused: boolean
  revision: number
  name: string
  agent: string
  display_agent: string
  cwd: string
  foreground_cwd: string
  prompts?: string[]
}

interface MockHerdrState {
  workspaces?: MockHerdrWorkspace[]
  panes?: MockHerdrPane[]
  agents?: MockHerdrAgent[]
  nextWorkspaceNum?: number
}

async function setupMockCliEnvironment(
  dir: string,
  initialGhState: MockGhState,
  initialHerdrState: MockHerdrState = {},
): Promise<{
  binDir: string
  ghStatePath: string
  herdrStatePath: string
  getGhState: () => Promise<MockGhState>
  getHerdrState: () => Promise<MockHerdrState>
}> {
  const binDir = join(dir, '.mock-bin')
  await mkdir(binDir, { recursive: true })

  const ghStatePath = join(dir, 'mock-gh-state.json')
  await writeFile(ghStatePath, JSON.stringify(initialGhState, null, 2), 'utf8')

  const herdrStatePath = join(dir, 'mock-herdr-state.json')
  const defaultHerdrState: MockHerdrState = {
    workspaces: [],
    panes: [],
    agents: [],
    nextWorkspaceNum: 1,
    ...initialHerdrState,
  }
  await writeFile(herdrStatePath, JSON.stringify(defaultHerdrState, null, 2), 'utf8')

  const mockGhScript = `#!/usr/bin/env node
import fs from 'node:fs'

const statePath = process.env.GH_STATE_FILE
if (!statePath || !fs.existsSync(statePath)) {
  console.error('GH_STATE_FILE not found')
  process.exit(1)
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const args = process.argv.slice(2)

function saveState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

function getRepoArg() {
  const rIndex = args.indexOf('-R') !== -1 ? args.indexOf('-R') : args.indexOf('--repo')
  if (rIndex !== -1 && args[rIndex + 1]) {
    return args[rIndex + 1]
  }
  return state.defaultRepo || 'octocat/hello-world'
}

if (args[0] === 'repo' && args[1] === 'view') {
  const repo = getRepoArg()
  console.log(JSON.stringify({ nameWithOwner: repo }))
  process.exit(0)
}

if (args[0] === 'api' && args[1] === 'user') {
  console.log(JSON.stringify({ login: state.currentUser || 'drovr-bot' }))
  process.exit(0)
}

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

if (args[0] === 'issue' && args[1] === 'edit') {
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
  saveState()
  process.exit(0)
}

if (args[0] === 'issue' && args[1] === 'close') {
  const num = parseInt(args[2], 10)
  const targetRepo = getRepoArg()
  const issue = (state.issues || []).find((i) => i.repo === targetRepo && i.number === num)
  if (!issue) {
    console.error('issue not found for close: #' + num)
    process.exit(1)
  }
  issue.state = 'CLOSED'
  saveState()
  process.exit(0)
}

console.error('unknown mock gh command:', args.join(' '))
process.exit(1)
`

  const mockHerdrScript = `#!/usr/bin/env node
import fs from 'node:fs'

const statePath = process.env.HERDR_STATE_FILE
if (!statePath || !fs.existsSync(statePath)) {
  console.error('HERDR_STATE_FILE not found')
  process.exit(1)
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
if (!state.workspaces) state.workspaces = []
if (!state.panes) state.panes = []
if (!state.agents) state.agents = []
if (!state.nextWorkspaceNum) state.nextWorkspaceNum = 1

const args = process.argv.slice(2)

function saveState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

if (args[0] === 'workspace' && args[1] === 'create') {
  let cwd = process.cwd()
  let label = undefined
  let focused = true

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--cwd' && args[i + 1]) {
      cwd = args[++i]
    } else if (args[i] === '--label' && args[i + 1]) {
      label = args[++i]
    } else if (args[i] === '--no-focus') {
      focused = false
    } else if (args[i] === '--focus') {
      focused = true
    }
  }

  const num = state.nextWorkspaceNum++
  const wsId = 'w' + num
  const tabId = wsId + ':t1'
  const paneId = wsId + ':p1'
  const termId = 'term-' + num

  const ws = {
    workspace_id: wsId,
    number: num,
    label,
    focused,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: tabId,
    agent_status: 'unknown'
  }

  const tab = {
    tab_id: tabId,
    workspace_id: wsId,
    number: 1,
    label: 'tab 1',
    focused,
    pane_count: 1,
    agent_status: 'unknown'
  }

  const rootPane = {
    pane_id: paneId,
    terminal_id: termId,
    workspace_id: wsId,
    tab_id: tabId,
    focused,
    agent_status: 'unknown',
    revision: 0,
    cwd
  }

  state.workspaces.push(ws)
  state.panes.push(rootPane)
  saveState()

  console.log(JSON.stringify({
    id: 'req-' + num,
    result: {
      type: 'workspace_created',
      workspace: ws,
      tab,
      root_pane: rootPane
    }
  }))
  process.exit(0)
}

if (args[0] === 'workspace' && args[1] === 'close') {
  const wsId = args[2]
  if (!wsId) {
    console.error('missing workspace_id for workspace close')
    process.exit(1)
  }
  const idx = state.workspaces.findIndex((w) => w.workspace_id === wsId)
  if (idx !== -1) {
    state.workspaces.splice(idx, 1)
  }
  state.panes = state.panes.filter((p) => p.workspace_id !== wsId)
  state.agents = state.agents.filter((a) => a.workspace_id !== wsId)
  saveState()
  console.log(JSON.stringify({
    id: 'req-close',
    result: {
      type: 'workspace_closed',
      workspace_id: wsId
    }
  }))
  process.exit(0)
}

if (args[0] === 'workspace' && args[1] === 'list') {
  console.log(JSON.stringify({
    id: 'req-ws-list',
    result: {
      type: 'workspace_list',
      workspaces: state.workspaces
    }
  }))
  process.exit(0)
}

if (args[0] === 'agent' && args[1] === 'start') {
  const name = args[2]
  if (!name) {
    console.error('missing agent name')
    process.exit(1)
  }

  const existingAgent = state.agents.find((a) => a.name === name)
  if (existingAgent) {
    console.error('agent "' + name + '" already exists')
    process.exit(1)
  }

  let kind = 'omp'
  let paneId = undefined
  const ompArgs = []
  let doubleDash = false

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--') {
      doubleDash = true
      continue
    }
    if (doubleDash) {
      ompArgs.push(args[i])
      continue
    }
    if (args[i] === '--kind' && args[i + 1]) {
      kind = args[++i]
    } else if (args[i] === '--pane' && args[i + 1]) {
      paneId = args[++i]
    }
  }

  if (!paneId) {
    console.error('missing --pane for agent start')
    process.exit(1)
  }

  const pane = state.panes.find((p) => p.pane_id === paneId)
  const agentRecord = {
    terminal_id: pane ? pane.terminal_id : 'term-' + paneId,
    agent_status: 'idle',
    workspace_id: pane ? pane.workspace_id : 'unknown',
    tab_id: pane ? pane.tab_id : 'unknown',
    pane_id: paneId,
    focused: false,
    revision: 1,
    name,
    agent: kind,
    display_agent: kind.toUpperCase(),
    cwd: pane ? pane.cwd : process.cwd(),
    foreground_cwd: pane ? pane.cwd : process.cwd(),
    prompts: []
  }

  state.agents.push(agentRecord)
  saveState()

  console.log(JSON.stringify({
    id: 'req-agent-start',
    result: {
      type: 'agent_started',
      agent: agentRecord,
      argv: ompArgs
    }
  }))
  process.exit(0)
}

if (args[0] === 'agent' && args[1] === 'get') {
  const name = args[2]
  const agent = state.agents.find((a) => a.name === name)
  if (!agent) {
    console.error('agent not found: ' + name)
    process.exit(1)
  }
  console.log(JSON.stringify({
    id: 'req-agent-get',
    result: {
      type: 'agent_info',
      agent
    }
  }))
  process.exit(0)
}

if (args[0] === 'agent' && args[1] === 'list') {
  console.log(JSON.stringify({
    id: 'req-agent-list',
    result: {
      type: 'agent_list',
      agents: state.agents
    }
  }))
  process.exit(0)
}

if (args[0] === 'agent' && args[1] === 'prompt') {
  const target = args[2]
  const text = args[3]
  if (!target || text === undefined) {
    console.error('missing prompt target or text')
    process.exit(1)
  }

  const agent = state.agents.find((a) => a.name === target)
  if (!agent) {
    console.error('agent not found: ' + target)
    process.exit(1)
  }

  if (!agent.prompts) agent.prompts = []
  agent.prompts.push(text)
  agent.agent_status = 'idle'
  saveState()

  console.log(JSON.stringify({
    id: 'req-agent-prompt',
    result: {
      type: 'agent_prompted',
      agent
    }
  }))
  process.exit(0)
}

if (args[0] === 'agent' && args[1] === 'wait') {
  const target = args[2]
  const agent = state.agents.find((a) => a.name === target)
  if (!agent) {
    console.error('agent not found: ' + target)
    process.exit(1)
  }
  agent.agent_status = 'idle'
  saveState()
  console.log(JSON.stringify({
    id: 'req-agent-wait',
    result: {
      type: 'agent_waited',
      agent
    }
  }))
  process.exit(0)
}

console.error('unknown mock herdr command:', args.join(' '))
process.exit(1)
`

  const ghPath = join(binDir, 'gh')
  await writeFile(ghPath, mockGhScript, 'utf8')
  await chmod(ghPath, 0o755)

  const herdrPath = join(binDir, 'herdr')
  await writeFile(herdrPath, mockHerdrScript, 'utf8')
  await chmod(herdrPath, 0o755)

  return {
    binDir,
    ghStatePath,
    herdrStatePath,
    getGhState: async () => JSON.parse(await readFile(ghStatePath, 'utf8')) as MockGhState,
    getHerdrState: async () => JSON.parse(await readFile(herdrStatePath, 'utf8')) as MockHerdrState,
  }
}

function runDrovrCli(
  cwd: string,
  args: string[],
  binDir: string,
  ghStatePath: string,
  herdrStatePath: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [drovr, ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_STATE_FILE: ghStatePath,
        HERDR_STATE_FILE: herdrStatePath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error: unknown) {
    const execErr = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: typeof execErr.status === 'number' ? execErr.status : 1,
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
    }
  }
}

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('Issue #35: The core Workflow completes two Issues through visible Workers', () => {
  it('processes two Issues concurrently in isolated Worktrees, serializes scarce section, survives failure, and resumes cleanly without duplicate Workers', async () => {
    const repo = await initRepo()

    const { binDir, ghStatePath, herdrStatePath, getGhState, getHerdrState } =
      await setupMockCliEnvironment(repo, {
        defaultRepo: 'acme/widgets',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widgets',
            number: 101,
            title: 'First eligible task',
            body: 'Fix bug 101 in isolated worktree',
            url: 'https://github.com/acme/widgets/issues/101',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T00:00:00Z',
          },
          {
            repo: 'acme/widgets',
            number: 102,
            title: 'Second eligible task',
            body: 'Fix bug 102 in isolated worktree',
            url: 'https://github.com/acme/widgets/issues/102',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'bob' },
            createdAt: '2026-08-18T01:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

    await mkdir(join(repo, '.drovr'), { recursive: true })

    // Failure marker file: causes issue-102 to fail during the first run
    const failureMarkerPath = join(repo, '.drovr/fail-issue-102.flag')
    await writeFile(failureMarkerPath, 'fail\n', 'utf8')

    // Concurrency witness log for scarce section
    const witnessLogPath = join(repo, 'scarce-witness.log')
    await writeFile(witnessLogPath, '', 'utf8')

    const workflowContent = `import type { Drovr, Issue } from 'drovr'
import { existsSync } from 'node:fs'
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export default async function workflow(drovr: Drovr): Promise<void> {
  const rootDir = process.cwd()
  const freshIssues = await drovr.issues.list()

  const cachePath = join(rootDir, '.drovr/discovered-issues.json')
  let issuesToProcess: Issue[] = []
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'))
    const issueMap = new Map()
    for (const i of cached) issueMap.set(i.number, i)
    for (const i of freshIssues) issueMap.set(i.number, i)
    issuesToProcess = Array.from(issueMap.values())
  } catch {
    issuesToProcess = Array.from(freshIssues)
  }
  await writeFile(cachePath, JSON.stringify(issuesToProcess), 'utf8')

  // Declare scarce capacity-one resource
  const scarceResource = await drovr.resource('scarce-gate', { capacity: 1 })

  await drovr.map(
    issuesToProcess,
    { concurrency: 2, name: (issue) => 'issue-' + issue.number },
    async (issue) => {
      const name = 'issue-' + issue.number

      // 1. Claim issue
      await drovr.issues.claim(issue, { name })

      // 2. Prepare isolated Worktree
      const worktree = await drovr.worktree({ name })

      // 3. Start or reconnect visible Worker
      const worker = await drovr.start({ name, cwd: worktree.path })

      // 4. Send first sequential prompt
      await worker.prompt('investigate ' + name)

      // 5. Scarce capacity-one lease section
      await scarceResource.lease({ name }, async () => {
        const witnessPath = join(rootDir, 'scarce-witness.log')
        await appendFile(witnessPath, 'ENTER ' + name + ' ' + Date.now() + '\\n', 'utf8')

        // Apply observable Workflow effect inside the worktree
        const effectFilePath = join(worktree.path, 'artifact-' + name + '.txt')
        await appendFile(effectFilePath, 'progress for ' + name + '\\n', 'utf8')

        execFileSync('git', ['add', 'artifact-' + name + '.txt'], { cwd: worktree.path })
        execFileSync('git', ['commit', '-m', 'update artifact for ' + name], { cwd: worktree.path })
        // Microtask tick to ensure asynchronous event loop yield
        await Promise.resolve()
        await appendFile(witnessPath, 'EXIT ' + name + ' ' + Date.now() + '\\n', 'utf8')
      })

      // 6. Send second sequential prompt
      await worker.prompt('finalize ' + name)

      // 7. Check failure marker
      const flagPath = join(rootDir, '.drovr/fail-issue-102.flag')
      if (issue.number === 102 && existsSync(flagPath)) {
        throw new Error('Simulated failure in item issue-102')
      }

      // 8. Close Claimed Issue
      await drovr.issues.close(issue)
    }
  )
}
`
    await writeFile(join(repo, '.drovr/main.ts'), workflowContent, 'utf8')

    // =========================================================================
    // FIRST RUN (Fresh): Item 101 succeeds; Item 102 fails
    // =========================================================================
    const run1 = runDrovrCli(repo, ['start'], binDir, ghStatePath, herdrStatePath)
    expect(run1.status).toBe(1)
    expect(run1.stderr).toContain('Simulated failure in item issue-102')

    // --- Assert GitHub state after Run 1 ---
    const ghState1 = await getGhState()
    const issue101_afterRun1 = ghState1.issues?.find((i) => i.number === 101)
    const issue102_afterRun1 = ghState1.issues?.find((i) => i.number === 102)

    expect(issue101_afterRun1?.state).toBe('CLOSED')
    expect(issue101_afterRun1?.assignees).toEqual([{ login: 'drovr-bot' }])

    // Failed issue 102 remains OPEN and retains assignee (durable ownership preserved)
    expect(issue102_afterRun1?.state).toBe('OPEN')
    expect(issue102_afterRun1?.assignees).toEqual([{ login: 'drovr-bot' }])

    // --- Assert Git state after Run 1 ---
    // Start checkout branch remains unchanged on main
    const currentBranch = runGit(repo, ['branch', '--show-current'])
    expect(currentBranch).toBe('main')

    // Worktrees exist for both items
    const wtListOutput1 = runGit(repo, ['worktree', 'list'])
    expect(wtListOutput1).toContain(join(repo, '.worktrees/issue-101'))
    expect(wtListOutput1).toContain(join(repo, '.worktrees/issue-102'))

    // Worktree 101 contains committed artifact on branch drovr/issue-101
    const wt101Log = runGit(join(repo, '.worktrees/issue-101'), ['log', '-1', '--oneline'])
    expect(wt101Log).toContain('update artifact for issue-101')

    // Worktree 102 contains committed artifact on branch drovr/issue-102
    const wt102Log = runGit(join(repo, '.worktrees/issue-102'), ['log', '-1', '--oneline'])
    expect(wt102Log).toContain('update artifact for issue-102')

    // --- Assert Herdr state after Run 1 ---
    const herdrState1 = await getHerdrState()
    expect(herdrState1.workspaces).toHaveLength(2)
    expect(herdrState1.agents).toHaveLength(2)

    const agent101_run1 = herdrState1.agents?.find((a) => a.name === 'issue-101')
    const agent102_run1 = herdrState1.agents?.find((a) => a.name === 'issue-102')
    expect(agent101_run1?.prompts).toEqual(['investigate issue-101', 'finalize issue-101'])
    expect(agent102_run1?.prompts).toEqual(['investigate issue-102', 'finalize issue-102'])

    // --- Assert Scarce Resource Serialization ---
    const witnessLines1 = (await readFile(witnessLogPath, 'utf8'))
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    let currentOccupants = 0
    let maxOccupants = 0
    for (const line of witnessLines1) {
      if (line.startsWith('ENTER')) {
        currentOccupants++
        if (currentOccupants > maxOccupants) maxOccupants = currentOccupants
      } else if (line.startsWith('EXIT')) {
        currentOccupants--
      }
    }
    expect(maxOccupants).toBe(1)

    // --- Assert Semantic Logs after Run 1 ---
    const logContent1 = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
    const logLines1 = logContent1.trim().split('\n')

    expect(logLines1.some((l) => l.includes('INFO start.begin mode=fresh'))).toBe(true)
    expect(logLines1.some((l) => l.includes('INFO map.item.start name=issue-101'))).toBe(true)
    expect(logLines1.some((l) => l.includes('INFO map.item.start name=issue-102'))).toBe(true)
    expect(logLines1.some((l) => l.includes('INFO map.item.complete name=issue-101'))).toBe(true)
    expect(
      logLines1.some(
        (l) =>
          l.includes('ERROR map.item.fail name=issue-102') &&
          l.includes('Simulated failure in item issue-102'),
      ),
    ).toBe(true)
    expect(
      logLines1.some(
        (l) =>
          l.includes('ERROR start.fail mode=fresh') &&
          l.includes('started=2 skipped=0 completed=1 failed=1'),
      ),
    ).toBe(true)
    // =========================================================================
    // SECOND RUN (Resume): Replay unfinished issue-102, skip completed issue-101
    // =========================================================================
    // Disarm failure flag
    await unlink(failureMarkerPath)

    const run2 = runDrovrCli(repo, ['start', '--resume'], binDir, ghStatePath, herdrStatePath)
    expect(run2.status).toBe(0)

    // --- Assert GitHub state after Run 2 ---
    const ghState2 = await getGhState()
    const issue101_afterRun2 = ghState2.issues?.find((i) => i.number === 101)
    const issue102_afterRun2 = ghState2.issues?.find((i) => i.number === 102)

    expect(issue101_afterRun2?.state).toBe('CLOSED')
    expect(issue101_afterRun2?.assignees).toEqual([{ login: 'drovr-bot' }])
    expect(issue102_afterRun2?.state).toBe('CLOSED')
    expect(issue102_afterRun2?.assignees).toEqual([{ login: 'drovr-bot' }])

    // --- Assert Herdr state after Run 2 (no duplicate workspaces or agents) ---
    const herdrState2 = await getHerdrState()
    expect(herdrState2.workspaces).toHaveLength(2)
    expect(herdrState2.agents).toHaveLength(2)

    const agent101_run2 = herdrState2.agents?.find((a) => a.name === 'issue-101')
    const agent102_run2 = herdrState2.agents?.find((a) => a.name === 'issue-102')

    // issue-101 was skipped on resume -> not re-prompted
    expect(agent101_run2?.prompts).toEqual(['investigate issue-101', 'finalize issue-101'])

    // issue-102 reconnected the existing worker and received prompts
    expect(agent102_run2?.prompts).toEqual([
      'investigate issue-102',
      'finalize issue-102',
      'investigate issue-102',
      'finalize issue-102',
    ])

    // --- Assert Git state after Run 2 ---
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main')
    const artifact101 = await readFile(
      join(repo, '.worktrees/issue-101/artifact-issue-101.txt'),
      'utf8',
    )
    expect(artifact101).toContain('progress for issue-101')
    const artifact102 = await readFile(
      join(repo, '.worktrees/issue-102/artifact-issue-102.txt'),
      'utf8',
    )
    expect(artifact102).toContain('progress for issue-102')
    // --- Assert Semantic Logs after Run 2 ---
    const logContent2 = await readFile(join(repo, '.drovr/drovr.log'), 'utf8')
    const logLines2 = logContent2.trim().split('\n')
    const resumeLogLines = logLines2.slice(logLines1.length)

    expect(resumeLogLines.some((l) => l.includes('INFO start.begin mode=resume'))).toBe(true)
    expect(resumeLogLines.some((l) => l.includes('INFO map.item.skip name=issue-101'))).toBe(true)
    expect(resumeLogLines.some((l) => l.includes('INFO map.item.start name=issue-102'))).toBe(true)
    expect(resumeLogLines.some((l) => l.includes('INFO map.item.complete name=issue-102'))).toBe(
      true,
    )
    expect(
      resumeLogLines.some(
        (l) =>
          l.includes('INFO start.complete mode=resume') &&
          l.includes('started=1 skipped=1 completed=1 failed=0'),
      ),
    ).toBe(true)
  })

  it('serializes concurrent work across two Issues using Port Resource overlapping declarations', async () => {
    const repo = await initRepo()

    const { binDir, ghStatePath, herdrStatePath, getGhState, getHerdrState } =
      await setupMockCliEnvironment(repo, {
        defaultRepo: 'acme/widgets',
        currentUser: 'drovr-bot',
        issues: [
          {
            repo: 'acme/widgets',
            number: 201,
            title: 'Port consumer task A',
            body: 'Run server on port 9090',
            url: 'https://github.com/acme/widgets/issues/201',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'alice' },
            createdAt: '2026-08-18T00:00:00Z',
            updatedAt: '2026-08-18T00:00:00Z',
          },
          {
            repo: 'acme/widgets',
            number: 202,
            title: 'Port consumer task B',
            body: 'Run server on port 9090',
            url: 'https://github.com/acme/widgets/issues/202',
            state: 'OPEN',
            labels: [{ name: 'ready-for-agent' }],
            assignees: [],
            author: { login: 'bob' },
            createdAt: '2026-08-18T01:00:00Z',
            updatedAt: '2026-08-18T01:00:00Z',
          },
        ],
      })

    await mkdir(join(repo, '.drovr'), { recursive: true })

    const portWitnessLog = join(repo, 'port-witness.log')
    await writeFile(portWitnessLog, '', 'utf8')

    const workflowContent = `import type { Drovr } from 'drovr'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

export default async function workflow(drovr: Drovr): Promise<void> {
  const rootDir = process.cwd()
  const issues = await drovr.issues.list()

  // Declare port resource on 9090-9091 (capacity 1)
  const portResource = await drovr.resource('web-ports', { ports: [9090, 9091] })

  await drovr.map(
    issues,
    { concurrency: 2, name: (issue) => 'issue-' + issue.number },
    async (issue) => {
      const name = 'issue-' + issue.number
      await drovr.issues.claim(issue, { name })
      const worktree = await drovr.worktree({ name })
      const worker = await drovr.start({ name, cwd: worktree.path })

      await worker.prompt('prepare port task ' + name)

      await portResource.lease({ name }, async () => {
        const witness = join(rootDir, 'port-witness.log')
        await appendFile(witness, 'ENTER ' + name + ' ' + Date.now() + '\\n', 'utf8')
        await Promise.resolve()
        await appendFile(witness, 'EXIT ' + name + ' ' + Date.now() + '\\n', 'utf8')
      })

      await worker.prompt('cleanup port task ' + name)
      await drovr.issues.close(issue)
    }
  )
}
`
    await writeFile(join(repo, '.drovr/main.ts'), workflowContent, 'utf8')

    const res = runDrovrCli(repo, ['start'], binDir, ghStatePath, herdrStatePath)
    expect(res.status).toBe(0)

    const ghState = await getGhState()
    expect(ghState.issues?.every((i) => i.state === 'CLOSED')).toBe(true)

    const herdrState = await getHerdrState()
    expect(herdrState.workspaces).toHaveLength(2)
    expect(herdrState.agents).toHaveLength(2)

    // Verify port serialization (maximum simultaneous occupants was 1)
    const witnessLines = (await readFile(portWitnessLog, 'utf8'))
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    let currentOccupants = 0
    let maxOccupants = 0
    for (const line of witnessLines) {
      if (line.startsWith('ENTER')) {
        currentOccupants++
        if (currentOccupants > maxOccupants) maxOccupants = currentOccupants
      } else if (line.startsWith('EXIT')) {
        currentOccupants--
      }
    }
    expect(maxOccupants).toBe(1)
  })
})
