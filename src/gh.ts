import { execFileSync } from 'node:child_process'
import type { Issue } from './index'

export interface RawGhIssue {
  number?: number
  title?: string
  body?: string
  url?: string
  state?: string
  labels?: Array<string | { name?: string }>
  assignees?: Array<string | { login?: string }>
  author?: { login?: string } | string | null
  createdAt?: string
  updatedAt?: string
}

export function runGh(cwd: string, args: string[]): string {
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd()
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'stderr' in error && error.stderr) {
      const stderrText =
        typeof error.stderr === 'string'
          ? error.stderr
          : Buffer.isBuffer(error.stderr)
            ? error.stderr.toString('utf8')
            : ''
      if (stderrText.trim().length > 0) {
        throw new Error(`gh error: ${stderrText.trim()}`)
      }
    }
    throw error
  }
}

export function getRepoFromStartCheckout(cwd: string): string {
  const output = runGh(cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  try {
    const parsed = JSON.parse(output) as { nameWithOwner?: string }
    if (typeof parsed.nameWithOwner === 'string' && parsed.nameWithOwner.length > 0) {
      return parsed.nameWithOwner
    }
  } catch {}
  throw new Error(`failed to resolve repository from Start checkout at ${cwd}`)
}

export function getAuthenticatedUser(cwd: string): string {
  const output = runGh(cwd, ['api', 'user'])
  try {
    const parsed = JSON.parse(output) as { login?: string }
    if (typeof parsed.login === 'string' && parsed.login.length > 0) {
      return parsed.login
    }
  } catch {}
  throw new Error('failed to resolve authenticated user from gh')
}

const ISSUE_JSON_FIELDS = 'assignees,author,body,createdAt,labels,number,state,title,updatedAt,url'

export function listReadyIssues(cwd: string, repo: string): RawGhIssue[] {
  const output = runGh(cwd, [
    'issue',
    'list',
    '--state',
    'open',
    '--label',
    'ready-for-agent',
    '--limit',
    '1000',
    '--json',
    ISSUE_JSON_FIELDS,
    '-R',
    repo,
  ])
  try {
    const parsed = JSON.parse(output)
    if (Array.isArray(parsed)) {
      return parsed as RawGhIssue[]
    }
  } catch {}
  return []
}

export function viewIssue(cwd: string, repo: string, issueNumber: number): RawGhIssue | null {
  try {
    const output = runGh(cwd, [
      'issue',
      'view',
      String(issueNumber),
      '--json',
      ISSUE_JSON_FIELDS,
      '-R',
      repo,
    ])
    const parsed = JSON.parse(output)
    if (parsed && typeof parsed === 'object') {
      return parsed as RawGhIssue
    }
  } catch {}
  return null
}

export function assignIssue(cwd: string, repo: string, issueNumber: number, login: string): void {
  runGh(cwd, ['issue', 'edit', String(issueNumber), '-R', repo, '--add-assignee', login])
}

export function closeIssue(cwd: string, repo: string, issueNumber: number): void {
  runGh(cwd, ['issue', 'close', String(issueNumber), '-R', repo])
}

export function normalizeIssue(raw: RawGhIssue, repo: string): Issue {
  const labels = Object.freeze(
    Array.isArray(raw.labels)
      ? raw.labels.map((l) => (typeof l === 'string' ? l : String(l?.name ?? '')))
      : [],
  )
  const assignees = Object.freeze(
    Array.isArray(raw.assignees)
      ? raw.assignees.map((a) => (typeof a === 'string' ? a : String(a?.login ?? '')))
      : [],
  )
  const author =
    raw.author && typeof raw.author === 'object' && 'login' in raw.author && raw.author.login
      ? String(raw.author.login)
      : typeof raw.author === 'string'
        ? raw.author
        : null

  const issue: Issue = {
    repo,
    number: Number(raw.number),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    url: String(raw.url ?? ''),
    state: raw.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    labels,
    assignees,
    author,
    createdAt: String(raw.createdAt ?? ''),
    updatedAt: String(raw.updatedAt ?? ''),
  }
  return Object.freeze(issue)
}
