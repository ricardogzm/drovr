import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

export function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
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
  return gitDir.startsWith('/') ? gitDir : `${cwd}/${gitDir}`
}

export function resolveGitCommonDir(cwd: string): string {
  const gitCommonDir = runGit(cwd, ['rev-parse', '--git-common-dir'])
  return gitCommonDir.startsWith('/') ? gitCommonDir : `${cwd}/${gitCommonDir}`
}

export function isGitCheckoutDirty(cwd: string): boolean {
  return runGit(cwd, ['status', '--porcelain']).length > 0
}

export function isGitBranchPresent(cwd: string, branchName: string): boolean {
  try {
    runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branchName}`])
    return true
  } catch {
    return false
  }
}

export function isBeneathManagedWorktrees(cwd: string, root: string): boolean {
  try {
    const commonDir = resolveGitCommonDir(cwd)
    const mainRepoRoot = dirname(commonDir)
    const managedArea = join(mainRepoRoot, '.worktrees')
    const check = (p: string): boolean => {
      const resolved = resolve(p)
      return resolved === managedArea || resolved.startsWith(managedArea + '/')
    }
    return check(cwd) || check(root)
  } catch {
    return false
  }
}
