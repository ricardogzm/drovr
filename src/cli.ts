#!/usr/bin/env node
import { runSetup } from './setup'
import { runStart } from './start'
function formatCliErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    try {
      if (typeof error.message === 'string') {
        return error.message
      }
    } catch {}
  }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'number') {
    return String(error)
  }
  if (typeof error === 'boolean') {
    return error ? 'true' : 'false'
  }
  if (typeof error === 'bigint') {
    return `${BigInt.prototype.toString.call(error)}n`
  }
  if (error === undefined) {
    return 'unknown error'
  }
  if (error === null) {
    return 'null'
  }
  try {
    if (typeof error === 'object') {
      return Object.prototype.toString.call(error)
    }
    if (typeof error === 'function') {
      return Function.prototype.toString.call(error)
    }
    if (typeof error === 'symbol') {
      return Symbol.prototype.toString.call(error)
    }
  } catch {}
  return 'unknown error'
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'setup') {
    if (rest.length > 0) {
      console.error(`error: unexpected arguments: ${rest.join(' ')}`)
      return 1
    }
    try {
      await runSetup(process.cwd())
      return 0
    } catch (error) {
      const message = formatCliErrorMessage(error)
      console.error(`error: ${message}`)
      return 1
    }
  }

  if (command === 'start') {
    let resume = false
    let verbose = false
    for (const arg of rest) {
      if (arg === '--resume') {
        resume = true
      } else if (arg === '--verbose') {
        verbose = true
      } else {
        console.error(`error: unexpected arguments: ${arg}`)
        return 1
      }
    }
    try {
      await runStart(process.cwd(), { resume, verbose })
      return 0
    } catch (error) {
      const message = formatCliErrorMessage(error)
      console.error(`error: ${message}`)
      return 1
    }
  }

  if (rest.length > 0) {
    console.error(`error: unexpected arguments: ${rest.join(' ')}`)
    return 1
  }

  console.error(`error: unknown command ${command ?? '(none)'}`)
  return 1
}

const exitCode = await main(process.argv.slice(2))
process.exit(exitCode)
