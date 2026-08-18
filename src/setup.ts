import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveGitCommonDir, resolveGitWorktreeRoot } from './git'
import { mergeExactLine } from './merge-line'

const WORKFLOW_RELATIVE_PATH = '.drovr/main.ts'
const DROPVR_GITIGNORE_RELATIVE_PATH = '.drovr/.gitignore'
const SQLITE_IGNORE_LINE = 'state.sqlite*'
const LOG_IGNORE_LINE = 'drovr.log'
const WORKTREE_EXCLUDE_LINE = '/.worktrees/'

const STARTER_WORKFLOW = `import type { Drovr } from "drovr"

export default async function workflow(_drovr: Drovr): Promise<void> {}
`

export async function runSetup(cwd: string): Promise<void> {
  const root = resolveGitWorktreeRoot(cwd)
  const workflowPath = join(root, WORKFLOW_RELATIVE_PATH)
  const drovrGitignorePath = join(root, DROPVR_GITIGNORE_RELATIVE_PATH)
  const gitCommonDir = resolveGitCommonDir(cwd)
  const excludePath = join(gitCommonDir, 'info', 'exclude')

  if (await fileExists(workflowPath)) {
    throw new Error('drovr setup found an existing Workflow at .drovr/main.ts')
  }

  await mkdir(join(root, '.drovr'), { recursive: true })
  await writeFile(workflowPath, STARTER_WORKFLOW, 'utf8')

  let drovrGitignore = await readTextIfExists(drovrGitignorePath)
  drovrGitignore = mergeExactLine(drovrGitignore, SQLITE_IGNORE_LINE)
  drovrGitignore = mergeExactLine(drovrGitignore, LOG_IGNORE_LINE)
  await writeFile(drovrGitignorePath, drovrGitignore, 'utf8')

  await mkdir(join(gitCommonDir, 'info'), { recursive: true })
  const exclude = await readTextIfExists(excludePath)
  await writeFile(excludePath, mergeExactLine(exclude, WORKTREE_EXCLUDE_LINE), 'utf8')
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
