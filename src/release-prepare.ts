import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runGh } from './gh'
import { runGit } from './git'
import { getGitCommitsInRange, renderReleaseNotes, resolveRepoSlug } from './release-metadata'

export interface PrepareReleaseOptions {
  cwd?: string
  version?: string | null
  tag?: string | null
  sha?: string | null
  prevTag?: string | null
  repo?: string | null
  githubNotes?: string | null
  githubNotesFile?: string | null
  githubToken?: string | null
  githubApiUrl?: string | null
}

export interface PrepareReleaseResult {
  action: 'created' | 'updated' | 'already-prepared' | 'already-published'
  tag: string
  version: string
  sha: string
  prevTag: string | null
  releaseId?: number
  draft: boolean
  body: string
}

export interface GitHubRelease {
  id: number
  tag_name: string
  target_commitish: string
  name: string
  body: string
  draft: boolean
  prerelease: boolean
  html_url?: string
}

export interface GitHubRef {
  ref: string
  object: {
    sha: string
    type: 'commit' | 'tag'
  }
}

export interface GitHubTagObject {
  tag: string
  sha: string
  object: {
    sha: string
    type: string
  }
}

export class GitHubApiClient {
  private readonly baseUrl: string
  private readonly token: string | null

  constructor(options?: { apiUrl?: string | null; token?: string | null }) {
    this.baseUrl = (
      options?.apiUrl ||
      process.env.GITHUB_API_URL ||
      'https://api.github.com'
    ).replace(/\/$/, '')
    this.token = options?.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'drovr-package-release',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`
    }
    return headers
  }

  async getRef(repo: string, ref: string): Promise<GitHubRef | null> {
    const cleanRef = ref.replace(/^refs\//, '')
    const url = `${this.baseUrl}/repos/${repo}/git/ref/${cleanRef}`
    let res: Response
    try {
      res = await fetch(url, { headers: this.getHeaders() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to query remote git ref "${ref}" on GitHub (${repo}): ${msg}`)
    }
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(
        `Failed to get remote git ref "${ref}" on GitHub (${repo}): HTTP ${res.status} ${errText}`.trim(),
      )
    }
    return (await res.json()) as GitHubRef
  }

  async getTagObject(repo: string, tagSha: string): Promise<GitHubTagObject | null> {
    const url = `${this.baseUrl}/repos/${repo}/git/tags/${tagSha}`
    let res: Response
    try {
      res = await fetch(url, { headers: this.getHeaders() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to fetch tag object "${tagSha}" on GitHub (${repo}): ${msg}`)
    }
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(
        `Failed to fetch tag object "${tagSha}" on GitHub (${repo}): HTTP ${res.status} ${errText}`.trim(),
      )
    }
    return (await res.json()) as GitHubTagObject
  }

  async createRef(repo: string, ref: string, sha: string): Promise<GitHubRef> {
    const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`
    const url = `${this.baseUrl}/repos/${repo}/git/refs`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: fullRef, sha }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to create remote git ref "${fullRef}" on GitHub (${repo}): ${msg}`)
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(
        `Failed to create remote git ref "${fullRef}" on GitHub (${repo}) at ${sha}: HTTP ${res.status} ${errText}`.trim(),
      )
    }
    return (await res.json()) as GitHubRef
  }

  async listReleases(repo: string): Promise<GitHubRelease[]> {
    const url = `${this.baseUrl}/repos/${repo}/releases?per_page=100`
    let res: Response
    try {
      res = await fetch(url, { headers: this.getHeaders() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to list GitHub releases for ${repo}: ${msg}`)
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(
        `Failed to list GitHub releases for ${repo}: HTTP ${res.status} ${errText}`.trim(),
      )
    }
    return (await res.json()) as GitHubRelease[]
  }

  async getReleaseByTag(repo: string, tag: string): Promise<GitHubRelease | null> {
    const url = `${this.baseUrl}/repos/${repo}/releases/tags/${tag}`
    let res: Response
    try {
      res = await fetch(url, { headers: this.getHeaders() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to fetch GitHub release for tag "${tag}" (${repo}): ${msg}`)
    }
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(
        `Failed to fetch GitHub release for tag "${tag}" (${repo}): HTTP ${res.status} ${errText}`.trim(),
      )
    }
    return (await res.json()) as GitHubRelease
  }

  async createRelease(
    repo: string,
    data: {
      tag_name: string
      target_commitish: string
      name?: string
      body?: string
      draft?: boolean
      prerelease?: boolean
    },
  ): Promise<GitHubRelease> {
    const url = `${this.baseUrl}/repos/${repo}/releases`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tag_name: data.tag_name,
          target_commitish: data.target_commitish,
          name: data.name || data.tag_name,
          body: data.body || '',
          draft: data.draft ?? true,
          prerelease: data.prerelease ?? false,
        }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to create GitHub release for ${repo}: ${msg}`)
    }
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      throw new Error(`failed to create GitHub release: ${res.status} ${errorText}`.trim())
    }
    return (await res.json()) as GitHubRelease
  }

  async updateRelease(
    repo: string,
    id: number,
    data: {
      tag_name?: string
      target_commitish?: string
      name?: string
      body?: string
      draft?: boolean
      prerelease?: boolean
    },
  ): Promise<GitHubRelease> {
    const url = `${this.baseUrl}/repos/${repo}/releases/${id}`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'PATCH',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to update GitHub release ${id} (${repo}): ${msg}`)
    }
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      throw new Error(`failed to update GitHub release ${id}: ${res.status} ${errorText}`.trim())
    }
    return (await res.json()) as GitHubRelease
  }

  async generateReleaseNotes(
    repo: string,
    data: {
      tag_name: string
      target_commitish?: string
      previous_tag_name?: string
    },
  ): Promise<{ name: string; body: string } | null> {
    const url = `${this.baseUrl}/repos/${repo}/releases/generate-notes`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tag_name: data.tag_name,
          target_commitish: data.target_commitish,
          previous_tag_name: data.previous_tag_name,
        }),
      })
      if (!res.ok) {
        return null
      }
      return (await res.json()) as { name: string; body: string }
    } catch {
      return null
    }
  }
}

export function resolveVersionAndTag(
  cwd: string,
  options: { version?: string | null; tag?: string | null },
): { version: string; tag: string } {
  let version = options.version?.trim() || null
  let tag = options.tag?.trim() || null

  if (version) {
    version = version.replace(/^v/, '')
  } else if (tag) {
    version = tag.replace(/^v/, '')
  } else {
    try {
      const pkgJsonPath = join(cwd, 'package.json')
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
      if (pkg.version && typeof pkg.version === 'string') {
        version = pkg.version.trim().replace(/^v/, '')
      }
    } catch {}
  }

  if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error(
      `Could not determine a valid SemVer version (got "${version ?? '(none)'}"). Specify --version or --tag.`,
    )
  }

  if (!tag) {
    tag = `v${version}`
  } else if (!tag.startsWith('v')) {
    tag = `v${tag}`
  }

  return { version, tag }
}

export function getPreviousReleaseTag(cwd: string, currentTag?: string): string | null {
  try {
    const tagsOutput = runGit(cwd, ['tag', '-l', 'v*', '--sort=-v:refname'])
    const tags = tagsOutput
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean)

    for (const t of tags) {
      if (currentTag && t === currentTag) {
        continue
      }
      return t
    }
    return null
  } catch {
    return null
  }
}

export async function prepareDraftRelease(
  options: PrepareReleaseOptions = {},
): Promise<PrepareReleaseResult> {
  const cwd = options.cwd || process.cwd()

  // 1. Resolve target commit SHA (authorized commit)
  let targetSha: string
  if (options.sha && options.sha.trim().length > 0) {
    try {
      targetSha = runGit(cwd, ['rev-parse', options.sha.trim()])
    } catch {
      throw new Error(`Failed to resolve commit SHA for "${options.sha}" in ${cwd}`)
    }
  } else {
    try {
      targetSha = runGit(cwd, ['rev-parse', 'HEAD'])
    } catch {
      throw new Error(`Failed to resolve HEAD commit in ${cwd}`)
    }
  }

  // 2. Resolve version and tag
  const { version, tag } = resolveVersionAndTag(cwd, options)
  const repo = resolveRepoSlug(cwd, options.repo)

  // 3. GitHub API Client setup
  let token = options.githubToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null
  if (!token) {
    try {
      token = runGh(cwd, ['auth', 'token']).trim() || null
    } catch {}
  }
  const client = new GitHubApiClient({
    apiUrl: options.githubApiUrl,
    token,
  })

  // 4. Verify local tag immutability & create at authorized commit if missing
  let localTagExists = false
  try {
    const existingLocalSha = runGit(cwd, ['rev-parse', `${tag}^{commit}`])
    if (existingLocalSha) {
      localTagExists = true
      if (existingLocalSha !== targetSha) {
        throw new Error(
          `Tag "${tag}" already exists locally and points to commit ${existingLocalSha}, which does not match target commit ${targetSha}. Existing version tags are immutable and cannot be moved or deleted.`,
        )
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('immutable and cannot be moved')) {
      throw err
    }
    // Tag does not exist locally
  }

  if (!localTagExists) {
    try {
      runGit(cwd, ['tag', tag, targetSha])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to create local tag ${tag} at ${targetSha}: ${msg}`)
    }
  }

  // 5. Verify remote tag ref on GitHub & create at authorized commit if missing
  // The peeled version tag is the source boundary.
  const remoteRef = await client.getRef(repo, `tags/${tag}`)
  if (remoteRef) {
    let remoteCommitSha = remoteRef.object.sha
    if (remoteRef.object.type === 'tag') {
      const tagObj = await client.getTagObject(repo, remoteRef.object.sha)
      if (tagObj?.object.sha) {
        remoteCommitSha = tagObj.object.sha
      }
    }
    if (remoteCommitSha !== targetSha) {
      throw new Error(
        `Tag "${tag}" already exists on GitHub and points to commit ${remoteCommitSha}, which does not match target commit ${targetSha}. Existing version tags are immutable and cannot be moved or deleted.`,
      )
    }
  } else {
    try {
      await client.createRef(repo, `refs/tags/${tag}`, targetSha)
    } catch (createErr) {
      // If error occurred (e.g. 422 ref exists from race), re-query to verify match
      const checkRef = await client.getRef(repo, `tags/${tag}`)
      if (checkRef) {
        let remoteCommitSha = checkRef.object.sha
        if (checkRef.object.type === 'tag') {
          const tagObj = await client.getTagObject(repo, checkRef.object.sha)
          if (tagObj?.object.sha) {
            remoteCommitSha = tagObj.object.sha
          }
        }
        if (remoteCommitSha !== targetSha) {
          throw new Error(
            `Tag "${tag}" already exists on GitHub and points to commit ${remoteCommitSha}, which does not match target commit ${targetSha}. Existing version tags are immutable and cannot be moved or deleted.`,
          )
        }
      } else {
        throw createErr
      }
    }
  }

  // 6. Resolve previous tag and commit range
  let prevTag = options.prevTag?.trim() || null
  if (!prevTag) {
    prevTag = getPreviousReleaseTag(cwd, tag)
  }

  // 7. Find existing release on GitHub (if any)
  const releases = await client.listReleases(repo)
  let existingRelease = releases.find((r) => r.tag_name === tag) || null
  if (!existingRelease) {
    existingRelease = await client.getReleaseByTag(repo, tag)
  }

  if (existingRelease) {
    const targetCommitish = existingRelease.target_commitish?.trim()
    if (
      targetCommitish &&
      /^[0-9a-f]{40}$/i.test(targetCommitish) &&
      targetCommitish.toLowerCase() !== targetSha.toLowerCase()
    ) {
      throw new Error(
        `Draft release "${tag}" exists on GitHub and points to commit ${targetCommitish}, which does not match target commit ${targetSha}.`,
      )
    }
  }

  // 8. Gather raw GitHub notes (What's Changed)
  let rawGithubNotes: string | null = null
  if (options.githubNotes && options.githubNotes.trim().length > 0) {
    rawGithubNotes = options.githubNotes.trim()
  } else if (options.githubNotesFile) {
    try {
      rawGithubNotes = readFileSync(options.githubNotesFile, 'utf8').trim()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to read github notes file: ${msg}`)
    }
  } else {
    // Fetch GitHub generate-notes
    const generated = await client.generateReleaseNotes(repo, {
      tag_name: tag,
      target_commitish: targetSha,
      previous_tag_name: prevTag || undefined,
    })
    if (generated?.body) {
      rawGithubNotes = generated.body
    } else if (existingRelease?.body) {
      rawGithubNotes = existingRelease.body
    }
  }

  // 9. Render Canonical Release Notes
  const commits = getGitCommitsInRange(cwd, { from: prevTag, to: targetSha })
  const canonicalNotes = renderReleaseNotes({
    commits,
    repo,
    tag,
    prevTag,
    githubNotes: rawGithubNotes,
  })

  // 10. Reconcile Draft Release on GitHub
  if (existingRelease) {
    if (!existingRelease.draft) {
      return {
        action: 'already-published',
        tag,
        version,
        sha: targetSha,
        prevTag,
        releaseId: existingRelease.id,
        draft: false,
        body: existingRelease.body,
      }
    }

    if (existingRelease.body === canonicalNotes && existingRelease.name === tag) {
      return {
        action: 'already-prepared',
        tag,
        version,
        sha: targetSha,
        prevTag,
        releaseId: existingRelease.id,
        draft: true,
        body: canonicalNotes,
      }
    }

    const updated = await client.updateRelease(repo, existingRelease.id, {
      tag_name: tag,
      target_commitish: targetSha,
      name: tag,
      body: canonicalNotes,
      draft: true,
    })

    return {
      action: 'updated',
      tag,
      version,
      sha: targetSha,
      prevTag,
      releaseId: updated.id,
      draft: true,
      body: canonicalNotes,
    }
  }

  const created = await client.createRelease(repo, {
    tag_name: tag,
    target_commitish: targetSha,
    name: tag,
    body: canonicalNotes,
    draft: true,
    prerelease: false,
  })

  return {
    action: 'created',
    tag,
    version,
    sha: targetSha,
    prevTag,
    releaseId: created.id,
    draft: true,
    body: canonicalNotes,
  }
}
