import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import type { Name } from './index'

export interface HerdrWorkspaceResult {
  workspaceId: string
  rootPaneId: string
}

export function runHerdr(cwd: string, args: string[]): string {
  try {
    return execFileSync('herdr', args, {
      cwd,
      encoding: 'utf8',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trimEnd()
  } catch (error: unknown) {
    const commandName = `herdr ${args.slice(0, 2).join(' ')}`
    if (typeof error === 'object' && error !== null && 'stderr' in error) {
      const stderr =
        typeof error.stderr === 'string'
          ? error.stderr.trim()
          : error.stderr instanceof Buffer
            ? error.stderr.toString('utf8').trim()
            : ''
      if (stderr) {
        throw new Error(`${commandName} failed: ${stderr}`)
      }
    }
    throw new Error(`${commandName} failed`)
  }
}

export function createHerdrWorkspace(
  commandCwd: string,
  options: { workspaceCwd: string; label?: string; noFocus?: boolean },
): HerdrWorkspaceResult {
  const args = ['workspace', 'create', '--cwd', options.workspaceCwd]
  if (options.label) {
    args.push('--label', options.label)
  }
  if (options.noFocus) {
    args.push('--no-focus')
  }
  const output = runHerdr(commandCwd, args)
  try {
    const data: unknown = JSON.parse(output)
    if (typeof data === 'object' && data !== null) {
      const res: unknown =
        'result' in data && typeof data.result === 'object' && data.result !== null
          ? data.result
          : data
      if (typeof res === 'object' && res !== null) {
        let workspaceId: string | undefined
        if (
          'workspace' in res &&
          typeof res.workspace === 'object' &&
          res.workspace !== null &&
          'workspace_id' in res.workspace &&
          typeof res.workspace.workspace_id === 'string'
        ) {
          workspaceId = res.workspace.workspace_id
        } else if ('workspace_id' in res && typeof res.workspace_id === 'string') {
          workspaceId = res.workspace_id
        }

        let rootPaneId: string | undefined
        if (
          'root_pane' in res &&
          typeof res.root_pane === 'object' &&
          res.root_pane !== null &&
          'pane_id' in res.root_pane &&
          typeof res.root_pane.pane_id === 'string'
        ) {
          rootPaneId = res.root_pane.pane_id
        } else if ('pane_id' in res && typeof res.pane_id === 'string') {
          rootPaneId = res.pane_id
        }

        if (workspaceId && rootPaneId) {
          return { workspaceId, rootPaneId }
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('herdr')) {
      throw err
    }
  }
  throw new Error(`failed to parse workspace create output: ${output}`)
}

export function closeHerdrWorkspace(commandCwd: string, workspaceId: string): void {
  runHerdr(commandCwd, ['workspace', 'close', workspaceId])
}

export function startHerdrOmpWorker(
  commandCwd: string,
  options: { name: Name; paneId: string },
): void {
  runHerdr(commandCwd, ['agent', 'start', options.name, '--kind', 'omp', '--pane', options.paneId])
}

export async function runHerdrAsync(cwd: string, args: string[]): Promise<string> {
  const commandName = `herdr ${args.slice(0, 2).join(' ')}`
  try {
    const { stdout } = await execFileAsync('herdr', args, {
      cwd,
      encoding: 'utf8',
      env: process.env,
    })
    return stdout.trimEnd()
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'stderr' in error) {
      const stderr =
        typeof error.stderr === 'string'
          ? error.stderr.trim()
          : error.stderr instanceof Buffer
            ? error.stderr.toString('utf8').trim()
            : ''
      if (stderr) {
        throw new Error(`${commandName} failed: ${stderr}`)
      }
    }
    throw new Error(`${commandName} failed`)
  }
}

export async function promptHerdrOmpWorker(
  commandCwd: string,
  options: { name: Name; text: string },
): Promise<void> {
  await runHerdrAsync(commandCwd, [
    'agent',
    'prompt',
    options.name,
    options.text,
    '--wait',
    '--until',
    'idle',
    '--until',
    'done',
  ])
}
