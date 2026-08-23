import { runGit } from './git'

export const VALID_COMMIT_TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'remove',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
] as const

export type CommitType = (typeof VALID_COMMIT_TYPES)[number]

export interface ParsedCommit {
  raw: string
  type: CommitType | null
  scope: string | null
  isBreaking: boolean
  subject: string
  body: string | null
  isMergeCommit: boolean
}

export type ValidationResult =
  | { valid: true; parsed: ParsedCommit }
  | { valid: false; error: string }

const MERGE_COMMIT_PATTERN =
  /^Merge (?:pull request #[0-9]+(?: from \S+)?|branch '[^']+'(?: of \S+)?(?: into \S+)?|branch "[^"]+"(?: of \S+)?(?: into \S+)?|remote-tracking branch '[^']+'(?: into \S+)?|remote-tracking branch "[^"]+"(?: into \S+)?|'[^']+' into \S+|"[^"]+" into \S+)/i

const BREAKING_FOOTER_PATTERN = /^(BREAKING CHANGE|BREAKING-CHANGE):\s*(.+)$/m

export function parseCommitMessage(message: string): ValidationResult {
  const trimmed = message.trim()
  if (trimmed.length === 0) {
    return {
      valid: false,
      error: 'commit message or title cannot be empty',
    }
  }

  const lines = trimmed.split(/\r?\n/)
  const header = lines[0]?.trim() ?? ''
  const body = lines.slice(1).join('\n').trim()

  if (MERGE_COMMIT_PATTERN.test(header)) {
    return {
      valid: true,
      parsed: {
        raw: message,
        type: null,
        scope: null,
        isBreaking: false,
        subject: header,
        body: body.length > 0 ? body : null,
        isMergeCommit: true,
      },
    }
  }

  // Check for malformed scope syntax before general header matching
  const scopeOpenIndex = header.indexOf('(')
  const colonIndex = header.indexOf(':')
  if (scopeOpenIndex !== -1 && (colonIndex === -1 || scopeOpenIndex < colonIndex)) {
    const scopeCloseIndex = header.indexOf(')', scopeOpenIndex)
    if (
      scopeCloseIndex === -1 ||
      scopeCloseIndex > colonIndex ||
      scopeCloseIndex === scopeOpenIndex + 1
    ) {
      return {
        valid: false,
        error: 'malformed scope in commit header',
      }
    }
  }

  const headerMatch = /^([a-zA-Z0-9_-]+)(?:\(([^)]+)\))?(!)?:\s*(.*)$/.exec(header)
  if (!headerMatch) {
    return {
      valid: false,
      error: 'commit message header must match "<type>(<scope>): <subject>" or "<type>: <subject>"',
    }
  }

  const [, rawType, scope, bang, rawSubject] = headerMatch
  const type = rawType.toLowerCase()

  if (!VALID_COMMIT_TYPES.includes(type as CommitType)) {
    return {
      valid: false,
      error: `unknown commit type "${rawType}". Expected one of: ${VALID_COMMIT_TYPES.join(', ')}`,
    }
  }

  if (!rawSubject || rawSubject.trim().length === 0) {
    return {
      valid: false,
      error: 'commit subject cannot be empty',
    }
  }

  const hasBreakingFooter = BREAKING_FOOTER_PATTERN.test(message)
  const isBreaking = bang === '!' || hasBreakingFooter

  return {
    valid: true,
    parsed: {
      raw: message,
      type: type as CommitType,
      scope: scope ?? null,
      isBreaking,
      subject: rawSubject.trim(),
      body: body.length > 0 ? body : null,
      isMergeCommit: false,
    },
  }
}

export type VersionBump = 'minor' | 'patch' | 'none'

export function classifyCommit(parsed: ParsedCommit): VersionBump {
  if (parsed.isMergeCommit) {
    return 'none'
  }
  if (parsed.isBreaking) {
    return 'minor'
  }
  if (parsed.type === 'feat') {
    return 'minor'
  }
  if (
    parsed.type === 'fix' ||
    parsed.type === 'perf' ||
    parsed.type === 'refactor' ||
    parsed.type === 'remove'
  ) {
    return 'patch'
  }
  return 'none'
}

export function classifyCommits(commits: ParsedCommit[]): VersionBump {
  let bump: VersionBump = 'none'
  for (const commit of commits) {
    const commitBump = classifyCommit(commit)
    if (commitBump === 'minor') {
      return 'minor'
    }
    if (commitBump === 'patch') {
      bump = 'patch'
    }
  }
  return bump
}

export function getGitCommitsInRange(
  cwd: string,
  options?: { from?: string | null; to?: string | null },
): ParsedCommit[] {
  let range = ''
  if (options?.from && options?.to) {
    range = `${options.from}..${options.to}`
  } else if (options?.from) {
    range = `${options.from}..HEAD`
  } else if (options?.to) {
    range = options.to
  } else {
    range = 'HEAD'
  }

  const args = ['log', '--reverse', range, '--format=%B%x00']
  let output = ''
  try {
    output = runGit(cwd, args)
  } catch {
    return []
  }

  if (!output || output.trim().length === 0) {
    return []
  }

  const rawCommits = output.split('\0').filter((c) => c.trim().length > 0)
  const parsedCommits: ParsedCommit[] = []
  for (const raw of rawCommits) {
    const res = parseCommitMessage(raw)
    if (res.valid) {
      parsedCommits.push(res.parsed)
    }
  }
  return parsedCommits
}

export function resolveRepoSlug(cwd: string, explicitRepo?: string | null): string {
  if (explicitRepo && explicitRepo.trim().length > 0) {
    return explicitRepo
      .trim()
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
  }
  try {
    const remoteUrl = runGit(cwd, ['config', '--get', 'remote.origin.url'])
    const match = /(?:github\.com[:/])([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remoteUrl.trim())
    if (match && match[1]) {
      return match[1]
    }
  } catch {}
  return 'ricardogzm/drovr'
}

function extractWhatsChangedSection(githubNotes: string): string | null {
  const match =
    /(^|\n)(#{1,3}\s+What's Changed[\s\S]*?)(?=\n#{1,3}\s+|\n\*\*Full Changelog\*\*|$)/i.exec(
      githubNotes,
    )
  if (!match) {
    return null
  }
  const rawSection = match[2].trim()
  const cleaned = rawSection
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('**Full Changelog**:'))
    .join('\n')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

export interface RenderReleaseNotesOptions {
  commits: ParsedCommit[]
  repo?: string | null
  tag: string
  prevTag?: string | null
  githubNotes?: string | null
}

export function renderReleaseNotes(options: RenderReleaseNotesOptions): string {
  const { commits, repo, tag, prevTag, githubNotes } = options
  if (!tag || tag.trim().length === 0) {
    throw new Error('missing required --tag argument')
  }
  const breaking: string[] = []
  const added: string[] = []
  const changed: string[] = []
  const fixed: string[] = []
  const removed: string[] = []

  for (const commit of commits) {
    if (commit.isMergeCommit) {
      continue
    }
    if (commit.isBreaking) {
      breaking.push(commit.subject)
      continue
    }
    if (commit.type === 'feat') {
      added.push(commit.subject)
    } else if (commit.type === 'perf' || commit.type === 'refactor') {
      changed.push(commit.subject)
    } else if (commit.type === 'fix') {
      fixed.push(commit.subject)
    } else if (commit.type === 'remove') {
      removed.push(commit.subject)
    }
  }

  const sections: string[] = []

  if (breaking.length > 0) {
    sections.push(`### Breaking Changes\n${breaking.map((s) => `- ${s}`).join('\n')}`)
  }
  if (added.length > 0) {
    sections.push(`### Added\n${added.map((s) => `- ${s}`).join('\n')}`)
  }
  if (changed.length > 0) {
    sections.push(`### Changed\n${changed.map((s) => `- ${s}`).join('\n')}`)
  }
  if (fixed.length > 0) {
    sections.push(`### Fixed\n${fixed.map((s) => `- ${s}`).join('\n')}`)
  }
  if (removed.length > 0) {
    sections.push(`### Removed\n${removed.map((s) => `- ${s}`).join('\n')}`)
  }

  if (githubNotes) {
    const whatsChanged = extractWhatsChangedSection(githubNotes)
    if (whatsChanged) {
      sections.push(whatsChanged)
    }
  }

  const repoSlug = repo
    ? repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
    : 'ricardogzm/drovr'
  const releaseTag = tag.trim()
  const changelogUrl = prevTag
    ? `https://github.com/${repoSlug}/compare/${prevTag}...${releaseTag}`
    : `https://github.com/${repoSlug}/commits/${releaseTag}`

  sections.push(`**Full Changelog**: ${changelogUrl}`)

  return sections.join('\n\n') + '\n'
}

export function getLatestReleaseTag(cwd: string): string | null {
  try {
    const tagsOutput = runGit(cwd, ['tag', '-l', 'v*', '--sort=-v:refname'])
    const tags = tagsOutput
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean)
    return tags[0] ?? null
  } catch {
    return null
  }
}

export function extractVersionFromPr(title?: string | null, body?: string | null): string {
  if (title) {
    const match =
      /release\s+v?([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?)/i.exec(title) ||
      /([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?)/.exec(title)
    if (match && match[1]) {
      return match[1]
    }
  }
  if (body) {
    const match = /##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?)/i.exec(body)
    if (match && match[1]) {
      return match[1]
    }
  }
  throw new Error(
    'Could not extract release version from pull request title or body. PR title or body must contain a valid SemVer version.',
  )
}

export function formatReleasePullRequestBody(
  originalBody: string,
  notes: string,
  version: string,
): string {
  const firstDelim = originalBody.indexOf('---')
  const lastDelim = originalBody.lastIndexOf('---')

  let header = ':robot: I have created a release *beep* *boop*\n---'
  let footer =
    '---\nThis PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#readme).'

  if (firstDelim !== -1 && lastDelim !== -1 && firstDelim !== lastDelim) {
    header = originalBody.slice(0, firstDelim + 3).trimEnd()
    footer = originalBody.slice(lastDelim).trimStart()
  }

  const cleanNotes = notes.trim()
  return `${header}\n\n\n## ${version}\n\n${cleanNotes}\n\n${footer}\n`
}

const USER_FACING_CATEGORY_REGEX = /(?:^|\n)### (?:Breaking Changes|Added|Changed|Fixed|Removed)/

export interface ReconcilePrOptions {
  title?: string | null
  body?: string | null
  cwd?: string
  repo?: string | null
}

export interface ReconcilePrResult {
  action: 'update' | 'close'
  version: string
  tag: string
  prevTag: string | null
  body: string
  reason?: string
}

export function reconcileReleasePullRequest(options: ReconcilePrOptions): ReconcilePrResult {
  const cwd = options.cwd ?? process.cwd()
  const version = extractVersionFromPr(options.title, options.body)
  const tag = `v${version}`
  const prevTag = getLatestReleaseTag(cwd)
  const from = prevTag
  const resolvedRepo = resolveRepoSlug(cwd, options.repo)

  const commits = getGitCommitsInRange(cwd, { from, to: 'HEAD' })
  const notes = renderReleaseNotes({
    commits,
    repo: resolvedRepo,
    tag,
    prevTag,
  })

  const hasUserFacingChanges = USER_FACING_CATEGORY_REGEX.test(notes)
  if (!hasUserFacingChanges) {
    return {
      action: 'close',
      version,
      tag,
      prevTag,
      body: '',
      reason:
        'No user-facing changes (Breaking Changes, Added, Changed, Fixed, Removed) in proposed range.',
    }
  }

  const updatedBody = formatReleasePullRequestBody(options.body ?? '', notes, version)
  return {
    action: 'update',
    version,
    tag,
    prevTag,
    body: updatedBody,
  }
}
