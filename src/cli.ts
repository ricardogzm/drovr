#!/usr/bin/env node
import { runSetup } from './setup'

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (rest.length > 0) {
    console.error(`error: unexpected arguments: ${rest.join(' ')}`)
    return 1
  }
  if (command === 'setup') {
    try {
      await runSetup(process.cwd())
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`error: ${message}`)
      return 1
    }
  }
  console.error(`error: unknown command ${command ?? '(none)'}`)
  return 1
}

const exitCode = await main(process.argv.slice(2))
process.exit(exitCode)
