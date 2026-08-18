import type { DatabaseSync } from 'node:sqlite'
import {
  assignIssue,
  getAuthenticatedUser,
  getRepoFromStartCheckout,
  listReadyIssues,
  normalizeIssue,
  viewIssue,
} from './gh'
import type { Drovr, Issue, Name } from './index'
import type { DrovrLogger, DrovrLoggerCounts } from './log'

export interface DrovrContext {
  db?: DatabaseSync
  logger?: DrovrLogger
  counts?: DrovrLoggerCounts
  root?: string
  cwd?: string
}

const NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/

export function isValidName(name: unknown): name is Name {
  return typeof name === 'string' && NAME_REGEX.test(name)
}

export function createDrovr(context: DrovrContext = {}): Drovr {
  const { db, logger, counts, root, cwd } = context
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
    async worktree() {
      throw new Error('worktree is not implemented yet')
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
                  const hasReadyLabel =
                    Array.isArray(raw.labels) &&
                    raw.labels.some(
                      (l) => (typeof l === 'string' ? l : l?.name) === 'ready-for-agent',
                    )
                  if (hasReadyLabel) {
                    resultIssues.push(normalizeIssue(raw, targetRepo))
                  }
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
              if (raced && raced.name !== opts.name) {
                throw new Error(
                  `Issue #${issue.number} in ${issue.repo} is already claimed by ${raced.name}`,
                )
              }
              throw err
            }
          }
        }

        const user = getAuthenticatedUser(workingDir)
        assignIssue(workingDir, issue.repo, issue.number, user)
      },
      async close() {
        throw new Error('issues.close is not implemented yet')
      },
      async release() {
        throw new Error('issues.release is not implemented yet')
      },
    },
  }
}
