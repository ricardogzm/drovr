import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openProjectDatabase } from './db'
import { createDrovr } from './drovr'
import { isBeneathManagedWorktrees, resolveGitWorktreeRoot } from './git'
import { acquireCheckoutLock } from './lock'
import { createDrovrLogger } from './log'
import type { DrovrLoggerCounts } from './log'
import { mergeExactLine } from './merge-line'

const WORKFLOW_RELATIVE_PATH = '.drovr/main.ts'
const DROVR_GITIGNORE_RELATIVE_PATH = '.drovr/.gitignore'
const SQLITE_IGNORE_LINE = 'state.sqlite*'
const LOG_IGNORE_LINE = 'drovr.log'
const LOCK_IGNORE_LINE = 'start.lock*'
export interface StartOptions {
  resume?: boolean
  verbose?: boolean
}

export async function runStart(cwd: string, options: StartOptions = {}): Promise<void> {
  const mode = options.resume ? 'resume' : 'fresh'
  const root = resolveGitWorktreeRoot(cwd, 'drovr start')
  if (isBeneathManagedWorktrees(cwd, root)) {
    throw new Error("drovr start cannot run from beneath this repository's managed .worktrees area")
  }
  const drovrDir = join(root, '.drovr')
  await mkdir(drovrDir, { recursive: true })

  const lock = acquireCheckoutLock(join(drovrDir, 'start.lock'))
  try {
    await applyLazyHygiene(root)
    const logPath = join(drovrDir, 'drovr.log')
    const logger = createDrovrLogger({ logPath, verbose: options.verbose })
    logger.startBegin(mode)

    const counts: DrovrLoggerCounts = { started: 0, skipped: 0, completed: 0, failed: 0 }
    let failed = false

    try {
      const dbPath = join(drovrDir, 'state.sqlite')
      if (options.resume && !(await fileExists(dbPath))) {
        throw new Error(
          'drovr start --resume requires an existing Project database at .drovr/state.sqlite',
        )
      }

      const db = openProjectDatabase(dbPath, { mode })
      try {
        const workflowPath = join(root, WORKFLOW_RELATIVE_PATH)
        if (!(await fileExists(workflowPath))) {
          throw new Error('drovr start found no Workflow at .drovr/main.ts')
        }

        // Dynamic import of user workflow from filesystem (runtime-authored path)
        const workflowUrl = pathToFileURL(workflowPath).href
        const mod = await import(workflowUrl)
        if (typeof mod.default !== 'function') {
          throw new Error('Workflow at .drovr/main.ts must default export a function')
        }

        const drovr = createDrovr({ db, logger, counts, root })
        await mod.default(drovr)
      } finally {
        db.close()
      }
    } catch (err) {
      failed = true
      logger.startFail(mode, counts, err)
      throw err
    } finally {
      if (!failed) {
        logger.startComplete(mode, counts)
      }
      await logger.close()
    }
  } finally {
    lock.release()
  }
}

async function applyLazyHygiene(root: string): Promise<void> {
  const drovrGitignorePath = join(root, DROVR_GITIGNORE_RELATIVE_PATH)
  let drovrGitignore = await readTextIfExists(drovrGitignorePath)
  drovrGitignore = mergeExactLine(drovrGitignore, SQLITE_IGNORE_LINE)
  drovrGitignore = mergeExactLine(drovrGitignore, LOG_IGNORE_LINE)
  drovrGitignore = mergeExactLine(drovrGitignore, LOCK_IGNORE_LINE)
  await writeFile(drovrGitignorePath, drovrGitignore, 'utf8')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
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

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
