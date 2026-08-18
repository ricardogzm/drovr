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
  const dir = await mkdtemp(join(tmpdir(), 'drovr-worker-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  await writeFile(join(dir, 'README.md'), '# test\n', 'utf8')
  runGit(dir, ['add', 'README.md'])
  runGit(dir, ['commit', '-m', 'init'])
  return dir
}
function extractExecError(err: unknown): { status?: number; stderr: string } {
  if (typeof err === 'object' && err !== null) {
    const status = 'status' in err && typeof err.status === 'number' ? err.status : undefined
    const stderr =
      'stderr' in err && typeof err.stderr === 'string'
        ? err.stderr
        : 'stderr' in err && err.stderr instanceof Buffer
          ? err.stderr.toString('utf8')
          : ''
    return { status, stderr }
  }
  return { stderr: '' }
}

interface MockHerdrWorkspace {
  workspace_id: string
  cwd: string
  label?: string
  focused: boolean
  pane_count: number
  tab_count: number
  active_tab_id: string
  agent_status: string
  root_pane: { pane_id: string }
  tab: { tab_id: string }
}

interface MockHerdrAgent {
  name: string
  kind: string
  pane_id: string
  workspace_id: string
  tab_id: string
  agent_status: string
  cwd: string
  argv: string[]
}

interface MockHerdrInvocation {
  command: string
  args: string[]
  timestamp: number
}

interface MockHerdrState {
  workspaces?: MockHerdrWorkspace[]
  agents?: MockHerdrAgent[]
  invocations?: MockHerdrInvocation[]
  failNextWorkspaceCreate?: boolean | string
  failNextAgentStart?: boolean | string
  failAgentStartForName?: Record<string, string>
  nextWorkspaceNum?: number
}

async function setupMockHerdr(
  dir: string,
  initialState: MockHerdrState = {},
): Promise<{ binDir: string; statePath: string }> {
  const binDir = join(dir, '.mock-bin')
  await mkdir(binDir, { recursive: true })
  const statePath = join(dir, 'mock-herdr-state.json')
  const defaultState: MockHerdrState = {
    workspaces: [],
    agents: [],
    invocations: [],
    nextWorkspaceNum: 1,
    ...initialState,
  }
  await writeFile(statePath, JSON.stringify(defaultState, null, 2), 'utf8')

  const mockHerdrScript = `#!/usr/bin/env node
const fs = require('node:fs')

const statePath = process.env.HERDR_STATE_FILE
if (!statePath || !fs.existsSync(statePath)) {
  console.error('HERDR_STATE_FILE not found')
  process.exit(1)
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
if (!state.workspaces) state.workspaces = []
if (!state.agents) state.agents = []
if (!state.invocations) state.invocations = []
if (!state.nextWorkspaceNum) state.nextWorkspaceNum = 1

const args = process.argv.slice(2)
state.invocations.push({
  command: args[0] || '',
  args: args.slice(1),
  timestamp: Date.now(),
})

function saveState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

// Subcommand: herdr workspace create [OPTIONS]
if (args[0] === 'workspace' && args[1] === 'create') {
  if (state.failNextWorkspaceCreate) {
    const msg = typeof state.failNextWorkspaceCreate === 'string' ? state.failNextWorkspaceCreate : 'Simulated workspace create error'
    state.failNextWorkspaceCreate = false
    saveState()
    console.error(msg)
    process.exit(1)
  }

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

  const ws = {
    workspace_id: wsId,
    cwd,
    label,
    focused,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: tabId,
    agent_status: 'unknown',
    root_pane: { pane_id: paneId },
    tab: { tab_id: tabId }
  }

  state.workspaces.push(ws)
  saveState()

  console.log(JSON.stringify({
    id: 'req-' + num,
    result: {
      type: 'workspace_created',
      workspace: {
        workspace_id: wsId,
        cwd,
        label,
        focused
      },
      tab: {
        tab_id: tabId
      },
      root_pane: {
        pane_id: paneId
      }
    }
  }))
  process.exit(0)
}

// Subcommand: herdr workspace close <workspace_id>
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
  // Also clean up agents in that workspace
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

// Subcommand: herdr workspace list
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

// Subcommand: herdr agent start <NAME> --kind <KIND> --pane <PANE_ID> [-- ...]
if (args[0] === 'agent' && args[1] === 'start') {
  const name = args[2]
  if (!name) {
    console.error('missing agent name')
    process.exit(1)
  }

  if (state.failAgentStartForName && state.failAgentStartForName[name]) {
    const msg = state.failAgentStartForName[name]
    delete state.failAgentStartForName[name]
    saveState()
    console.error(msg)
    process.exit(1)
  }

  if (state.failNextAgentStart) {
    const msg = typeof state.failNextAgentStart === 'string' ? state.failNextAgentStart : 'Simulated agent start error'
    state.failNextAgentStart = false
    saveState()
    console.error(msg)
    process.exit(1)
  }

  // Same-Name uniqueness among live agents
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

  const ws = state.workspaces.find((w) => w.root_pane && w.root_pane.pane_id === paneId)

  const agentRecord = {
    name,
    kind,
    pane_id: paneId,
    workspace_id: ws ? ws.workspace_id : 'unknown',
    tab_id: ws ? ws.active_tab_id : 'unknown',
    agent_status: 'idle',
    cwd: ws ? ws.cwd : process.cwd(),
    argv: ompArgs
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

// Subcommand: herdr agent get <name>
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

// Subcommand: herdr agent list
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

console.error('unknown mock herdr command:', args.join(' '))
process.exit(1)
`

  const herdrPath = join(binDir, 'herdr')
  await writeFile(herdrPath, mockHerdrScript, 'utf8')
  await chmod(herdrPath, 0o755)

  return { binDir, statePath }
}

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('Issue #30: A visible Worker starts in its Worktree', () => {
  it('starts one visible OMP Worker in an unfocused workspace rooted at the Worktree without resume flags', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-a' })
  const worker = await drovr.start({ name: 'worker-a', cwd: wt.path })
  if (!worker || typeof worker.prompt !== 'function') {
    throw new Error('invalid worker handle returned')
  }
}
`,
      'utf8',
    )

    execFileSync(process.execPath, [drovr, 'start'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
        HERDR_ENV: undefined,
      },
    })

    const finalState: MockHerdrState = JSON.parse(await readFile(statePath, 'utf8'))

    // 1. One workspace was created
    expect(finalState.workspaces).toHaveLength(1)
    const ws = finalState.workspaces![0]
    expect(ws.cwd).toBe(join(dir, '.worktrees/worker-a'))
    expect(ws.label).toBe('worker-a')
    expect(ws.focused).toBe(false)

    // 2. One OMP agent was started in root pane
    expect(finalState.agents).toHaveLength(1)
    const agent = finalState.agents![0]
    expect(agent.name).toBe('worker-a')
    expect(agent.kind).toBe('omp')
    expect(agent.pane_id).toBe(ws.root_pane.pane_id)
    expect(agent.workspace_id).toBe(ws.workspace_id)
    expect(agent.argv).toEqual([]) // No continue or resume flags

    // 3. Drovr controlled Worker creation only through Herdr workspace and agent commands
    // No OMP RPC, no raw pane input, no Herdr worktree creation
    const invokedCommands = finalState.invocations!.map((inv) =>
      `${inv.command} ${inv.args[0] || ''}`.trim(),
    )
    expect(invokedCommands).toContain('workspace create')
    expect(invokedCommands).toContain('agent start')
    expect(invokedCommands.some((c) => c.startsWith('worktree'))).toBe(false)
    expect(invokedCommands.some((c) => c.startsWith('pane'))).toBe(false)

    await rm(dir, { recursive: true, force: true })
  })

  it('validates start options, Name grammar, and cwd inputs synchronously before Herdr mutation', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  // Test invalid options
  try {
    const startFn = drovr.start
    await Reflect.apply(startFn, drovr, [null])
    throw new Error('should have thrown for null opts')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('options must be an object')) throw err
  }

  // Test invalid Name (uppercase)
  try {
    await drovr.start({ name: 'InvalidName', cwd: '/tmp' })
    throw new Error('should have thrown for uppercase Name')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('Invalid name')) throw err
  }

  // Test invalid Name (starts with number)
  try {
    await drovr.start({ name: '1worker', cwd: '/tmp' })
    throw new Error('should have thrown for number-leading Name')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('Invalid name')) throw err
  }

  // Test invalid cwd
  try {
    await drovr.start({ name: 'valid-name', cwd: '' })
    throw new Error('should have thrown for empty cwd')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('cwd must be a non-empty string')) throw err
  }
}
`,
      'utf8',
    )

    execFileSync(process.execPath, [drovr, 'start'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })

    const finalState: MockHerdrState = JSON.parse(await readFile(statePath, 'utf8'))
    expect(finalState.invocations).toHaveLength(0)

    await rm(dir, { recursive: true, force: true })
  })

  it('closes only the attempt-created workspace on Worker-start failure and fails only the map item', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir, {
      failAgentStartForName: {
        'item-b': 'Simulated OMP startup crash in pane w2:p1',
      },
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const items = [
    { id: 1, name: 'item-a' },
    { id: 2, name: 'item-b' },
  ]

  await drovr.map(items, { concurrency: 2, name: (i) => i.name }, async (item) => {
    const wt = await drovr.worktree({ name: item.name })
    await drovr.start({ name: item.name, cwd: wt.path })
  })
}
`,
      'utf8',
    )

    let caughtError: unknown
    try {
      execFileSync(process.execPath, [drovr, 'start'], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          HERDR_STATE_FILE: statePath,
        },
      })
    } catch (err: unknown) {
      caughtError = err
    }

    const errInfo = extractExecError(caughtError)
    expect(errInfo.status).toBe(1)
    expect(errInfo.stderr).toContain('Simulated OMP startup crash')

    const finalState: MockHerdrState = JSON.parse(await readFile(statePath, 'utf8'))

    // item-a succeeded: its workspace and agent remain
    expect(finalState.agents).toHaveLength(1)
    expect(finalState.agents![0].name).toBe('item-a')

    expect(finalState.workspaces).toHaveLength(1)
    expect(finalState.workspaces![0].label).toBe('item-a')

    // item-b's attempt-created workspace was closed upon failure
    const closedCalls = finalState.invocations!.filter(
      (inv) => inv.command === 'workspace' && inv.args[0] === 'close',
    )
    expect(closedCalls).toHaveLength(1)
    const closedWorkspaceId = closedCalls[0].args[1]
    expect(closedWorkspaceId).toBeDefined()
    expect(closedWorkspaceId).not.toBe(finalState.workspaces![0].workspace_id)
    await rm(dir, { recursive: true, force: true })
  })

  it('produces one winner and an explicit loser failure upon concurrent creation of the same Name', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'same-name' })

  // Run two start calls concurrently with the same Name
  const results = await Promise.allSettled([
    drovr.start({ name: 'same-name', cwd: wt.path }),
    drovr.start({ name: 'same-name', cwd: wt.path }),
  ])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  if (fulfilled.length !== 1 || rejected.length !== 1) {
    throw new Error('Expected exactly 1 winner and 1 loser, got: ' + JSON.stringify(results))
  }

  const firstRejected = rejected[0]
  const loserError = firstRejected && 'reason' in firstRejected ? firstRejected.reason : undefined
  if (!loserError || !String(loserError.message || loserError).includes('already exists')) {
    throw new Error('Expected explicit loser error about agent already existing, got: ' + loserError)
  }
}
`,
      'utf8',
    )

    execFileSync(process.execPath, [drovr, 'start'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })

    const finalState: MockHerdrState = JSON.parse(await readFile(statePath, 'utf8'))

    // Only the winner's workspace and agent remain
    expect(finalState.agents).toHaveLength(1)
    expect(finalState.agents![0].name).toBe('same-name')

    expect(finalState.workspaces).toHaveLength(1)
    expect(finalState.workspaces![0].label).toBe('same-name')

    // The loser's attempt-created workspace was closed
    const closedCalls = finalState.invocations!.filter(
      (inv) => inv.command === 'workspace' && inv.args[0] === 'close',
    )
    expect(closedCalls).toHaveLength(1)

    await rm(dir, { recursive: true, force: true })
  })

  it('ensures successful Worker panes and workspaces survive Workflow and CLI exit', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'surviving-worker' })
  await drovr.start({ name: 'surviving-worker', cwd: wt.path })
  // Workflow completes here
}
`,
      'utf8',
    )

    // Run CLI to completion
    execFileSync(process.execPath, [drovr, 'start'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })

    // After CLI exit (status 0), inspect external Herdr state
    const finalState: MockHerdrState = JSON.parse(await readFile(statePath, 'utf8'))

    // Workspaces and agent are still alive
    expect(finalState.workspaces).toHaveLength(1)
    expect(finalState.workspaces![0].label).toBe('surviving-worker')
    expect(finalState.agents).toHaveLength(1)
    expect(finalState.agents![0].name).toBe('surviving-worker')

    // No workspace close or agent kill commands were called
    const closeCalls = finalState.invocations!.filter(
      (inv) => inv.command === 'workspace' && inv.args[0] === 'close',
    )
    expect(closeCalls).toHaveLength(0)

    await rm(dir, { recursive: true, force: true })
  })
  it('starts multiple Workers concurrently across map items each in its own Worktree workspace', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const items = [
    { id: 1, name: 'worker-1' },
    { id: 2, name: 'worker-2' },
    { id: 3, name: 'worker-3' },
  ]

  await drovr.map(items, { concurrency: 3, name: (i) => i.name }, async (item) => {
    const wt = await drovr.worktree({ name: item.name })
    const worker = await drovr.start({ name: item.name, cwd: wt.path })
    if (!worker) throw new Error('no worker')
  })
}
`,
      'utf8',
    )

    execFileSync(process.execPath, [drovr, 'start'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })

    const finalState: MockHerdrState = JSON.parse(await readFile(statePath, 'utf8'))

    expect(finalState.workspaces).toHaveLength(3)
    expect(finalState.agents).toHaveLength(3)

    const wsLabels = finalState
      .workspaces!.map((w) => w.label || '')
      .sort((a, b) => a.localeCompare(b))
    expect(wsLabels).toEqual(['worker-1', 'worker-2', 'worker-3'])

    const agentNames = finalState.agents!.map((a) => a.name).sort((a, b) => a.localeCompare(b))
    expect(agentNames).toEqual(['worker-1', 'worker-2', 'worker-3'])

    for (const agent of finalState.agents!) {
      const matchingWs = finalState.workspaces!.find((w) => w.label === agent.name)
      expect(matchingWs).toBeDefined()
      expect(agent.pane_id).toBe(matchingWs!.root_pane.pane_id)
      expect(agent.cwd).toBe(join(dir, '.worktrees', agent.name))
      expect(agent.argv).toEqual([])
    }

    await rm(dir, { recursive: true, force: true })
  })

  it('fails map item without calling workspace close when workspace creation itself fails', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir, {
      failNextWorkspaceCreate: 'Simulated socket connection error during workspace creation',
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'fail-ws' })
  await drovr.start({ name: 'fail-ws', cwd: wt.path })
}
`,
      'utf8',
    )

    let caughtError: unknown
    try {
      execFileSync(process.execPath, [drovr, 'start'], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          HERDR_STATE_FILE: statePath,
        },
      })
    } catch (err: unknown) {
      caughtError = err
    }

    const errInfo = extractExecError(caughtError)
    expect(errInfo.status).toBe(1)
    expect(errInfo.stderr).toContain('Simulated socket connection error during workspace creation')

    const finalState: MockHerdrState = JSON.parse(await readFile(statePath, 'utf8'))
    expect(finalState.workspaces).toHaveLength(0)
    expect(finalState.agents).toHaveLength(0)

    const closeCalls = finalState.invocations!.filter(
      (inv) => inv.command === 'workspace' && inv.args[0] === 'close',
    )
    expect(closeCalls).toHaveLength(0)

    await rm(dir, { recursive: true, force: true })
  })

  it('returns a Worker handle whose prompt method throws not implemented', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-prompt' })
  const worker = await drovr.start({ name: 'worker-prompt', cwd: wt.path })
  try {
    await worker.prompt('hello')
    throw new Error('should not succeed')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('prompt is not implemented yet')) {
      throw err
    }
  }
}
`,
      'utf8',
    )

    const output = execFileSync(process.execPath, [drovr, 'start'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })

    expect(output).toBeDefined()
    await rm(dir, { recursive: true, force: true })
  })
})
