#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import {
  classifyCommits,
  getGitCommitsInRange,
  parseCommitMessage,
  renderReleaseNotes,
  resolveRepoSlug,
} from './release-metadata'
import { runSetup } from './setup'
import { runStart } from './start'
import { verifyPackageTarball } from './tarball-verify'
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
  if (command === 'package-release') {
    const [subcommand, ...subArgs] = rest
    if (subcommand === 'validate' || subcommand === 'validate-commit') {
      let message = ''
      if (subArgs[0] === '--file') {
        const filePath = subArgs[1]
        if (!filePath) {
          console.error('error: missing file path after --file')
          return 1
        }
        try {
          message = readFileSync(filePath, 'utf8')
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(`error: failed to read file: ${errMsg}`)
          return 1
        }
      } else {
        message = subArgs.join(' ')
      }

      const validation = parseCommitMessage(message)
      if (!validation.valid) {
        console.error(`error: ${validation.error}`)
        return 1
      }
      return 0
    }
    if (subcommand === 'classify') {
      let from: string | null = null
      let to: string | null = null
      let cwd = process.cwd()

      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i]
        if (arg === '--from' && i + 1 < subArgs.length) {
          from = subArgs[++i]
        } else if (arg === '--to' && i + 1 < subArgs.length) {
          to = subArgs[++i]
        } else if (arg === '--cwd' && i + 1 < subArgs.length) {
          cwd = subArgs[++i]
        } else if (arg.includes('..') && !from && !to) {
          const [rFrom, rTo] = arg.split('..')
          from = rFrom || null
          to = rTo || null
        } else {
          console.error(`error: unexpected argument for classify: ${arg}`)
          return 1
        }
      }

      const commits = getGitCommitsInRange(cwd, { from, to })
      const bump = classifyCommits(commits)
      console.log(bump)
      return 0
    }
    if (subcommand === 'notes' || subcommand === 'render-notes') {
      let from: string | null = null
      let to: string | null = null
      let tag: string | null = null
      let prevTag: string | null = null
      let repo: string | null = null
      let githubNotes: string | null = null
      let cwd = process.cwd()

      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i]
        if (arg === '--from' && i + 1 < subArgs.length) {
          from = subArgs[++i]
        } else if (arg === '--to' && i + 1 < subArgs.length) {
          to = subArgs[++i]
        } else if (arg === '--tag' && i + 1 < subArgs.length) {
          tag = subArgs[++i]
        } else if (arg === '--prev-tag' && i + 1 < subArgs.length) {
          prevTag = subArgs[++i]
        } else if (arg === '--repo' && i + 1 < subArgs.length) {
          repo = subArgs[++i]
        } else if (arg === '--github-notes' && i + 1 < subArgs.length) {
          githubNotes = subArgs[++i]
        } else if (arg === '--github-notes-file' && i + 1 < subArgs.length) {
          const filePath = subArgs[++i]
          try {
            githubNotes = readFileSync(filePath, 'utf8')
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            console.error(`error: failed to read github notes file: ${errMsg}`)
            return 1
          }
        } else if (arg === '--cwd' && i + 1 < subArgs.length) {
          cwd = subArgs[++i]
        } else if (arg.includes('..') && !from && !to) {
          const [rFrom, rTo] = arg.split('..')
          from = rFrom || null
          to = rTo || null
        } else {
          console.error(`error: unexpected argument for notes: ${arg}`)
          return 1
        }
      }
      if (!tag || tag.trim().length === 0) {
        console.error('error: missing required --tag argument')
        return 1
      }

      const resolvedRepo = resolveRepoSlug(cwd, repo)
      const commits = getGitCommitsInRange(cwd, { from, to })
      const notes = renderReleaseNotes({
        commits,
        repo: resolvedRepo,
        tag,
        prevTag,
        githubNotes,
      })
      process.stdout.write(notes)
      return 0
    }
    if (
      subcommand === 'verify-pack' ||
      subcommand === 'pack-verify' ||
      subcommand === 'verify-tarball' ||
      subcommand === 'verify'
    ) {
      let cwd = process.cwd()
      let tarball: string | undefined
      let skipBuild = false
      let keepTemp = false
      let json = false

      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i]
        if (arg === '--cwd' && i + 1 < subArgs.length) {
          cwd = subArgs[++i]
        } else if (arg === '--dir' && i + 1 < subArgs.length) {
          cwd = subArgs[++i]
        } else if (arg === '--tarball' && i + 1 < subArgs.length) {
          tarball = subArgs[++i]
        } else if (arg === '--skip-build') {
          skipBuild = true
        } else if (arg === '--keep-temp' || arg === '--keep') {
          keepTemp = true
        } else if (arg === '--json') {
          json = true
        } else {
          console.error(`error: unexpected argument for ${subcommand}: ${arg}`)
          return 1
        }
      }

      const result = await verifyPackageTarball({
        cwd,
        tarball,
        skipBuild,
        keepTemp,
      })

      if (!result.valid) {
        if (json) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.error(`error: ${result.error}`)
        }
        return 1
      }

      if (json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(`Verified npm tarball (${result.files.length} files in ${result.tarballPath})`)
      }
      return 0
    }

    console.error(`error: unknown package-release subcommand ${subcommand ?? '(none)'}`)
    return 1
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
