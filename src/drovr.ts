import { EventEmitter } from 'node:events'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
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
  resolveGitCommonDir,
  resolveGitWorktreeRoot,
  runGit,
  safeRealpath,
} from './git'
import { runWorktreeSetup } from './worktree-setup'
import {
  closeHerdrWorkspace,
  createHerdrWorkspace,
  getHerdrAgent,
  promptHerdrOmpWorker,
  startHerdrOmpWorker,
  waitHerdrOmpWorker,
} from './herdr'
import type { Drovr, Issue, Name, Resource, Worker, Worktree } from './index'
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

function normalizePortSpec(spec: unknown): number[] {
  if (typeof spec === 'number') {
    if (!Number.isInteger(spec) || spec < 1 || spec > 65535) {
      throw new TypeError('resource ports must be integers from 1 through 65535')
    }
    return [spec]
  }

  if (Array.isArray(spec)) {
    if (spec.length === 0) {
      throw new TypeError('resource ports list must be nonempty')
    }
    const ports = spec.map((port) => {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new TypeError('resource ports must be integers from 1 through 65535')
      }
      return port
    })
    if (new Set(ports).size !== ports.length) {
      throw new TypeError('resource ports list must not contain duplicates')
    }
    return ports.sort((a, b) => a - b)
  }

  if (typeof spec === 'object' && spec !== null && 'from' in spec && 'to' in spec) {
    const range = spec as { from?: unknown; to?: unknown }
    const from = range.from
    const to = range.to
    if (
      typeof from !== 'number' ||
      !Number.isInteger(from) ||
      from < 1 ||
      from > 65535 ||
      typeof to !== 'number' ||
      !Number.isInteger(to) ||
      to < 1 ||
      to > 65535
    ) {
      throw new TypeError('resource port range endpoints must be integers from 1 through 65535')
    }
    if (from > to) {
      throw new TypeError('resource port range must not be reversed')
    }
    return Array.from({ length: to - from + 1 }, (_, index) => from + index)
  }

  throw new TypeError('resource ports must be a port, nonempty list, or range')
}

function samePorts(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((port, index) => port === right[index])
}

type PortProbeStatus = 'available' | 'in-use' | 'unavailable'
function probeLoopbackPort(port: number, host: '127.0.0.1' | '::1'): Promise<PortProbeStatus> {
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const finish = (status: PortProbeStatus) => {
      if (settled) return
      settled = true
      try {
        server.close(() => resolve(status))
      } catch {
        resolve(status)
      }
    }
    server.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'EADDRINUSE' ? 'in-use' : 'unavailable')
    })
    try {
      server.listen({ port, host, exclusive: true }, () => finish('available'))
    } catch {
      finish('unavailable')
    }
  })
}

export function createDrovr(context: DrovrContext = {}): Drovr {
  const { db, logger, counts, root, cwd, mode = 'fresh' } = context
  const workingDir = root ?? cwd ?? process.cwd()
  const activePrompts = new Set<Name>()
  const activeLeaseCounts = new Map<string, number>()
  const resourceReleaseNotifier = new EventEmitter()
  resourceReleaseNotifier.setMaxListeners(0)
  async function waitForResourceRelease(
    resourceName: string,
    portResource: boolean,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const eventName = portResource ? 'release:port' : `release:${resourceName}`
      const onRelease = () => {
        cleanup()
        resolve()
      }
      const cleanup = () => {
        clearTimeout(timer)
        resourceReleaseNotifier.removeListener(eventName, onRelease)
      }
      resourceReleaseNotifier.once(eventName, onRelease)
      timer = setTimeout(() => {
        cleanup()
        resolve()
      }, 25)
    })
  }

  return {
    async resource(
      name: string,
      spec:
        | { capacity: number }
        | {
            ports: number | readonly number[] | { from: number; to: number }
          },
    ): Promise<Resource> {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('resource name must be a non-empty string')
      }
      if (typeof spec !== 'object' || spec === null) {
        throw new TypeError('resource spec must be an object')
      }
      if ('capacity' in spec && 'ports' in spec) {
        throw new TypeError('resource spec cannot contain both capacity and ports')
      }
      if (!('capacity' in spec) && !('ports' in spec)) {
        throw new TypeError('resource spec must contain capacity or ports')
      }

      const isPortResource = 'ports' in spec
      const normalizedPorts: number[] | undefined = isPortResource
        ? normalizePortSpec(spec.ports)
        : undefined
      const capacity = 'capacity' in spec ? spec.capacity : 1
      if (
        !isPortResource &&
        (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1)
      ) {
        throw new TypeError('resource capacity must be a positive integer')
      }

      if (db) {
        db.exec('BEGIN IMMEDIATE;')
        try {
          const existing = db
            .prepare('SELECT type, capacity FROM resources WHERE name = ?')
            .get(name) as { type: string; capacity: number } | undefined
          const occupancy = existing
            ? ((
                db
                  .prepare('SELECT COUNT(*) as count FROM leases WHERE resource_name = ?')
                  .get(name) as {
                  count: number
                }
              ).count as number)
            : 0

          if (existing === undefined) {
            db.prepare('INSERT INTO resources (name, type, capacity) VALUES (?, ?, ?)').run(
              name,
              isPortResource ? 'port' : 'capacity',
              capacity,
            )
            if (isPortResource) {
              for (const port of normalizedPorts ?? []) {
                db.prepare('INSERT INTO resource_ports (resource_name, port) VALUES (?, ?)').run(
                  name,
                  port,
                )
              }
            }
          } else if (isPortResource) {
            const currentPorts =
              existing.type === 'port'
                ? (
                    db
                      .prepare(
                        'SELECT port FROM resource_ports WHERE resource_name = ? ORDER BY port',
                      )
                      .all(name) as Array<{ port: number }>
                  ).map((row) => row.port)
                : []
            const changed = !samePorts(currentPorts, normalizedPorts ?? [])
            if (changed && occupancy > 0) {
              throw new Error(`cannot change ports of resource "${name}" while it has live leases`)
            }
            if (changed || existing.type !== 'port') {
              db.prepare('DELETE FROM resource_ports WHERE resource_name = ?').run(name)
              for (const port of normalizedPorts ?? []) {
                db.prepare('INSERT INTO resource_ports (resource_name, port) VALUES (?, ?)').run(
                  name,
                  port,
                )
              }
            }
            db.prepare('UPDATE resources SET type = ?, capacity = ? WHERE name = ?').run(
              'port',
              1,
              name,
            )
          } else {
            if (existing.type === 'port' && occupancy > 0) {
              throw new Error(`cannot change resource "${name}" while it has live leases`)
            }
            if ((capacity as number) < occupancy) {
              throw new Error(
                `cannot reduce capacity of resource "${name}" from ${existing.capacity} to ${capacity} below live occupancy of ${occupancy}`,
              )
            }
            db.prepare('DELETE FROM resource_ports WHERE resource_name = ?').run(name)
            db.prepare('UPDATE resources SET type = ?, capacity = ? WHERE name = ?').run(
              'capacity',
              capacity,
              name,
            )
          }
          db.exec('COMMIT;')
        } catch (error) {
          try {
            db.exec('ROLLBACK;')
          } catch {}
          throw error
        }
      }

      return Object.freeze({
        async lease<T>(opts: { name: Name }, fn: () => Promise<T>): Promise<T> {
          if (typeof opts !== 'object' || opts === null) {
            throw new TypeError('lease options must be an object')
          }
          if (!isValidName(opts.name)) {
            throw new TypeError(
              `Invalid name: "${String(opts.name)}". Names must match [a-z][a-z0-9_-]{0,31}`,
            )
          }
          if (typeof fn !== 'function') {
            throw new TypeError('lease callback must be a function')
          }

          logger?.resourceLeaseRequest(name, opts.name)

          const leaseKey = `${name}:${opts.name}`
          let hasWaited = false

          while (true) {
            let acquired = false

            if (db) {
              db.exec('BEGIN IMMEDIATE;')
              try {
                const existingLease = db
                  .prepare('SELECT 1 FROM leases WHERE resource_name = ? AND name = ?')
                  .get(name, opts.name)

                if (existingLease !== undefined) {
                  acquired = true
                } else {
                  const resRow = db
                    .prepare('SELECT type, capacity FROM resources WHERE name = ?')
                    .get(name) as { type: string; capacity: number } | undefined

                  if (!resRow) {
                    throw new Error(`resource "${name}" not found in database`)
                  }

                  let canAcquire = false
                  if (resRow.type === 'port') {
                    const conflict = db
                      .prepare(
                        `SELECT 1
                           FROM leases AS lease
                           JOIN resource_ports AS lease_port
                             ON lease_port.resource_name = lease.resource_name
                          WHERE lease_port.port IN (
                            SELECT port FROM resource_ports WHERE resource_name = ?
                          )
                          LIMIT 1`,
                      )
                      .get(name)
                    canAcquire = conflict === undefined
                  } else {
                    const occupancyRow = db
                      .prepare('SELECT COUNT(*) as count FROM leases WHERE resource_name = ?')
                      .get(name) as { count: number }
                    canAcquire = occupancyRow.count < resRow.capacity
                  }

                  if (canAcquire) {
                    db.prepare('INSERT INTO leases (resource_name, name) VALUES (?, ?)').run(
                      name,
                      opts.name,
                    )
                    acquired = true
                  }
                }
                db.exec('COMMIT;')
              } catch (err) {
                try {
                  db.exec('ROLLBACK;')
                } catch {}
                throw err
              }
            } else {
              acquired = true
            }

            if (acquired) {
              activeLeaseCounts.set(leaseKey, (activeLeaseCounts.get(leaseKey) ?? 0) + 1)
              break
            }

            if (!hasWaited) {
              hasWaited = true
              logger?.resourceLeaseWait(name, opts.name)
            }

            await waitForResourceRelease(name, isPortResource)
          }

          logger?.resourceLeaseAcquire(name, opts.name)
          if (normalizedPorts !== undefined) {
            for (const port of normalizedPorts) {
              for (const host of ['127.0.0.1', '::1'] as const) {
                void probeLoopbackPort(port, host)
                  .then((status) => {
                    try {
                      logger?.resourcePortsProbe?.(name, opts.name, port, host, status)
                    } catch {}
                  })
                  .catch(() => {})
              }
            }
          }
          try {
            return await fn()
          } finally {
            const remaining = (activeLeaseCounts.get(leaseKey) ?? 1) - 1
            if (remaining <= 0) {
              if (db) {
                db.prepare('DELETE FROM leases WHERE resource_name = ? AND name = ?').run(
                  name,
                  opts.name,
                )
              }
              activeLeaseCounts.delete(leaseKey)
              resourceReleaseNotifier.emit(isPortResource ? 'release:port' : `release:${name}`)
            } else {
              activeLeaseCounts.set(leaseKey, remaining)
            }
          }
        },
      })
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
        const canonicalWorktreePath = safeRealpath(worktreePath)

        const worktrees = listGitWorktrees(workingDir)
        const matchingBranchEntries = worktrees.filter((w) => w.branch === fullBranchRef)
        const branchElsewhere = matchingBranchEntries.filter(
          (w) => safeRealpath(w.path) !== canonicalWorktreePath,
        )
        if (branchElsewhere.length > 0) {
          throw new Error(
            `Cannot resume Worktree "${name}": branch "${branchName}" is already checked out at "${branchElsewhere[0].path}".`,
          )
        }

        const matchingPathEntries = worktrees.filter(
          (w) => safeRealpath(w.path) === canonicalWorktreePath,
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

          const status = getWorktreeSetupStatus(db, name)
          if (status === 'complete') {
            await ensureCloneLocalWorktreeExclusion(workingDir)
            return Object.freeze({
              name,
              path: worktreePath,
            })
          }

          recordWorktreeSetupStatus(db, name, 'pending')
          await ensureCloneLocalWorktreeExclusion(workingDir)
          await runWorktreeSetup({
            worktreePath,
            name,
            startCheckout: resolveGitWorktreeRoot(workingDir),
          })
          recordWorktreeSetupStatus(db, name, 'complete')
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

        if (matchingPathEntries.length > 1) {
          throw new Error(
            `Cannot resume Worktree "${name}": multiple conflicting registrations found for path "${worktreePath}".`,
          )
        }

        if (matchingPathEntries.length === 1) {
          const reg = matchingPathEntries[0]
          if (reg.branch !== fullBranchRef) {
            throw new Error(
              `Cannot resume Worktree "${name}": stale registration at "${worktreePath}" is on branch "${reg.branch ?? 'detached HEAD'}", expected "${fullBranchRef}".`,
            )
          }
          if (reg.locked !== null) {
            throw new Error(
              `Cannot resume Worktree "${name}": Worktree registration at "${worktreePath}" is locked (${typeof reg.locked === 'string' ? reg.locked : 'locked'}).`,
            )
          }
          if (reg.prunable === null) {
            throw new Error(
              `Cannot resume Worktree "${name}": Worktree registration at "${worktreePath}" is not prunable.`,
            )
          }

          recordWorktreeSetupStatus(db, name, 'pending')
          await ensureCloneLocalWorktreeExclusion(workingDir)
          runGit(workingDir, ['worktree', 'add', '--force', worktreePath, branchName])
          await runWorktreeSetup({
            worktreePath,
            name,
            startCheckout: resolveGitWorktreeRoot(workingDir),
          })
          recordWorktreeSetupStatus(db, name, 'complete')

          return Object.freeze({
            name,
            path: worktreePath,
          })
        }

        recordWorktreeSetupStatus(db, name, 'pending')
        await ensureCloneLocalWorktreeExclusion(workingDir)
        runGit(workingDir, ['worktree', 'add', worktreePath, branchName])
        await runWorktreeSetup({
          worktreePath,
          name,
          startCheckout: resolveGitWorktreeRoot(workingDir),
        })
        recordWorktreeSetupStatus(db, name, 'complete')

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

      if (isGitCheckoutDirty(workingDir)) {
        process.stderr.write('Warning: Start checkout has uncommitted changes\n')
      }

      recordWorktreeSetupStatus(db, name, 'pending')
      await ensureCloneLocalWorktreeExclusion(workingDir)
      runGit(workingDir, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'])
      await runWorktreeSetup({
        worktreePath,
        name,
        startCheckout: resolveGitWorktreeRoot(workingDir),
      })
      recordWorktreeSetupStatus(db, name, 'complete')

      return Object.freeze({
        name,
        path: worktreePath,
      })
    },
    async start(opts: { name: Name; cwd: string }): Promise<Worker> {
      if (typeof opts !== 'object' || opts === null) {
        throw new TypeError('start options must be an object')
      }
      if (!isValidName(opts.name)) {
        throw new TypeError(
          `Invalid name: "${String(opts.name)}". Names must match [a-z][a-z0-9_-]{0,31}`,
        )
      }
      if (typeof opts.cwd !== 'string' || opts.cwd.trim() === '') {
        throw new TypeError('start opts.cwd must be a non-empty string')
      }

      const name = opts.name
      const targetCwd = opts.cwd

      const createWorkerHandle = (): Worker =>
        Object.freeze({
          async prompt(text: string): Promise<void> {
            if (typeof text !== 'string') {
              throw new TypeError('prompt text must be a string')
            }
            if (activePrompts.has(name)) {
              throw new Error(`worker "${name}" is already executing a prompt`)
            }
            activePrompts.add(name)
            try {
              await promptHerdrOmpWorker(workingDir, { name, text })
            } finally {
              activePrompts.delete(name)
            }
          },
        })

      if (mode === 'resume') {
        const existingAgent = getHerdrAgent(workingDir, name)
        if (existingAgent) {
          const canonicalExistingCwd = safeRealpath(existingAgent.cwd)
          const canonicalTargetCwd = safeRealpath(targetCwd)
          if (canonicalExistingCwd !== canonicalTargetCwd && existingAgent.cwd !== targetCwd) {
            throw new Error(
              `Cannot resume Worker "${name}": Worker cwd "${existingAgent.cwd}" does not match Worktree path "${targetCwd}".`,
            )
          }

          if (existingAgent.agentStatus !== 'idle' && existingAgent.agentStatus !== 'done') {
            await waitHerdrOmpWorker(workingDir, { name })
          }

          return createWorkerHandle()
        }
      }

      const { workspaceId, rootPaneId } = createHerdrWorkspace(workingDir, {
        workspaceCwd: targetCwd,
        label: name,
        noFocus: true,
      })

      try {
        startHerdrOmpWorker(workingDir, {
          name,
          paneId: rootPaneId,
        })
      } catch (err) {
        try {
          closeHerdrWorkspace(workingDir, workspaceId)
        } catch {}
        throw err
      }

      return createWorkerHandle()
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

type WorktreeSetupStatus = 'pending' | 'complete'

function recordWorktreeSetupStatus(
  db: DatabaseSync | undefined,
  name: Name,
  status: WorktreeSetupStatus,
): void {
  if (!db) {
    return
  }
  db.prepare(
    'INSERT INTO worktree_setups (name, status) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET status = excluded.status',
  ).run(name, status)
}

function getWorktreeSetupStatus(
  db: DatabaseSync | undefined,
  name: Name,
): WorktreeSetupStatus | undefined {
  if (!db) {
    return undefined
  }
  const row = db.prepare('SELECT status FROM worktree_setups WHERE name = ?').get(name) as
    | { status: WorktreeSetupStatus }
    | undefined
  return row?.status
}
