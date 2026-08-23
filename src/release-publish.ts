import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGh } from './gh'
import { runGit } from './git'
import { resolveRepoSlug } from './release-metadata'
import { type GitHubRelease, GitHubApiClient, resolveVersionAndTag } from './release-prepare'
import { verifyPackageTarball } from './tarball-verify'

export interface PublishPackageReleaseOptions {
  cwd?: string
  version?: string | null
  tag?: string | null
  sha?: string | null
  prevTag?: string | null
  repo?: string | null
  tarball?: string | null
  npmRegistry?: string | null
  npmToken?: string | null
  npmTag?: string | null
  npmAccess?: 'public' | 'restricted' | null
  provenance?: boolean
  dryRun?: boolean
  skipChecks?: boolean
  githubToken?: string | null
  githubApiUrl?: string | null
}

export interface PublishPackageReleaseResult {
  action: 'published' | 'already-published'
  tag: string
  version: string
  sha: string
  npmRegistry: string
  releaseId?: number
  draft: boolean
}

export interface NpmPackageVersionData {
  name: string
  version: string
  gitHead?: string
  dist?: {
    shasum?: string
    tarball?: string
    integrity?: string
  }
  [key: string]: unknown
}

export interface NpmPackageData {
  name: string
  versions: Record<string, NpmPackageVersionData>
  'dist-tags': Record<string, string>
  [key: string]: unknown
}

export function isPrerelease(version: string): boolean {
  const clean = version.trim().replace(/^v/, '')
  const match = /^\d+\.\d+\.\d+(?:-([\w.-]+))?$/.exec(clean)
  if (!match) {
    return true
  }
  return Boolean(match[1])
}

export class NpmApiClient {
  readonly registryUrl: string
  private readonly token: string | null

  constructor(options?: { registryUrl?: string | null; token?: string | null }) {
    let reg =
      options?.registryUrl ||
      process.env.NPM_CONFIG_REGISTRY ||
      process.env.npm_config_registry ||
      'https://registry.npmjs.org'
    this.registryUrl = reg.replace(/\/$/, '')

    const rawToken = options?.token ?? process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN ?? null
    this.token = rawToken && rawToken.trim().length > 0 ? rawToken.trim() : null
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'drovr-package-release',
    }
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`
    }
    return headers
  }

  async getPackage(packageName: string): Promise<NpmPackageData | null> {
    const url = `${this.registryUrl}/${encodeURIComponent(packageName)}`
    let res: Response
    try {
      res = await fetch(url, { headers: this.getHeaders() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to query npm registry for package "${packageName}": ${msg}`)
    }
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(
        `Failed to query npm registry for package "${packageName}": HTTP ${res.status} ${errText}`.trim(),
      )
    }
    return (await res.json()) as NpmPackageData
  }

  async getPackageVersion(
    packageName: string,
    version: string,
  ): Promise<NpmPackageVersionData | null> {
    const url = `${this.registryUrl}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`
    let res: Response
    try {
      res = await fetch(url, { headers: this.getHeaders() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to query npm registry for package "${packageName}@${version}": ${msg}`,
      )
    }
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(
        `Failed to query npm registry for package "${packageName}@${version}": HTTP ${res.status} ${errText}`.trim(),
      )
    }
    return (await res.json()) as NpmPackageVersionData
  }
}

function getPackageName(cwd: string): string {
  try {
    const pkgPath = join(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
      if (pkg.name && typeof pkg.name === 'string') {
        return pkg.name.trim()
      }
    }
  } catch {}
  return 'drovr'
}

function publishNpmTarball(options: {
  tarballPath: string
  registryUrl: string
  token?: string | null
  provenance?: boolean
  access?: 'public' | 'restricted' | null
  tag?: string | null
  cwd: string
}): void {
  const { tarballPath, registryUrl, cwd } = options
  const access = options.access || 'public'
  const tag = options.tag || 'latest'

  const rawToken = options.token ?? process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN ?? null
  const token = rawToken && rawToken.trim().length > 0 ? rawToken.trim() : null

  const args: string[] = [
    'publish',
    tarballPath,
    '--access',
    access,
    '--tag',
    tag,
    '--registry',
    registryUrl,
  ]

  // Add provenance if in GitHub Actions or explicitly requested
  const isGithubActions = process.env.GITHUB_ACTIONS === 'true'
  const isPublicNpm = registryUrl.startsWith('https://registry.npmjs.org')
  const shouldAddProvenance =
    options.provenance === true ||
    (options.provenance === undefined && isGithubActions && isPublicNpm)

  if (shouldAddProvenance) {
    args.push('--provenance')
  }

  let tempDir: string | null = null
  try {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (token) {
      env.NODE_AUTH_TOKEN = token
      env.NPM_TOKEN = token
    } else {
      delete env.NODE_AUTH_TOKEN
      delete env.NPM_TOKEN
    }

    // Create isolated temporary npmrc config for npm publish
    tempDir = mkdtempSync(join(tmpdir(), 'drovr-npm-publish-'))
    const registryHost = registryUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    const npmrcPath = join(tempDir, '.npmrc')
    let npmrcContent = `registry=${registryUrl}\nfetch-retries=0\nfetch-retry-mintimeout=500\nfetch-retry-maxtimeout=1000\n`
    if (token) {
      npmrcContent += `//${registryHost}/:_authToken=${token}\n`
    } else if (!isPublicNpm) {
      // For unauthenticated / local registries when no auth token is configured,
      // satisfy npm CLI client credential check so it issues tokenless PUT requests without ENEEDAUTH
      const dummyCert = join(tempDir, 'cert.pem')
      const dummyKey = join(tempDir, 'key.pem')
      writeFileSync(dummyCert, '', 'utf8')
      writeFileSync(dummyKey, '', 'utf8')
      npmrcContent += `//${registryHost}/:certfile=${dummyCert}\n//${registryHost}/:keyfile=${dummyKey}\n`
    }
    writeFileSync(npmrcPath, npmrcContent, 'utf8')
    args.push('--userconfig', npmrcPath)

    execFileSync('npm', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (err: unknown) {
    let stderr = ''
    if (err && typeof err === 'object' && 'stderr' in err) {
      if (typeof err.stderr === 'string') {
        stderr = err.stderr
      } else if (Buffer.isBuffer(err.stderr)) {
        stderr = err.stderr.toString('utf8')
      }
    }
    let stdout = ''
    if (err && typeof err === 'object' && 'stdout' in err) {
      if (typeof err.stdout === 'string') {
        stdout = err.stdout
      } else if (Buffer.isBuffer(err.stdout)) {
        stdout = err.stdout.toString('utf8')
      }
    }
    const msg =
      stderr.trim() ||
      stdout.trim() ||
      (err instanceof Error ? err.message : '') ||
      'publication error'
    throw new Error(`npm publication failed: ${msg}`)
  } finally {
    if (tempDir && existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {}
    }
  }
}

export async function publishPackageRelease(
  options: PublishPackageReleaseOptions = {},
): Promise<PublishPackageReleaseResult> {
  const cwd = options.cwd || process.cwd()

  // 1. Resolve version and tag
  const { version, tag } = resolveVersionAndTag(cwd, options)
  const repo = resolveRepoSlug(cwd, options.repo)

  // 2. Reject prereleases
  if (isPrerelease(version)) {
    throw new Error(
      `Prerelease versions ("${version}") are not permitted for Package Release. Publication must target stable versions.`,
    )
  }

  // 3. Resolve target commit SHA
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

  // 4. Validate local tag immutability (must already exist)
  let localTagSha: string | null = null
  try {
    localTagSha = runGit(cwd, ['rev-parse', `${tag}^{commit}`])
  } catch {}

  if (!localTagSha) {
    throw new Error(
      `Tag "${tag}" does not exist locally. Package Release tags must be created during release preparation before publication.`,
    )
  }
  if (localTagSha !== targetSha) {
    throw new Error(
      `Tag "${tag}" already exists locally and points to commit ${localTagSha}, which does not match target commit ${targetSha}. Existing version tags are immutable and cannot be moved or deleted.`,
    )
  }

  // 5. GitHub API client setup
  let token = options.githubToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null
  if (!token) {
    try {
      token = runGh(cwd, ['auth', 'token']).trim() || null
    } catch {}
  }
  const ghClient = new GitHubApiClient({
    apiUrl: options.githubApiUrl,
    token,
  })

  // 6. Validate remote tag ref on GitHub (must already exist)
  const remoteRef = await ghClient.getRef(repo, `tags/${tag}`)
  if (!remoteRef) {
    throw new Error(
      `Tag "${tag}" does not exist on GitHub (${repo}). Package Release tags must be created during release preparation before publication.`,
    )
  }

  let remoteCommitSha = remoteRef.object.sha
  if (remoteRef.object.type === 'tag') {
    const tagObj = await ghClient.getTagObject(repo, remoteRef.object.sha)
    if (tagObj?.object.sha) {
      remoteCommitSha = tagObj.object.sha
    }
  }
  if (remoteCommitSha !== targetSha) {
    throw new Error(
      `Tag "${tag}" already exists on GitHub and points to commit ${remoteCommitSha}, which does not match target commit ${targetSha}. Existing version tags are immutable and cannot be moved or deleted.`,
    )
  }

  // 7. Find existing GitHub Release
  const releases = await ghClient.listReleases(repo)
  let existingRelease = releases.find((r) => r.tag_name === tag) || null
  if (!existingRelease) {
    existingRelease = await ghClient.getReleaseByTag(repo, tag)
  }

  if (existingRelease) {
    const targetCommitish = existingRelease.target_commitish?.trim()
    if (
      targetCommitish &&
      /^[0-9a-f]{40}$/i.test(targetCommitish) &&
      targetCommitish.toLowerCase() !== targetSha.toLowerCase()
    ) {
      throw new Error(
        `GitHub Release "${tag}" exists on GitHub and points to commit ${targetCommitish}, which does not match target commit ${targetSha}.`,
      )
    }
  }

  // 8. Check npm registry state
  const npmClient = new NpmApiClient({
    registryUrl: options.npmRegistry,
    token: options.npmToken,
  })
  const packageName = getPackageName(cwd)
  const existingNpmVersion = await npmClient.getPackageVersion(packageName, version)

  if (existingNpmVersion) {
    // Immutable check on npm package: verify source boundary
    const npmGitHead = existingNpmVersion.gitHead?.trim()
    if (
      !npmGitHead ||
      npmGitHead.length === 0 ||
      npmGitHead.toLowerCase() !== targetSha.toLowerCase()
    ) {
      throw new Error(
        `npm version "${version}" is already published but points to commit ${npmGitHead || '(missing)'}, which does not match target commit ${targetSha}. npm versions are immutable and cannot be overwritten.`,
      )
    }

    if (existingRelease && !existingRelease.draft) {
      // Already fully published on both npm and GitHub
      return {
        action: 'already-published',
        tag,
        version,
        sha: targetSha,
        npmRegistry: npmClient.registryUrl,
        releaseId: existingRelease.id,
        draft: false,
      }
    }

    if (!existingRelease) {
      throw new Error(
        `npm version "${version}" is already published, but draft GitHub Release "${tag}" does not exist to finalize.`,
      )
    }

    const finalized = await ghClient.updateRelease(repo, existingRelease.id, {
      tag_name: tag,
      target_commitish: targetSha,
      name: tag,
      draft: false,
      prerelease: false,
    })

    return {
      action: 'published',
      tag,
      version,
      sha: targetSha,
      npmRegistry: npmClient.registryUrl,
      releaseId: finalized.id,
      draft: false,
    }
  }

  // 9. Version does not exist on npm yet. Ensure draft GitHub release exists.
  if (!existingRelease) {
    throw new Error(
      `Draft GitHub Release "${tag}" does not exist. Releases must be prepared before publication.`,
    )
  }

  // 10. Verify / obtain tarball
  let tarballPath = options.tarball
  if (tarballPath) {
    if (!existsSync(tarballPath)) {
      throw new Error(`Specified tarball does not exist: ${tarballPath}`)
    }
  } else {
    if (!options.skipChecks) {
      const verifyResult = await verifyPackageTarball({
        cwd,
        skipBuild: false,
      })
      if (!verifyResult.valid) {
        throw new Error(`Package tarball verification failed: ${verifyResult.error}`)
      }
      tarballPath = verifyResult.tarballPath
    } else {
      // In skipChecks mode, pack tarball with npm pack
      try {
        const packOutput = execFileSync('npm', ['pack', '--json'], { cwd, encoding: 'utf8' })
        const packJson = JSON.parse(packOutput) as Array<{ filename: string }>
        if (packJson[0]?.filename) {
          tarballPath = join(cwd, packJson[0].filename)
        }
      } catch {
        // Fallback: search for .tgz matching package
        try {
          const files = runGit(cwd, ['ls-files', '--others']).split('\n')
          const found = files.find((f) => f.endsWith('.tgz'))
          if (found) {
            tarballPath = join(cwd, found)
          }
        } catch {}
      }
      if (!tarballPath || !existsSync(tarballPath)) {
        // Run npm pack directly
        const filename = execFileSync('npm', ['pack'], { cwd, encoding: 'utf8' })
          .trim()
          .split('\n')
          .pop()
          ?.trim()
        if (filename) {
          tarballPath = join(cwd, filename)
        }
      }
    }
  }

  if (!tarballPath || !existsSync(tarballPath)) {
    throw new Error(`Failed to locate package tarball for publication in ${cwd}`)
  }

  if (options.dryRun) {
    return {
      action: 'published',
      tag,
      version,
      sha: targetSha,
      npmRegistry: npmClient.registryUrl,
      releaseId: existingRelease.id,
      draft: true,
    }
  }

  // 11. Publish tarball to npm
  publishNpmTarball({
    tarballPath,
    registryUrl: npmClient.registryUrl,
    token: options.npmToken,
    provenance: options.provenance,
    access: options.npmAccess,
    tag: options.npmTag,
    cwd,
  })

  // 12. Confirm publication on npm registry
  const confirmed = await npmClient.getPackageVersion(packageName, version)
  if (!confirmed) {
    throw new Error(
      `npm publication completed but version "${version}" was not confirmed on registry ${npmClient.registryUrl}. Leaving GitHub Release in draft state.`,
    )
  }

  // 13. Transition GitHub Release from draft to public
  if (!existingRelease) {
    existingRelease = await ghClient.getReleaseByTag(repo, tag)
  }
  if (!existingRelease?.id) {
    throw new Error(
      `npm version "${version}" was published successfully, but failed to locate draft GitHub Release "${tag}" to finalize.`,
    )
  }

  let finalized: GitHubRelease
  try {
    finalized = await ghClient.updateRelease(repo, existingRelease.id, {
      tag_name: tag,
      target_commitish: targetSha,
      name: tag,
      draft: false,
      prerelease: false,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `npm version "${version}" was published successfully, but failed to update GitHub Release to public: ${msg}. The GitHub Release remains a draft and can be finalized on rerun.`,
    )
  }

  return {
    action: 'published',
    tag,
    version,
    sha: targetSha,
    npmRegistry: npmClient.registryUrl,
    releaseId: finalized.id,
    draft: false,
  }
}
