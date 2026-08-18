import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\r?\n$/, '')
}

export function resolveGitWorktreeRoot(cwd: string, command: string = 'drovr setup'): string {
  try {
    return runGit(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new Error(`${command} must run inside a git worktree`)
  }
}

export function resolveGitDir(cwd: string): string {
  const gitDir = runGit(cwd, ['rev-parse', '--git-dir'])
  const resolved = isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir)
  return safeRealpath(resolved)
}

export function resolveGitCommonDir(cwd: string): string {
  const gitCommonDir = runGit(cwd, ['rev-parse', '--git-common-dir'])
  const resolved = isAbsolute(gitCommonDir) ? gitCommonDir : resolve(cwd, gitCommonDir)
  return safeRealpath(resolved)
}

export function isGitCheckoutDirty(cwd: string): boolean {
  return runGit(cwd, ['status', '--porcelain', '--untracked-files=normal']).length > 0
}

export function isGitBranchPresent(cwd: string, branchName: string): boolean {
  const ref = `refs/heads/${branchName}`
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', ref], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.error) {
    throw result.error
  }
  if (result.status === 0) {
    return true
  }
  if (result.status === 1) {
    const revCheck = spawnSync('git', ['rev-parse', '--verify', ref], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (revCheck.stderr.includes('broken ref') || revCheck.stderr.includes('corrupt')) {
      throw new Error(`Git reference "${ref}" is broken or corrupt: ${revCheck.stderr.trim()}`)
    }
    return false
  }

  throw new Error(`git show-ref failed with exit code ${result.status}: ${result.stderr.trim()}`)
}

export function getGitWorktreeSymbolicRef(cwd: string): string | null {
  const result = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    throw result.error
  }
  if (result.status === 0) {
    return result.stdout.replace(/\r?\n$/, '')
  }
  if (result.status === 1) {
    const revCheck = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (revCheck.error) {
      throw revCheck.error
    }
    if (revCheck.stderr.includes('broken ref') || revCheck.stderr.includes('corrupt')) {
      throw new Error(`Git reference in "${cwd}" is broken or corrupt: ${revCheck.stderr.trim()}`)
    }
    return null
  }
  throw new Error(
    `git symbolic-ref failed with exit code ${result.status}: ${result.stderr.trim()}`,
  )
}

export interface GitWorktreeEntry {
  path: string
  head: string
  branch: string | null
  detached: boolean
  bare: boolean
  prunable: boolean | string | null
  locked: boolean | string | null
}

export function listGitWorktrees(cwd: string): GitWorktreeEntry[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entries: GitWorktreeEntry[] = []
  const records = output.split('\0')
  let current: GitWorktreeEntry | null = null

  for (const line of records) {
    if (line === '') {
      if (current) {
        entries.push(current)
        current = null
      }
      continue
    }
    if (line.startsWith('worktree ')) {
      if (current) {
        entries.push(current)
      }
      current = {
        path: line.slice('worktree '.length),
        head: '',
        branch: null,
        detached: false,
        bare: false,
        prunable: null,
        locked: null,
      }
    } else if (current) {
      if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length)
      } else if (line === 'detached') {
        current.detached = true
      } else if (line === 'bare') {
        current.bare = true
      } else if (line.startsWith('prunable')) {
        current.prunable = line.slice('prunable'.length).trim() || true
      } else if (line.startsWith('locked')) {
        current.locked = line.slice('locked'.length).trim() || true
      }
    }
  }
  if (current) {
    entries.push(current)
  }
  return entries
}

export function isGitWorktreeOfRepository(worktreePath: string, repositoryDir: string): boolean {
  try {
    const wtRoot = runGit(worktreePath, ['rev-parse', '--show-toplevel'])
    if (safeRealpath(wtRoot) !== safeRealpath(worktreePath)) {
      return false
    }
    const wtCommon = resolveGitCommonDir(worktreePath)
    const repoCommon = resolveGitCommonDir(repositoryDir)
    return wtCommon === repoCommon
  } catch {
    return false
  }
}

export function isBeneathManagedWorktrees(cwd: string, root: string): boolean {
  const registered = listGitWorktrees(cwd)
  const candidatePaths = [safeRealpath(cwd), safeRealpath(root), resolve(cwd), resolve(root)]

  for (const entry of registered) {
    const realRegRoot = safeRealpath(entry.path)
    const managedAreas = [join(realRegRoot, '.worktrees'), join(entry.path, '.worktrees')]

    for (const managed of managedAreas) {
      const realManaged = safeRealpath(managed)
      for (const cand of candidatePaths) {
        if (isPathBeneath(cand, realManaged) || isPathBeneath(cand, managed)) {
          return true
        }
      }
    }
  }

  return false
}

export function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return resolve(p)
    }
    throw err
  }
}

function isPathBeneath(target: string, parent: string): boolean {
  const rel = relative(parent, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
