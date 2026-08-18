import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openProjectDatabase } from './db'
import { createDrovr } from './drovr'
import { resolveGitWorktreeRoot } from './git'
import { acquireCheckoutLock } from './lock'
import { mergeExactLine } from './merge-line'

const WORKFLOW_RELATIVE_PATH = '.drovr/main.ts'
const DROVR_GITIGNORE_RELATIVE_PATH = '.drovr/.gitignore'
const SQLITE_IGNORE_LINE = 'state.sqlite*'
const LOG_IGNORE_LINE = 'drovr.log'

export async function runStart(cwd: string): Promise<void> {
  const root = resolveGitWorktreeRoot(cwd, 'drovr start')
  const drovrDir = join(root, '.drovr')
  await mkdir(drovrDir, { recursive: true })

  const lock = acquireCheckoutLock(join(drovrDir, 'start.lock'))
  try {
    await applyLazyHygiene(root)
    const db = openProjectDatabase(join(drovrDir, 'state.sqlite'))
    try {
      const workflowPath = join(root, WORKFLOW_RELATIVE_PATH)
      if (!(await fileExists(workflowPath))) {
        throw new Error('drovr start found no Workflow at .drovr/main.ts')
      }

      // Dynamic import of user workflow from filesystem
      const workflowUrl = pathToFileURL(workflowPath).href
      const mod = await import(workflowUrl)
      if (typeof mod.default !== 'function') {
        throw new Error('Workflow at .drovr/main.ts must default export a function')
      }

      const drovr = createDrovr()
      await mod.default(drovr)
    } finally {
      db.close()
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
