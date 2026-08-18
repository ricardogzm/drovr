import { execFileSync } from 'node:child_process'

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
