import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { openProjectDatabase } from '../src/db'

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
  number: number
  label?: string
  focused: boolean
  pane_count: number
  tab_count: number
  active_tab_id: string
  agent_status: string
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

interface MockHerdrState {
  workspaces?: MockHerdrWorkspace[]
  panes?: MockHerdrPane[]
  agents?: MockHerdrAgent[]
  failNextWorkspaceCreate?: boolean | string
  failWorkspaceCreateForName?: Record<string, string>
  malformedNextWorkspaceCreate?: boolean | string
  failNextAgentStart?: boolean | string
  failAgentStartForName?: Record<string, string>
  failNextAgentPrompt?: boolean | string
  failAgentPromptForName?: Record<string, string>
  stallAgentPromptForName?: Record<string, boolean | string>
  blockAgentOnPrompt?: Record<string, { unblockFile?: string }>
  unknownAgentOnPrompt?: Record<string, { unblockFile?: string }>
  failNextAgentWait?: boolean | string
  failAgentWaitForName?: Record<string, string>
  stallAgentWaitForName?: Record<string, boolean | string>
  blockAgentOnWait?: Record<string, { unblockFile?: string }>
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
    panes: [],
    agents: [],
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
if (!state.panes) state.panes = []
if (!state.agents) state.agents = []
if (!state.nextWorkspaceNum) state.nextWorkspaceNum = 1

const args = process.argv.slice(2)

function saveState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

// Reject forbidden Herdr Worktree commands
if (args[0] === 'worktree') {
  console.error('error: forbidden Herdr command: worktree')
  process.exit(1)
}

// Reject forbidden raw pane commands
if (args[0] === 'pane') {
  console.error('error: forbidden Herdr command: pane')
  process.exit(1)
}

// Subcommand: herdr workspace create [OPTIONS]
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

  if (label && state.failWorkspaceCreateForName && state.failWorkspaceCreateForName[label]) {
    const msg = state.failWorkspaceCreateForName[label]
    delete state.failWorkspaceCreateForName[label]
    saveState()
    console.error(msg)
    process.exit(1)
  }

  if (state.failNextWorkspaceCreate) {
    const msg = typeof state.failNextWorkspaceCreate === 'string' ? state.failNextWorkspaceCreate : 'Simulated workspace create error'
    state.failNextWorkspaceCreate = false
    saveState()
    console.error(msg)
    process.exit(1)
  }

  if (state.malformedNextWorkspaceCreate) {
    const rawOut = typeof state.malformedNextWorkspaceCreate === 'string' ? state.malformedNextWorkspaceCreate : 'RAW_MALFORMED_OUTPUT'
    state.malformedNextWorkspaceCreate = false
    saveState()
    console.log(rawOut)
    process.exit(0)
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
    focused: true,
    pane_count: 1,
    agent_status: 'unknown'
  }

  const rootPane = {
    pane_id: paneId,
    terminal_id: termId,
    workspace_id: wsId,
    tab_id: tabId,
    focused: true,
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
      tab: tab,
      root_pane: rootPane
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
  // Also clean up panes and agents in that workspace
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

  // Reject forbidden continue/resume or RPC mode flags
  for (const arg of ompArgs) {
    if (['-r', '--resume', '-c', '--continue', '--mode', 'rpc', 'rpc-ui'].includes(arg)) {
      console.error('error: forbidden agent start argument: ' + arg)
      process.exit(1)
    }
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
    foreground_cwd: pane ? pane.cwd : process.cwd()
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
// Subcommand: herdr agent prompt <TARGET> <TEXT> [OPTIONS]
if (args[0] === 'agent' && args[1] === 'prompt') {
  const target = args[2]
  const text = args[3]
  if (!target) {
    console.error('missing agent target')
    process.exit(1)
  }
  if (text === undefined) {
    console.error('missing prompt text')
    process.exit(1)
  }

  if (state.failAgentPromptForName && state.failAgentPromptForName[target]) {
    const msg = state.failAgentPromptForName[target]
    delete state.failAgentPromptForName[target]
    saveState()
    console.error(msg)
    process.exit(1)
  }

  if (state.failNextAgentPrompt) {
    const msg = typeof state.failNextAgentPrompt === 'string' ? state.failNextAgentPrompt : 'Simulated agent prompt error'
    state.failNextAgentPrompt = false
    saveState()
    console.error(msg)
    process.exit(1)
  }

  if (state.stallAgentPromptForName && state.stallAgentPromptForName[target]) {
    const stallVal = state.stallAgentPromptForName[target]
    delete state.stallAgentPromptForName[target]
    saveState()
    const msg = typeof stallVal === 'string' ? stallVal : 'agent_prompt_stalled: prompt submission did not observe a state change within 5000ms'
    console.error(msg)
    process.exit(1)
  }

  const agent = state.agents.find((a) => a.name === target)
  if (!agent) {
    console.error('agent not found: ' + target)
    process.exit(1)
  }

  if (!agent.prompts) {
    agent.prompts = []
  }
  agent.prompts.push(text)

  let wait = false
  const until = []
  let timeout = undefined

  for (let i = 4; i < args.length; i++) {
    if (args[i] === '--wait') {
      wait = true
    } else if (args[i] === '--until' && args[i + 1]) {
      until.push(args[++i])
    } else if (args[i] === '--timeout' && args[i + 1]) {
      timeout = parseInt(args[++i], 10)
    }
  }

  if (timeout !== undefined) {
    console.error('error: unexpected --timeout flag passed to agent prompt: ' + timeout)
    process.exit(1)
  }

  const targetStates = until.length > 0 ? until : ['idle', 'done', 'blocked']

  if (state.blockAgentOnPrompt && state.blockAgentOnPrompt[target]) {
    agent.agent_status = 'blocked'
    saveState()

    if (wait && !targetStates.includes('blocked')) {
      const unblockFile = state.blockAgentOnPrompt[target].unblockFile
      if (unblockFile) {
        while (!fs.existsSync(unblockFile)) {
          const curState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
          const curAgent = curState.agents && curState.agents.find((a) => a.name === target)
          if (curAgent && curAgent.agent_status !== 'blocked') {
            break
          }
          const waitUntil = Date.now() + 20
          while (Date.now() < waitUntil) {}
        }
      }
      agent.agent_status = 'idle'
      saveState()
    }
  } else if (state.unknownAgentOnPrompt && state.unknownAgentOnPrompt[target]) {
    agent.agent_status = 'unknown'
    saveState()

    if (wait && !targetStates.includes('unknown')) {
      const unblockFile = state.unknownAgentOnPrompt[target].unblockFile
      if (unblockFile) {
        while (!fs.existsSync(unblockFile)) {
          const curState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
          const curAgent = curState.agents && curState.agents.find((a) => a.name === target)
          if (curAgent && curAgent.agent_status !== 'unknown') {
            break
          }
          const waitUntil = Date.now() + 20
          while (Date.now() < waitUntil) {}
        }
      }
      agent.agent_status = 'idle'
      saveState()
    }
  } else {
    agent.agent_status = 'idle'
    saveState()
  }

  console.log(JSON.stringify({
    id: 'req-agent-prompt',
    result: {
      type: 'agent_prompted',
      agent
    }
  }))
  process.exit(0)
}
// Subcommand: herdr agent wait <TARGET> [OPTIONS]
if (args[0] === 'agent' && args[1] === 'wait') {
  const target = args[2]
  if (!target) {
    console.error('missing agent target')
    process.exit(1)
  }

  if (state.failAgentWaitForName && state.failAgentWaitForName[target]) {
    const msg = state.failAgentWaitForName[target]
    delete state.failAgentWaitForName[target]
    saveState()
    console.error(msg)
    process.exit(1)
  }

  if (state.failNextAgentWait) {
    const msg = typeof state.failNextAgentWait === 'string' ? state.failNextAgentWait : 'Simulated agent wait error'
    state.failNextAgentWait = false
    saveState()
    console.error(msg)
    process.exit(1)
  }

  if (state.stallAgentWaitForName && state.stallAgentWaitForName[target]) {
    const stallVal = state.stallAgentWaitForName[target]
    delete state.stallAgentWaitForName[target]
    saveState()
    const msg = typeof stallVal === 'string' ? stallVal : 'agent_prompt_stalled: wait did not observe a state change within 5000ms'
    console.error(msg)
    process.exit(1)
  }

  const agent = state.agents.find((a) => a.name === target)
  if (!agent) {
    console.error('agent not found: ' + target)
    process.exit(1)
  }

  const until = []
  let timeout = undefined

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--until' && args[i + 1]) {
      until.push(args[++i])
    } else if (args[i] === '--timeout' && args[i + 1]) {
      timeout = parseInt(args[++i], 10)
    }
  }

  if (timeout !== undefined) {
    console.error('error: unexpected --timeout flag passed to agent wait: ' + timeout)
    process.exit(1)
  }

  const targetStates = until.length > 0 ? until : ['idle', 'done']

  if (state.blockAgentOnWait && state.blockAgentOnWait[target]) {
    const unblockFile = state.blockAgentOnWait[target].unblockFile
    if (unblockFile) {
      while (!fs.existsSync(unblockFile)) {
        const curState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        const curAgent = curState.agents && curState.agents.find((a) => a.name === target)
        if (curAgent && targetStates.includes(curAgent.agent_status)) {
          break
        }
        const waitUntil = Date.now() + 20
        while (Date.now() < waitUntil) {}
      }
    }
    agent.agent_status = 'idle'
    saveState()
  } else {
    agent.agent_status = 'idle'
    saveState()
  }

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

  const herdrPath = join(binDir, 'herdr')
  await writeFile(herdrPath, mockHerdrScript, 'utf8')
  await chmod(herdrPath, 0o755)

  return { binDir, statePath }
}

function listHerdrWorkspaces(binDir: string, statePath: string): MockHerdrWorkspace[] {
  const output = execFileSync('herdr', ['workspace', 'list'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HERDR_STATE_FILE: statePath,
    },
  })
  const parsed = JSON.parse(output) as {
    result?: { workspaces?: MockHerdrWorkspace[] }
    workspaces?: MockHerdrWorkspace[]
  }
  return parsed.result?.workspaces ?? parsed.workspaces ?? []
}

function listHerdrAgents(binDir: string, statePath: string): MockHerdrAgent[] {
  const output = execFileSync('herdr', ['agent', 'list'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HERDR_STATE_FILE: statePath,
    },
  })
  const parsed = JSON.parse(output) as {
    result?: { agents?: MockHerdrAgent[] }
    agents?: MockHerdrAgent[]
  }
  return parsed.result?.agents ?? parsed.agents ?? []
}

function getHerdrAgent(binDir: string, statePath: string, name: string): MockHerdrAgent | null {
  try {
    const output = execFileSync('herdr', ['agent', 'get', name], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })
    const parsed = JSON.parse(output) as {
      result?: { agent?: MockHerdrAgent }
      agent?: MockHerdrAgent
    }
    return parsed.result?.agent ?? parsed.agent ?? null
  } catch {
    return null
  }
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

    // Observe external Herdr state through herdr workspace list and herdr agent list
    const workspaces = listHerdrWorkspaces(binDir, statePath)
    expect(workspaces).toHaveLength(1)
    const ws = workspaces[0]
    expect(ws.label).toBe('worker-a')
    expect(ws.focused).toBe(false)
    expect(ws.pane_count).toBe(1)

    const agents = listHerdrAgents(binDir, statePath)
    expect(agents).toHaveLength(1)
    const agent = agents[0]
    expect(agent.name).toBe('worker-a')
    expect(agent.agent).toBe('omp')
    expect(agent.workspace_id).toBe(ws.workspace_id)
    expect(agent.cwd).toBe(join(dir, '.worktrees/worker-a'))
    expect(agent.agent_status).toBe('idle')

    const singleAgent = getHerdrAgent(binDir, statePath, 'worker-a')
    expect(singleAgent).toBeDefined()
    expect(singleAgent?.name).toBe('worker-a')
    expect(singleAgent?.agent).toBe('omp')
    expect(singleAgent?.cwd).toBe(join(dir, '.worktrees/worker-a'))

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

    expect(listHerdrWorkspaces(binDir, statePath)).toHaveLength(0)
    expect(listHerdrAgents(binDir, statePath)).toHaveLength(0)

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

    // item-a succeeded: its workspace and agent remain in Herdr
    const workspaces = listHerdrWorkspaces(binDir, statePath)
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].label).toBe('item-a')

    const agents = listHerdrAgents(binDir, statePath)
    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe('item-a')
    expect(agents[0].cwd).toBe(join(dir, '.worktrees/item-a'))

    // item-b's agent does not exist and its attempt-created workspace was closed
    expect(getHerdrAgent(binDir, statePath, 'item-b')).toBeNull()

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
  if (!loserError || (!String(loserError.message || loserError).includes('already exists') && !String(loserError.message || loserError).includes('herdr agent start failed'))) {
    throw new Error('Expected explicit loser error about agent start failure, got: ' + loserError)
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

    // Exactly one winner workspace and agent remain in Herdr
    const workspaces = listHerdrWorkspaces(binDir, statePath)
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].label).toBe('same-name')

    const agents = listHerdrAgents(binDir, statePath)
    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe('same-name')
    expect(agents[0].cwd).toBe(join(dir, '.worktrees/same-name'))

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

    // After CLI exit (status 0), query Herdr state via CLI
    const workspaces = listHerdrWorkspaces(binDir, statePath)
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].label).toBe('surviving-worker')

    const agents = listHerdrAgents(binDir, statePath)
    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe('surviving-worker')
    expect(agents[0].cwd).toBe(join(dir, '.worktrees/surviving-worker'))

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

    const workspaces = listHerdrWorkspaces(binDir, statePath)
    expect(workspaces).toHaveLength(3)

    const agents = listHerdrAgents(binDir, statePath)
    expect(agents).toHaveLength(3)

    const wsLabels = workspaces.map((w) => w.label || '').sort((a, b) => a.localeCompare(b))
    expect(wsLabels).toEqual(['worker-1', 'worker-2', 'worker-3'])

    const agentNames = agents.map((a) => a.name).sort((a, b) => a.localeCompare(b))
    expect(agentNames).toEqual(['worker-1', 'worker-2', 'worker-3'])

    for (const agent of agents) {
      const matchingWs = workspaces.find((w) => w.label === agent.name)
      expect(matchingWs).toBeDefined()
      expect(agent.workspace_id).toBe(matchingWs!.workspace_id)
      expect(agent.cwd).toBe(join(dir, '.worktrees', agent.name))
      expect(agent.agent).toBe('omp')
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

    expect(listHerdrWorkspaces(binDir, statePath)).toHaveLength(0)
    expect(listHerdrAgents(binDir, statePath)).toHaveLength(0)

    await rm(dir, { recursive: true, force: true })
  })
})
describe('Issue #31: Worker prompts remain sequential and visible', () => {
  it('sends prompt text through Herdr, waits without Drovr timeout for idle or done, and returns no transcript', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-prompt-single' })
  const worker = await drovr.start({ name: 'worker-prompt-single', cwd: wt.path })
  const res = await worker.prompt('Implement issue #42')
  if (res !== undefined) {
    throw new Error('Expected prompt to return undefined (no transcript), got: ' + JSON.stringify(res))
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

    const agent = getHerdrAgent(binDir, statePath, 'worker-prompt-single')
    expect(agent).toBeDefined()
    expect(agent?.prompts).toEqual(['Implement issue #42'])
    expect(agent?.agent_status).toBe('idle')

    await rm(dir, { recursive: true, force: true })
  })

  it('completes two sequential prompts on one Worker in order and returns no transcript', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-seq' })
  const worker = await drovr.start({ name: 'worker-seq', cwd: wt.path })
  const res1 = await worker.prompt('turn 1: initial changes')
  const res2 = await worker.prompt('turn 2: follow-up tests')
  if (res1 !== undefined || res2 !== undefined) {
    throw new Error('Expected no transcript, got res1=' + res1 + ' res2=' + res2)
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

    const agent = getHerdrAgent(binDir, statePath, 'worker-seq')
    expect(agent).toBeDefined()
    expect(agent?.prompts).toEqual(['turn 1: initial changes', 'turn 2: follow-up tests'])
    expect(agent?.agent_status).toBe('idle')

    await rm(dir, { recursive: true, force: true })
  })

  it('rejects a second overlapping prompt on the same Name without double-submitting', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-overlap' })
  const worker = await drovr.start({ name: 'worker-overlap', cwd: wt.path })

  const results = await Promise.allSettled([
    worker.prompt('prompt 1'),
    worker.prompt('prompt 2'),
  ])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  if (fulfilled.length !== 1 || rejected.length !== 1) {
    throw new Error('Expected exactly 1 fulfilled and 1 rejected prompt, got: ' + JSON.stringify(results))
  }

  const reason = (rejected[0] as PromiseRejectedResult).reason
  const msg = reason instanceof Error ? reason.message : String(reason)
  if (!msg.toLowerCase().includes('already') && !msg.toLowerCase().includes('overlap') && !msg.toLowerCase().includes('progress')) {
    throw new Error('Expected overlapping prompt error, got: ' + msg)
  }

  // Subsequent sequential prompt should now succeed (prompt lock is freed)
  await worker.prompt('prompt 3 sequential')
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

    const agent = getHerdrAgent(binDir, statePath, 'worker-overlap')
    expect(agent).toBeDefined()
    // Exactly prompt 1 and prompt 3 reached Herdr; prompt 2 was rejected before submission
    expect(agent?.prompts).toEqual(['prompt 1', 'prompt 3 sequential'])

    await rm(dir, { recursive: true, force: true })
  })

  it('releases sequential prompt lock on terminal failure so subsequent prompt can run', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir, {
      failNextAgentPrompt: 'Simulated Herdr socket failure on first prompt',
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-err-lock' })
  const worker = await drovr.start({ name: 'worker-err-lock', cwd: wt.path })

  try {
    await worker.prompt('failing prompt')
    throw new Error('should have failed')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('herdr agent prompt failed')) {
      throw err
    }
  }

  // After prompt failure, lock must be released so next prompt can run
  await worker.prompt('recovered prompt')
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

    const agent = getHerdrAgent(binDir, statePath, 'worker-err-lock')
    expect(agent).toBeDefined()
    expect(agent?.prompts).toEqual(['recovered prompt'])

    await rm(dir, { recursive: true, force: true })
  })

  it('fails map item on stalled prompt without automatic retry', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir, {
      stallAgentPromptForName: {
        'worker-stall': true,
      },
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-stall' })
  const worker = await drovr.start({ name: 'worker-stall', cwd: wt.path })
  await worker.prompt('stalling prompt')
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
    expect(errInfo.stderr).toContain('agent_prompt_stalled')

    const agent = getHerdrAgent(binDir, statePath, 'worker-stall')
    expect(agent).toBeDefined()
    // Exactly 1 attempt made; no automatic retry occurred
    expect(agent?.prompts).toBeUndefined()

    await rm(dir, { recursive: true, force: true })
  })

  it('keeps waiting during blocked state without counting it as success until idle transition follows', async () => {
    const dir = await initRepo()
    const unblockFile = join(dir, 'unblock.signal')
    const { binDir, statePath } = await setupMockHerdr(dir, {
      blockAgentOnPrompt: {
        'worker-blocked': { unblockFile },
      },
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-blocked' })
  const worker = await drovr.start({ name: 'worker-blocked', cwd: wt.path })

  const unblockTask = (async () => {
    await Promise.resolve()
    await writeFile(${JSON.stringify(unblockFile)}, 'ok', 'utf8')
  })()
  await worker.prompt('action requiring human approval')
  await unblockTask
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

    const agent = getHerdrAgent(binDir, statePath, 'worker-blocked')
    expect(agent).toBeDefined()
    expect(agent?.prompts).toEqual(['action requiring human approval'])
    expect(agent?.agent_status).toBe('idle')

    await rm(dir, { recursive: true, force: true })
  })

  it('keeps waiting during unknown state without counting it as success until idle transition follows', async () => {
    const dir = await initRepo()
    const unblockFile = join(dir, 'unblock-unknown.signal')
    const { binDir, statePath } = await setupMockHerdr(dir, {
      unknownAgentOnPrompt: {
        'worker-unknown': { unblockFile },
      },
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
import { writeFile } from 'node:fs/promises'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-unknown' })
  const worker = await drovr.start({ name: 'worker-unknown', cwd: wt.path })

  const unblockTask = (async () => {
    await Promise.resolve()
    await writeFile(${JSON.stringify(unblockFile)}, 'ok', 'utf8')
  })()
  await worker.prompt('action in unknown state')
  await unblockTask
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

    const agent = getHerdrAgent(binDir, statePath, 'worker-unknown')
    expect(agent).toBeDefined()
    expect(agent?.prompts).toEqual(['action in unknown state'])
    expect(agent?.agent_status).toBe('idle')

    await rm(dir, { recursive: true, force: true })
  })

  it('excludes prompt bodies and Herdr subprocess output from Drovr log events across prompt errors, workspace creation errors, and agent start errors', async () => {
    const dir = await initRepo()
    const secretPromptSuccess = 'SECRET_PAYLOAD_SUCCESS_XYZ_777'
    const secretPromptFail = 'SECRET_PAYLOAD_FAIL_ABC_888'
    const secretStartFail = 'SECRET_START_FAIL_DEF_999'
    const secretWsFail = 'SECRET_WS_FAIL_GHI_000'

    const distinctivePromptStderr =
      'agent_prompt_stalled: herdr-stderr-raw-diagnostic for prompt ' + secretPromptFail
    const distinctiveStartStderr =
      'herdr-stderr-start-failure: process crashed with prompt context ' + secretStartFail
    const distinctiveWsStderr =
      'herdr-stderr-ws-failure: workspace creation rejected prompt payload ' + secretWsFail

    const { binDir, statePath } = await setupMockHerdr(dir, {
      stallAgentPromptForName: {
        'item-prompt-fail': distinctivePromptStderr,
      },
      failAgentStartForName: {
        'item-start-fail': distinctiveStartStderr,
      },
      failWorkspaceCreateForName: {
        'item-ws-fail': distinctiveWsStderr,
      },
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const items = [
    { name: 'item-ok', prompt: ${JSON.stringify(secretPromptSuccess)} },
    { name: 'item-prompt-fail', prompt: ${JSON.stringify(secretPromptFail)} },
    { name: 'item-start-fail', prompt: ${JSON.stringify(secretStartFail)} },
    { name: 'item-ws-fail', prompt: ${JSON.stringify(secretWsFail)} },
  ]

  await drovr.map(items, { concurrency: 4, name: (i) => i.name }, async (item) => {
    const wt = await drovr.worktree({ name: item.name })
    const worker = await drovr.start({ name: item.name, cwd: wt.path })
    await worker.prompt(item.prompt)
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
    expect(errInfo.stderr).toContain(distinctivePromptStderr)
    expect(errInfo.stderr).toContain(distinctiveStartStderr)
    expect(errInfo.stderr).toContain(distinctiveWsStderr)

    const logContent = await readFile(join(dir, '.drovr/drovr.log'), 'utf8')
    expect(logContent).not.toContain(secretPromptSuccess)
    expect(logContent).not.toContain(secretPromptFail)
    expect(logContent).not.toContain(secretStartFail)
    expect(logContent).not.toContain(secretWsFail)
    expect(logContent).not.toContain(distinctivePromptStderr)
    expect(logContent).not.toContain(distinctiveStartStderr)
    expect(logContent).not.toContain(distinctiveWsStderr)
    expect(logContent).not.toContain('herdr-stderr-raw-diagnostic')
    expect(logContent).not.toContain('herdr-stderr-start-failure')
    expect(logContent).not.toContain('herdr-stderr-ws-failure')
    expect(logContent).not.toContain('req-agent-prompt')
    expect(logContent).not.toContain('agent_prompted')
    expect(logContent).toContain(
      'map.item.fail name=item-prompt-fail error="herdr agent prompt failed: agent_prompt_stalled"',
    )
    expect(logContent).toContain(
      'map.item.fail name=item-start-fail error="herdr agent start failed"',
    )
    expect(logContent).toContain(
      'map.item.fail name=item-ws-fail error="herdr workspace create failed"',
    )

    await rm(dir, { recursive: true, force: true })
  })

  it('excludes malformed workspace stdout from Drovr log events on parse failure', async () => {
    const dir = await initRepo()
    const secretMalformed = 'SECRET_MALFORMED_STDOUT_JKL_111'
    const distinctiveMalformedStdout =
      'herdr-stdout-malformed-raw-data-including-prompt: ' + secretMalformed

    const { binDir, statePath } = await setupMockHerdr(dir, {
      malformedNextWorkspaceCreate: distinctiveMalformedStdout,
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  const wt = await drovr.worktree({ name: 'worker-malformed' })
  await drovr.start({ name: 'worker-malformed', cwd: wt.path })
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
    expect(errInfo.stderr).toContain(distinctiveMalformedStdout)

    const logContent = await readFile(join(dir, '.drovr/drovr.log'), 'utf8')
    expect(logContent).not.toContain(secretMalformed)
    expect(logContent).not.toContain(distinctiveMalformedStdout)
    expect(logContent).not.toContain('herdr-stdout-malformed-raw-data')
    expect(logContent).toContain(
      'start.fail mode=fresh started=0 skipped=0 completed=0 failed=0 error="failed to parse workspace create output"',
    )

    await rm(dir, { recursive: true, force: true })
  })
})

describe('Issue #32: Resume reconnects a live Worker by Name', () => {
  it('Start discovers an existing idle or done Worker by Name and reconnects it without creating another workspace or starting another OMP process', async () => {
    const dir = await initRepo()
    const wtIdlePath = join(dir, '.worktrees/worker-idle')
    const wtDonePath = join(dir, '.worktrees/worker-done')

    const { binDir, statePath } = await setupMockHerdr(dir, {
      nextWorkspaceNum: 3,
      workspaces: [
        {
          workspace_id: 'w1',
          number: 1,
          label: 'worker-idle',
          focused: false,
          pane_count: 1,
          tab_count: 1,
          active_tab_id: 'w1:t1',
          agent_status: 'idle',
        },
        {
          workspace_id: 'w2',
          number: 2,
          label: 'worker-done',
          focused: false,
          pane_count: 1,
          tab_count: 1,
          active_tab_id: 'w2:t1',
          agent_status: 'done',
        },
      ],
      panes: [
        {
          pane_id: 'w1:p1',
          terminal_id: 'term-1',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          focused: false,
          agent_status: 'idle',
          revision: 1,
          cwd: wtIdlePath,
        },
        {
          pane_id: 'w2:p1',
          terminal_id: 'term-2',
          workspace_id: 'w2',
          tab_id: 'w2:t1',
          focused: false,
          agent_status: 'done',
          revision: 1,
          cwd: wtDonePath,
        },
      ],
      agents: [
        {
          terminal_id: 'term-1',
          agent_status: 'idle',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          pane_id: 'w1:p1',
          focused: false,
          revision: 1,
          name: 'worker-idle',
          agent: 'omp',
          display_agent: 'OMP',
          cwd: wtIdlePath,
          foreground_cwd: wtIdlePath,
          prompts: ['initial prompt idle'],
        },
        {
          terminal_id: 'term-2',
          agent_status: 'done',
          workspace_id: 'w2',
          tab_id: 'w2:t1',
          pane_id: 'w2:p1',
          focused: false,
          revision: 1,
          name: 'worker-done',
          agent: 'omp',
          display_agent: 'OMP',
          cwd: wtDonePath,
          foreground_cwd: wtDonePath,
          prompts: ['initial prompt done'],
        },
      ],
    })

    // Create matching git worktrees so drovr.worktree reconnects them
    runGit(dir, ['worktree', 'add', '-b', 'drovr/worker-idle', wtIdlePath, 'HEAD'])
    runGit(dir, ['worktree', 'add', '-b', 'drovr/worker-done', wtDonePath, 'HEAD'])

    await mkdir(join(dir, '.drovr'), { recursive: true })
    openProjectDatabase(join(dir, '.drovr/state.sqlite')).close()

    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  await drovr.map(['worker-idle', 'worker-done'], { concurrency: 2, name: (n) => n }, async (name) => {
    const wt = await drovr.worktree({ name })
    const worker = await drovr.start({ name, cwd: wt.path })
    await worker.prompt('resumed prompt for ' + name)
  })
}
`,
      'utf8',
    )

    execFileSync(process.execPath, [drovr, 'start', '--resume'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })

    // Verify Herdr state: exactly 2 workspaces and 2 agents (no new ones created)
    const workspaces = listHerdrWorkspaces(binDir, statePath)
    expect(workspaces).toHaveLength(2)
    expect(workspaces.map((w) => w.workspace_id).sort()).toEqual(['w1', 'w2'])

    const agents = listHerdrAgents(binDir, statePath)
    expect(agents).toHaveLength(2)

    const agentIdle = getHerdrAgent(binDir, statePath, 'worker-idle')
    expect(agentIdle).not.toBeNull()
    expect(agentIdle?.prompts).toEqual(['initial prompt idle', 'resumed prompt for worker-idle'])

    const agentDone = getHerdrAgent(binDir, statePath, 'worker-done')
    expect(agentDone).not.toBeNull()
    expect(agentDone?.prompts).toEqual(['initial prompt done', 'resumed prompt for worker-done'])

    await rm(dir, { recursive: true, force: true })
  })

  it('Start requires the live Worker cwd to match the reconciled Worktree and fails the item on cwd mismatch without rebinding or moving the Worker', async () => {
    const dir = await initRepo()
    const foreignCwd = join(dir, 'foreign-directory')
    await mkdir(foreignCwd, { recursive: true })

    const wtMismatchPath = join(dir, '.worktrees/worker-mismatch')
    runGit(dir, ['worktree', 'add', '-b', 'drovr/worker-mismatch', wtMismatchPath, 'HEAD'])

    const { binDir, statePath } = await setupMockHerdr(dir, {
      nextWorkspaceNum: 2,
      workspaces: [
        {
          workspace_id: 'w1',
          number: 1,
          label: 'worker-mismatch',
          focused: false,
          pane_count: 1,
          tab_count: 1,
          active_tab_id: 'w1:t1',
          agent_status: 'idle',
        },
      ],
      panes: [
        {
          pane_id: 'w1:p1',
          terminal_id: 'term-1',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          focused: false,
          agent_status: 'idle',
          revision: 1,
          cwd: foreignCwd,
        },
      ],
      agents: [
        {
          terminal_id: 'term-1',
          agent_status: 'idle',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          pane_id: 'w1:p1',
          focused: false,
          revision: 1,
          name: 'worker-mismatch',
          agent: 'omp',
          display_agent: 'OMP',
          cwd: foreignCwd,
          foreground_cwd: foreignCwd,
          prompts: ['foreign prompt'],
        },
      ],
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    openProjectDatabase(join(dir, '.drovr/state.sqlite')).close()

    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  await drovr.map(['worker-mismatch'], { concurrency: 1, name: (n) => n }, async (name) => {
    const wt = await drovr.worktree({ name })
    await drovr.start({ name, cwd: wt.path })
  })
}
`,
      'utf8',
    )

    let caughtError: unknown
    try {
      execFileSync(process.execPath, [drovr, 'start', '--resume'], {
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

    const logContent = await readFile(join(dir, '.drovr/drovr.log'), 'utf8')
    expect(logContent).toContain('map.item.fail name=worker-mismatch')
    expect(logContent).toContain('does not match')

    // Worker and workspace in Herdr remain unmodified at foreignCwd
    const agent = getHerdrAgent(binDir, statePath, 'worker-mismatch')
    expect(agent).not.toBeNull()
    expect(agent?.cwd).toBe(foreignCwd)
    expect(agent?.prompts).toEqual(['foreign prompt'])

    const workspaces = listHerdrWorkspaces(binDir, statePath)
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].workspace_id).toBe('w1')

    await rm(dir, { recursive: true, force: true })
  })

  it('Start awaits an in-flight Worker turn before the resumed callback can submit another prompt', async () => {
    const dir = await initRepo()
    const wtPath = join(dir, '.worktrees/worker-inflight')
    runGit(dir, ['worktree', 'add', '-b', 'drovr/worker-inflight', wtPath, 'HEAD'])

    const { binDir, statePath } = await setupMockHerdr(dir, {
      nextWorkspaceNum: 2,
      workspaces: [
        {
          workspace_id: 'w1',
          number: 1,
          label: 'worker-inflight',
          focused: false,
          pane_count: 1,
          tab_count: 1,
          active_tab_id: 'w1:t1',
          agent_status: 'running',
        },
      ],
      panes: [
        {
          pane_id: 'w1:p1',
          terminal_id: 'term-1',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          focused: false,
          agent_status: 'running',
          revision: 1,
          cwd: wtPath,
        },
      ],
      agents: [
        {
          terminal_id: 'term-1',
          agent_status: 'running',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          pane_id: 'w1:p1',
          focused: false,
          revision: 1,
          name: 'worker-inflight',
          agent: 'omp',
          display_agent: 'OMP',
          cwd: wtPath,
          foreground_cwd: wtPath,
          prompts: ['first prompt running'],
        },
      ],
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    openProjectDatabase(join(dir, '.drovr/state.sqlite')).close()

    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  await drovr.map(['worker-inflight'], { concurrency: 1, name: (n) => n }, async (name) => {
    const wt = await drovr.worktree({ name })
    const worker = await drovr.start({ name, cwd: wt.path })
    await worker.prompt('second prompt')
  })
}
`,
      'utf8',
    )

    execFileSync(process.execPath, [drovr, 'start', '--resume'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })

    const agent = getHerdrAgent(binDir, statePath, 'worker-inflight')
    expect(agent).not.toBeNull()
    expect(agent?.agent_status).toBe('idle')
    expect(agent?.prompts).toEqual(['first prompt running', 'second prompt'])

    await rm(dir, { recursive: true, force: true })
  })

  it('An absent Worker takes the normal fresh-start path without OMP continue/resume flags', async () => {
    const dir = await initRepo()
    const wtFreshPath = join(dir, '.worktrees/worker-fresh')
    runGit(dir, ['worktree', 'add', '-b', 'drovr/worker-fresh', wtFreshPath, 'HEAD'])
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    openProjectDatabase(join(dir, '.drovr/state.sqlite')).close()
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  await drovr.map(['worker-fresh'], { concurrency: 1, name: (n) => n }, async (name) => {
    const wt = await drovr.worktree({ name })
    const worker = await drovr.start({ name, cwd: wt.path })
    await worker.prompt('first prompt')
  })
}
`,
      'utf8',
    )

    execFileSync(process.execPath, [drovr, 'start', '--resume'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })

    const workspaces = listHerdrWorkspaces(binDir, statePath)
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0].label).toBe('worker-fresh')

    const agent = getHerdrAgent(binDir, statePath, 'worker-fresh')
    expect(agent).not.toBeNull()
    expect(agent?.agent).toBe('omp')
    expect(agent?.prompts).toEqual(['first prompt'])

    await rm(dir, { recursive: true, force: true })
  })

  it('A stalled in-flight wait fails the item without retry', async () => {
    const dir = await initRepo()
    const wtPath = join(dir, '.worktrees/worker-stalled')
    runGit(dir, ['worktree', 'add', '-b', 'drovr/worker-stalled', wtPath, 'HEAD'])

    const { binDir, statePath } = await setupMockHerdr(dir, {
      nextWorkspaceNum: 2,
      workspaces: [
        {
          workspace_id: 'w1',
          number: 1,
          label: 'worker-stalled',
          focused: false,
          pane_count: 1,
          tab_count: 1,
          active_tab_id: 'w1:t1',
          agent_status: 'running',
        },
      ],
      panes: [
        {
          pane_id: 'w1:p1',
          terminal_id: 'term-1',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          focused: false,
          agent_status: 'running',
          revision: 1,
          cwd: wtPath,
        },
      ],
      agents: [
        {
          terminal_id: 'term-1',
          agent_status: 'running',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          pane_id: 'w1:p1',
          focused: false,
          revision: 1,
          name: 'worker-stalled',
          agent: 'omp',
          display_agent: 'OMP',
          cwd: wtPath,
          foreground_cwd: wtPath,
          prompts: ['stalled prompt'],
        },
      ],
      stallAgentWaitForName: {
        'worker-stalled': 'agent_prompt_stalled: wait did not observe state change',
      },
    })

    await mkdir(join(dir, '.drovr'), { recursive: true })
    openProjectDatabase(join(dir, '.drovr/state.sqlite')).close()

    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
export default async function (drovr: Drovr) {
  await drovr.map(['worker-stalled'], { concurrency: 1, name: (n) => n }, async (name) => {
    const wt = await drovr.worktree({ name })
    const worker = await drovr.start({ name, cwd: wt.path })
    await worker.prompt('will not execute')
  })
}
`,
      'utf8',
    )

    let caughtError: unknown
    try {
      execFileSync(process.execPath, [drovr, 'start', '--resume'], {
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

    const logContent = await readFile(join(dir, '.drovr/drovr.log'), 'utf8')
    expect(logContent).toContain('map.item.fail name=worker-stalled')
    expect(logContent).toContain('herdr agent wait failed: agent_prompt_stalled')

    await rm(dir, { recursive: true, force: true })
  })

  it('A crash-and-resume process scenario verifies reconnection through visible Herdr state', async () => {
    const dir = await initRepo()
    const { binDir, statePath } = await setupMockHerdr(dir)

    await mkdir(join(dir, '.drovr'), { recursive: true })
    // Workflow passes first step (prompt 1), throws on fresh run, and completes on resume
    await writeFile(
      join(dir, '.drovr/main.ts'),
      `import type { Drovr } from 'drovr'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export default async function (drovr: Drovr) {
  await drovr.map(['item-crash'], { concurrency: 1, name: (n) => n }, async (name) => {
    const wt = await drovr.worktree({ name })
    const worker = await drovr.start({ name, cwd: wt.path })
    const crashFlag = join(wt.path, '.crashed')
    if (!existsSync(crashFlag)) {
      await worker.prompt('prompt turn 1')
      writeFileSync(crashFlag, 'true', 'utf8')
      throw new Error('Simulated process crash after prompt 1')
    }
    await worker.prompt('prompt turn 2 on resume')
  })
}
`,
      'utf8',
    )

    // First run (fresh): should execute prompt 1 and throw
    let firstRunError: unknown
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
      firstRunError = err
    }

    const firstErr = extractExecError(firstRunError)
    expect(firstErr.status).toBe(1)

    // In Herdr: workspace and agent survive
    const wsAfterCrash = listHerdrWorkspaces(binDir, statePath)
    expect(wsAfterCrash).toHaveLength(1)
    const agentAfterCrash = getHerdrAgent(binDir, statePath, 'item-crash')
    expect(agentAfterCrash).not.toBeNull()
    expect(agentAfterCrash?.prompts).toEqual(['prompt turn 1'])

    // Second run (--resume): reconnects live worker and finishes prompt 2
    execFileSync(process.execPath, [drovr, 'start', '--resume'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        HERDR_STATE_FILE: statePath,
      },
    })

    // Verify Herdr state: still exactly 1 workspace and 1 agent, both prompts executed in order
    const wsAfterResume = listHerdrWorkspaces(binDir, statePath)
    expect(wsAfterResume).toHaveLength(1)
    expect(wsAfterResume[0].workspace_id).toBe(wsAfterCrash[0].workspace_id)

    const agentAfterResume = getHerdrAgent(binDir, statePath, 'item-crash')
    expect(agentAfterResume).not.toBeNull()
    expect(agentAfterResume?.prompts).toEqual(['prompt turn 1', 'prompt turn 2 on resume'])

    await rm(dir, { recursive: true, force: true })
  })
})
