import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Name } from './index'

export interface RunWorktreeSetupOptions {
  worktreePath: string
  name: Name
  startCheckout: string
  stdoutStream?: NodeJS.WritableStream
  stderrStream?: NodeJS.WritableStream
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export async function readWorktreeSetupConfig(worktreePath: string, name: Name): Promise<string[]> {
  const configPath = join(worktreePath, '.drovr', 'worktrees.json')
  let content: string
  try {
    content = await readFile(configPath, 'utf8')
  } catch (err) {
    if (isEnoent(err)) {
      return []
    }
    throw new Error(
      `Worktree setup failed for "${name}": failed to read configuration at "${configPath}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new Error(
      `Worktree setup failed for "${name}": invalid JSON in "${configPath}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!Array.isArray(parsed)) {
    const foundType = parsed === null ? 'null' : typeof parsed
    throw new Error(
      `Worktree setup failed for "${name}": "${configPath}" must contain a top-level JSON array of shell-command strings, found ${foundType}`,
    )
  }

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i]
    if (typeof item !== 'string') {
      const foundType = item === null ? 'null' : typeof item
      throw new Error(
        `Worktree setup failed for "${name}": command at position ${i + 1} in "${configPath}" must be a string, found ${foundType}`,
      )
    }
  }

  return parsed
}

function formatChunk(text: string, prefix: string): string {
  if (text.length === 0) {
    return ''
  }

  const endsWithNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (endsWithNewline) {
    lines.pop()
  }

  const formattedLines = lines.map((line) => `${prefix}${line}`)
  return formattedLines.join('\n') + (endsWithNewline ? '\n' : '')
}

function pipeWithPrefix(
  readable: NodeJS.ReadableStream,
  writable: NodeJS.WritableStream,
  prefix: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const decoder = new StringDecoder('utf8')

    readable.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      const formatted = formatChunk(text, prefix)
      if (formatted.length > 0) {
        writable.write(formatted)
      }
    })

    readable.on('end', () => {
      const rest = decoder.end()
      const formatted = formatChunk(rest, prefix)
      if (formatted.length > 0) {
        writable.write(formatted)
      }
      resolve()
    })

    readable.on('error', (err) => {
      reject(err)
    })
  })
}

function runSetupCommand(
  cmd: string,
  index: number,
  total: number,
  name: Name,
  worktreePath: string,
  startCheckout: string,
  stdoutStream: NodeJS.WritableStream,
  stderrStream: NodeJS.WritableStream,
): Promise<void> {
  const position = index + 1
  const prefix = `[${name} setup ${position}/${total}] `

  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, {
        cwd: worktreePath,
        env: {
          ...process.env,
          DROVR_START_CHECKOUT: startCheckout,
        },
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(
        new Error(
          `Worktree setup failed for "${name}" at command ${position} of ${total} ("${cmd}"): ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      return
    }

    let spawnError: Error | null = null
    child.on('error', (err) => {
      spawnError = err
    })

    const stdoutPromise = child.stdout
      ? pipeWithPrefix(child.stdout, stdoutStream, prefix)
      : Promise.resolve()
    const stderrPromise = child.stderr
      ? pipeWithPrefix(child.stderr, stderrStream, prefix)
      : Promise.resolve()

    child.on('close', async (code, signal) => {
      try {
        await Promise.all([stdoutPromise, stderrPromise])
      } catch {
        // ignore piping errors
      }

      if (spawnError) {
        reject(
          new Error(
            `Worktree setup failed for "${name}" at command ${position} of ${total} ("${cmd}"): ${spawnError.message}`,
          ),
        )
        return
      }

      if (signal) {
        reject(
          new Error(
            `Worktree setup failed for "${name}" at command ${position} of ${total} ("${cmd}"): process terminated by signal ${signal}`,
          ),
        )
        return
      }

      if (code !== 0) {
        reject(
          new Error(
            `Worktree setup failed for "${name}" at command ${position} of ${total} ("${cmd}"): process exited with code ${code ?? 'unknown'}`,
          ),
        )
        return
      }

      resolve()
    })
  })
}

export async function runWorktreeSetup(options: RunWorktreeSetupOptions): Promise<void> {
  const {
    worktreePath,
    name,
    startCheckout,
    stdoutStream = process.stdout,
    stderrStream = process.stderr,
  } = options
  const commands = await readWorktreeSetupConfig(worktreePath, name)
  if (commands.length === 0) {
    return
  }

  for (let i = 0; i < commands.length; i++) {
    await runSetupCommand(
      commands[i],
      i,
      commands.length,
      name,
      worktreePath,
      startCheckout,
      stdoutStream,
      stderrStream,
    )
  }
}
