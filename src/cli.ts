#!/usr/bin/env node
import { runSetup } from './setup'
import { runStart } from './start'
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
      const message = error instanceof Error ? error.message : String(error)
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
      const message = error instanceof Error ? error.message : String(error)
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
