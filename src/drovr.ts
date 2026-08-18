import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  assignIssue,
  closeIssue,
  getAuthenticatedUser,
  getRepoFromStartCheckout,
  listReadyIssues,
  normalizeIssue,
  viewIssue,
} from './gh'
import {
  getGitWorktreeSymbolicRef,
  isGitBranchPresent,
  isGitCheckoutDirty,
  isGitWorktreeOfRepository,
  listGitWorktrees,
  repairStaleWorktreeRegistration,
  resolveGitCommonDir,
  runGit,
  safeRealpath,
} from './git'
import type { Drovr, Issue, Name, Worktree } from './index'
import type { DrovrLogger, DrovrLoggerCounts } from './log'
import { mergeExactLine } from './merge-line'

export interface DrovrContext {
  db?: DatabaseSync
  logger?: DrovrLogger
  counts?: DrovrLoggerCounts
  root?: string
  cwd?: string
  mode?: 'fresh' | 'resume'
}

const NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/

export function isValidName(name: unknown): name is Name {
  return typeof name === 'string' && NAME_REGEX.test(name)
}

export function createDrovr(context: DrovrContext = {}): Drovr {
  const { db, logger, counts, root, cwd, mode = 'fresh' } = context
  const workingDir = root ?? cwd ?? process.cwd()
  return {
    async resource() {
      throw new Error('resource is not implemented yet')
    },
    async map<T>(
      items: readonly T[],
      opts: { concurrency: number; name(item: T): Name },
      fn: (item: T) => Promise<void>,
    ): Promise<void> {
      if (typeof opts !== 'object' || opts === null) {
        throw new TypeError('map options must be an object')
      }
      if (
        typeof opts.concurrency !== 'number' ||
        !Number.isInteger(opts.concurrency) ||
        opts.concurrency < 1
      ) {
        throw new TypeError('map concurrency must be a positive integer')
      }
      if (typeof opts.name !== 'function') {
        throw new TypeError('map opts.name must be a function')
      }
      if (typeof fn !== 'function') {
        throw new TypeError('map callback must be a function')
      }
      if (
        !Array.isArray(items) &&
        (typeof items !== 'object' || items === null || !(Symbol.iterator in items))
      ) {
        throw new TypeError('map items must be an iterable')
      }

      const itemList = Array.from(items)
      const itemEntries: Array<{ item: T; name: Name }> = []
      const seenNames = new Set<string>()

      for (const item of itemList) {
        const name = opts.name(item)
        if (!isValidName(name)) {
          throw new Error(`invalid Name: "${String(name)}"`)
        }
        if (seenNames.has(name)) {
          throw new Error(`duplicate Name: "${name}"`)
        }
        seenNames.add(name)
        itemEntries.push({ item, name })
      }

      if (itemEntries.length === 0) {
        return
      }

      const checkCompletionStmt = db ? db.prepare('SELECT 1 FROM completions WHERE name = ?') : null
      const insertCompletionStmt = db
        ? db.prepare('INSERT OR IGNORE INTO completions (name) VALUES (?)')
        : null

      const pending: Array<{ item: T; name: Name }> = []

      for (const entry of itemEntries) {
        if (checkCompletionStmt) {
          const row = checkCompletionStmt.get(entry.name)
          if (row !== undefined) {
            if (counts) {
              counts.skipped++
            }
            if (logger) {
              logger.mapItemSkip(entry.name)
            }
            continue
          }
        }
        pending.push(entry)
      }

      if (pending.length === 0) {
        return
      }

      const limit = opts.concurrency
      const totalPending = pending.length
      let cursor = 0
      let activeCount = 0
      let settledCount = 0
      const itemErrors: Array<{ name: Name; error: unknown }> = []

      await new Promise<void>((resolve) => {
        const launchNext = () => {
          while (activeCount < limit && cursor < totalPending) {
            const entry = pending[cursor++]
            activeCount++

            if (counts) {
              counts.started++
            }
            if (logger) {
              logger.mapItemStart(entry.name)
            }

            Promise.resolve()
              .then(() => fn(entry.item))
              .then(
                () => {
                  if (insertCompletionStmt) {
                    insertCompletionStmt.run(entry.name)
                  }
                  if (counts) {
                    counts.completed++
                  }
                  if (logger) {
                    logger.mapItemComplete(entry.name)
                  }
                },
                (err) => {
                  if (counts) {
                    counts.failed++
                  }
                  if (logger) {
                    logger.mapItemFail(entry.name, err)
                  }
                  itemErrors.push({ name: entry.name, error: err })
                },
              )
              .catch((err) => {
                if (counts) {
                  counts.failed++
                }
                if (logger) {
                  logger.mapItemFail(entry.name, err)
                }
                itemErrors.push({ name: entry.name, error: err })
              })
              .finally(() => {
                activeCount--
                settledCount++
                if (settledCount === totalPending) {
                  resolve()
                } else {
                  launchNext()
                }
              })
          }
        }

        launchNext()
      })

      if (itemErrors.length > 0) {
        if (itemErrors.length === 1) {
          const first = itemErrors[0].error
          if (first instanceof Error) {
            throw first
          }
          throw new Error(String(first))
        }
        const errorNames = itemErrors.map((e) => e.name).join(', ')
        throw new Error(`${itemErrors.length} map items failed: ${errorNames}`)
      }
    },
    async worktree(opts: { name: Name }): Promise<Worktree> {
      if (typeof opts !== 'object' || opts === null) {
        throw new TypeError('worktree options must be an object')
      }
      if (!isValidName(opts.name)) {
        throw new TypeError(
          `Invalid name: "${String(opts.name)}". Names must match [a-z][a-z0-9_-]{0,31}`,
        )
      }

      const name = opts.name
      const branchName = `drovr/${name}`
      const fullBranchRef = `refs/heads/drovr/${name}`
      const worktreePath = join(workingDir, '.worktrees', name)

      if (mode === 'resume') {
        const pathStat = await lstat(worktreePath).catch((err) =>
          isEnoent(err) ? null : Promise.reject(err),
        )
        const pathExists = pathStat !== null

        const worktrees = listGitWorktrees(workingDir)
        const otherOccupant = worktrees.find(
          (w) => w.branch === fullBranchRef && safeRealpath(w.path) !== safeRealpath(worktreePath),
        )
        if (otherOccupant) {
          throw new Error(
            `Cannot resume Worktree "${name}": branch "${branchName}" is already checked out at "${otherOccupant.path}".`,
          )
        }

        const pathRegistration = worktrees.find(
          (w) => safeRealpath(w.path) === safeRealpath(worktreePath),
        )

        if (pathExists) {
          if (!pathStat.isDirectory()) {
            throw new Error(
              `Cannot resume Worktree "${name}": path "${worktreePath}" is a foreign file or invalid directory.`,
            )
          }

          if (!isGitWorktreeOfRepository(worktreePath, workingDir)) {
            throw new Error(
              `Cannot resume Worktree "${name}": path "${worktreePath}" is a foreign directory or not a Worktree of this repository.`,
            )
          }

          const currentRef = getGitWorktreeSymbolicRef(worktreePath)
          if (currentRef !== fullBranchRef) {
            throw new Error(
              `Cannot resume Worktree "${name}": Worktree at "${worktreePath}" is on branch "${currentRef ?? 'detached HEAD'}", expected "${fullBranchRef}".`,
            )
          }

          await ensureCloneLocalWorktreeExclusion(workingDir)

          return Object.freeze({
            name,
            path: worktreePath,
          })
        }

        const branchExists = isGitBranchPresent(workingDir, branchName)
        if (!branchExists) {
          throw new Error(
            `Cannot resume Worktree "${name}": neither path "${worktreePath}" nor branch "${branchName}" exists.`,
          )
        }

        if (pathRegistration) {
          if (pathRegistration.branch !== fullBranchRef) {
            throw new Error(
              `Cannot resume Worktree "${name}": stale registration at "${worktreePath}" is on branch "${pathRegistration.branch ?? 'detached HEAD'}", expected "${fullBranchRef}".`,
            )
          }
          repairStaleWorktreeRegistration(resolveGitCommonDir(workingDir), worktreePath)
        }

        await ensureCloneLocalWorktreeExclusion(workingDir)
        runGit(workingDir, ['worktree', 'add', worktreePath, branchName])

        return Object.freeze({
          name,
          path: worktreePath,
        })
      }
      const branchExists = isGitBranchPresent(workingDir, branchName)
      const directoryExists = await entryExists(worktreePath)

      if (branchExists || directoryExists) {
        if (branchExists && directoryExists) {
          throw new Error(
            `Worktree branch "${branchName}" and path "${worktreePath}" already exist. Run drovr start --resume to reconnect.`,
          )
        }
        if (branchExists) {
          throw new Error(
            `Worktree branch "${branchName}" already exists. Run drovr start --resume to reconnect.`,
          )
        }
        throw new Error(
          `Worktree path "${worktreePath}" already exists. Run drovr start --resume to reconnect.`,
        )
      }

      await ensureCloneLocalWorktreeExclusion(workingDir)

      if (isGitCheckoutDirty(workingDir)) {
        process.stderr.write('Warning: Start checkout has uncommitted changes\n')
      }

      runGit(workingDir, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])

      return Object.freeze({
        name,
        path: worktreePath,
      })
    },
    async start() {
      throw new Error('start is not implemented yet')
    },
    issues: {
      async list(opts?: { repo?: string }): Promise<readonly Issue[]> {
        if (opts !== undefined && (typeof opts !== 'object' || opts === null)) {
          throw new TypeError('issues.list options must be an object')
        }
        if (
          opts?.repo !== undefined &&
          (typeof opts.repo !== 'string' || !opts.repo.includes('/'))
        ) {
          throw new TypeError('issues.list opts.repo must be in owner/repo form')
        }

        const targetRepo = opts?.repo ?? getRepoFromStartCheckout(workingDir)
        const rawIssues = listReadyIssues(workingDir, targetRepo)

        let claimedRows: Array<{ issue_number: number; name: string }> = []
        if (db) {
          claimedRows = db
            .prepare('SELECT issue_number, name FROM claims WHERE repo = ?')
            .all(targetRepo) as Array<{ issue_number: number; name: string }>
        }

        const claimedNumbers = new Set(claimedRows.map((r) => r.issue_number))
        const seenNumbers = new Set<number>()
        const resultIssues: Issue[] = []

        for (const raw of rawIssues) {
          const num = Number(raw.number)
          seenNumbers.add(num)
          const assignees = Array.isArray(raw.assignees) ? raw.assignees : []
          const isUnassigned = assignees.length === 0
          const isClaimedLocally = claimedNumbers.has(num)

          if (isUnassigned || isClaimedLocally) {
            resultIssues.push(normalizeIssue(raw, targetRepo))
          }
        }

        if (db) {
          for (const claimed of claimedRows) {
            if (!seenNumbers.has(claimed.issue_number)) {
              const raw = viewIssue(workingDir, targetRepo, claimed.issue_number)
              if (raw) {
                if (raw.state === 'CLOSED') {
                  db.prepare('DELETE FROM claims WHERE repo = ? AND issue_number = ?').run(
                    targetRepo,
                    claimed.issue_number,
                  )
                } else if (raw.state === 'OPEN') {
                  resultIssues.push(normalizeIssue(raw, targetRepo))
                }
              }
            }
          }
        }

        return Object.freeze(resultIssues)
      },
      async claim(issue: Issue, opts: { name: Name }): Promise<void> {
        if (typeof issue !== 'object' || issue === null) {
          throw new TypeError('claim issue must be an object')
        }
        if (typeof issue.repo !== 'string' || issue.repo.trim() === '') {
          throw new TypeError('claim issue.repo must be a non-empty string')
        }
        if (
          typeof issue.number !== 'number' ||
          !Number.isInteger(issue.number) ||
          issue.number < 1
        ) {
          throw new TypeError('claim issue.number must be a positive integer')
        }
        if (typeof opts !== 'object' || opts === null) {
          throw new TypeError('claim options must be an object')
        }
        if (!isValidName(opts.name)) {
          throw new TypeError(
            `Invalid name: "${String(opts.name)}". Names must match [a-z][a-z0-9_-]{0,31}`,
          )
        }

        if (db) {
          const existing = db
            .prepare('SELECT name FROM claims WHERE repo = ? AND issue_number = ?')
            .get(issue.repo, issue.number) as { name: string } | undefined

          if (existing !== undefined) {
            if (existing.name !== opts.name) {
              throw new Error(
                `Issue #${issue.number} in ${issue.repo} is already claimed by ${existing.name}`,
              )
            }
          } else {
            try {
              db.prepare('INSERT INTO claims (repo, issue_number, name) VALUES (?, ?, ?)').run(
                issue.repo,
                issue.number,
                opts.name,
              )
            } catch (err) {
              const raced = db
                .prepare('SELECT name FROM claims WHERE repo = ? AND issue_number = ?')
                .get(issue.repo, issue.number) as { name: string } | undefined
              if (raced) {
                if (raced.name !== opts.name) {
                  throw new Error(
                    `Issue #${issue.number} in ${issue.repo} is already claimed by ${raced.name}`,
                  )
                }
              } else {
                throw err
              }
            }
          }
        }

        const user = getAuthenticatedUser(workingDir)
        assignIssue(workingDir, issue.repo, issue.number, user)
      },
      async close(issue: Issue): Promise<void> {
        if (typeof issue !== 'object' || issue === null) {
          throw new TypeError('close issue must be an object')
        }
        if (typeof issue.repo !== 'string' || issue.repo.trim() === '') {
          throw new TypeError('close issue.repo must be a non-empty string')
        }
        if (
          typeof issue.number !== 'number' ||
          !Number.isInteger(issue.number) ||
          issue.number < 1
        ) {
          throw new TypeError('close issue.number must be a positive integer')
        }

        if (db) {
          const existing = db
            .prepare('SELECT name FROM claims WHERE repo = ? AND issue_number = ?')
            .get(issue.repo, issue.number) as { name: string } | undefined
          if (existing === undefined) {
            throw new Error(
              `Cannot close Issue #${issue.number} in ${issue.repo}: no local Claim exists`,
            )
          }
        } else {
          throw new Error(
            `Cannot close Issue #${issue.number} in ${issue.repo}: no local Claim exists`,
          )
        }

        closeIssue(workingDir, issue.repo, issue.number)

        db.prepare('DELETE FROM claims WHERE repo = ? AND issue_number = ?').run(
          issue.repo,
          issue.number,
        )
      },
      async release(issue: Issue): Promise<void> {
        if (typeof issue !== 'object' || issue === null) {
          throw new TypeError('release issue must be an object')
        }
        if (typeof issue.repo !== 'string' || issue.repo.trim() === '') {
          throw new TypeError('release issue.repo must be a non-empty string')
        }
        if (
          typeof issue.number !== 'number' ||
          !Number.isInteger(issue.number) ||
          issue.number < 1
        ) {
          throw new TypeError('release issue.number must be a positive integer')
        }

        if (db) {
          const existing = db
            .prepare('SELECT name FROM claims WHERE repo = ? AND issue_number = ?')
            .get(issue.repo, issue.number) as { name: string } | undefined
          if (existing === undefined) {
            throw new Error(
              `Cannot release Issue #${issue.number} in ${issue.repo}: no local Claim exists`,
            )
          }
        } else {
          throw new Error(
            `Cannot release Issue #${issue.number} in ${issue.repo}: no local Claim exists`,
          )
        }

        db.prepare('DELETE FROM claims WHERE repo = ? AND issue_number = ?').run(
          issue.repo,
          issue.number,
        )
      },
    },
  }
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isEnoent(error)) {
      return false
    }
    throw error
  }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) {
      return ''
    }
    throw error
  }
}

async function ensureCloneLocalWorktreeExclusion(workingDir: string): Promise<void> {
  const gitCommonDir = resolveGitCommonDir(workingDir)
  const excludePath = join(gitCommonDir, 'info', 'exclude')
  await mkdir(join(gitCommonDir, 'info'), { recursive: true })
  const exclude = await readTextIfExists(excludePath)
  const merged = mergeExactLine(exclude, '/.worktrees/')
  if (merged !== exclude) {
    await writeFile(excludePath, merged, 'utf8')
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
