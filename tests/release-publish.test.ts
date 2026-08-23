import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const drovr = join(root, 'dist/cli.mjs')

function withResolvers<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function runDrovr(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const { promise, resolve } = withResolvers<{
    status: number
    stdout: string
    stderr: string
  }>()

  const child = spawn('node', [drovr, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    stdout += d.toString('utf8')
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString('utf8')
  })
  child.on('close', (status) => {
    resolve({
      status: status ?? 0,
      stdout,
      stderr,
    })
  })
  child.on('error', (err) => {
    resolve({
      status: 1,
      stdout,
      stderr: err.message,
    })
  })
  return promise
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()
}

async function initRepo(options?: { name?: string; version?: string }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drovr-publish-test-'))
  const pkgName = options?.name || 'drovr'
  const version = options?.version || '0.1.0'

  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: pkgName,
        version,
        type: 'module',
        main: './dist/index.mjs',
        bin: {
          [pkgName]: './dist/cli.mjs',
        },
        files: ['dist'],
        scripts: {
          build: 'echo build',
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(join(dir, 'README.md'), '# test\n', 'utf8')
  runGit(dir, ['add', 'package.json', 'README.md'])
  runGit(dir, ['commit', '-m', 'chore: init'])
  return dir
}

// ----------------------------------------------------------------------------
// Fake GitHub REST API Server
// ----------------------------------------------------------------------------

interface FakeRelease {
  id: number
  tag_name: string
  target_commitish: string
  name: string
  body: string
  draft: boolean
  prerelease: boolean
}

interface FakeTagRef {
  ref: string
  object: {
    sha: string
    type: 'commit' | 'tag'
  }
}

interface FakeGitHubState {
  tags: Map<string, FakeTagRef>
  releases: Map<number, FakeRelease>
  nextReleaseId: number
  simulateGetRefError?: number
  simulateUpdateReleaseError?: number
}

async function createFakeGitHubServer(initialState?: Partial<FakeGitHubState>): Promise<{
  server: Server
  url: string
  state: FakeGitHubState
  close: () => Promise<void>
}> {
  const state: FakeGitHubState = {
    tags: new Map(initialState?.tags || []),
    releases: new Map(initialState?.releases || []),
    nextReleaseId: initialState?.nextReleaseId || 100,
    simulateGetRefError: initialState?.simulateGetRefError,
    simulateUpdateReleaseError: initialState?.simulateUpdateReleaseError,
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const method = req.method || 'GET'

    let bodyText = ''
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk)
      }
      bodyText = Buffer.concat(chunks).toString('utf8')
    }
    const bodyJson = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null

    // Simulated error for getRef
    if (state.simulateGetRefError && url.pathname.includes('/git/ref')) {
      res.writeHead(state.simulateGetRefError, {
        'Content-Type': 'application/json',
        Connection: 'close',
      })
      res.end(JSON.stringify({ message: 'Internal Server Error' }))
      return
    }

    // Simulated error for updateRelease
    if (
      state.simulateUpdateReleaseError &&
      /^\/repos\/[^/]+\/[^/]+\/releases\/\d+$/.test(url.pathname) &&
      method === 'PATCH'
    ) {
      res.writeHead(state.simulateUpdateReleaseError, {
        'Content-Type': 'application/json',
        Connection: 'close',
      })
      res.end(JSON.stringify({ message: 'Internal Server Error during release update' }))
      return
    }

    // Route: GET /repos/:owner/:repo/git/ref/tags/:tag
    const refMatch = /^\/repos\/[^/]+\/[^/]+\/git\/refs?\/tags\/(.+)$/.exec(url.pathname)
    if (refMatch && method === 'GET') {
      const tag = refMatch[1]
      const ref = state.tags.get(`refs/tags/${tag}`) || state.tags.get(tag)
      if (ref) {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify(ref))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ message: 'Not Found' }))
      return
    }

    // Route: GET /repos/:owner/:repo/releases/tags/:tag
    const releaseByTagMatch = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(url.pathname)
    if (releaseByTagMatch && method === 'GET') {
      const tag = releaseByTagMatch[1]
      const found = Array.from(state.releases.values()).find((r) => r.tag_name === tag)
      if (found) {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify(found))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ message: 'Not Found' }))
      return
    }

    // Route: GET /repos/:owner/:repo/releases
    if (/^\/repos\/[^/]+\/[^/]+\/releases$/.test(url.pathname) && method === 'GET') {
      const all = Array.from(state.releases.values())
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify(all))
      return
    }

    // Route: PATCH /repos/:owner/:repo/releases/:id
    const updateReleaseMatch = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)$/.exec(url.pathname)
    if (updateReleaseMatch && method === 'PATCH') {
      const id = parseInt(updateReleaseMatch[1], 10)
      const existing = state.releases.get(id)
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify({ message: 'Release not found' }))
        return
      }
      const updated: FakeRelease = {
        ...existing,
        ...bodyJson,
      }
      state.releases.set(id, updated)
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify(updated))
      return
    }

    // Route: POST /repos/:owner/:repo/releases
    if (/^\/repos\/[^/]+\/[^/]+\/releases$/.test(url.pathname) && method === 'POST') {
      const id = state.nextReleaseId++
      const tagName = typeof bodyJson?.tag_name === 'string' ? bodyJson.tag_name : ''
      const targetCommitish =
        typeof bodyJson?.target_commitish === 'string' ? bodyJson.target_commitish : ''
      const releaseName =
        typeof bodyJson?.name === 'string'
          ? bodyJson.name
          : typeof bodyJson?.tag_name === 'string'
            ? bodyJson.tag_name
            : ''
      const releaseBody = typeof bodyJson?.body === 'string' ? bodyJson.body : ''
      const created: FakeRelease = {
        id,
        tag_name: tagName,
        target_commitish: targetCommitish,
        name: releaseName,
        body: releaseBody,
        draft: (bodyJson?.draft as boolean | undefined) ?? true,
        prerelease: (bodyJson?.prerelease as boolean | undefined) ?? false,
      }
      state.releases.set(id, created)
      res.writeHead(201, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify(created))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
    res.end(JSON.stringify({ message: `No route for ${method} ${url.pathname}` }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `http://127.0.0.1:${port}`

  return {
    server,
    url,
    state,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// ----------------------------------------------------------------------------
// Fake npm Registry Server
// ----------------------------------------------------------------------------

interface FakeNpmPackageVersion {
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

interface FakeNpmPackage {
  name: string
  versions: Map<string, FakeNpmPackageVersion>
  distTags: Record<string, string>
}

interface FakeNpmState {
  packages: Map<string, FakeNpmPackage>
  publishRequests: Array<{
    method: string
    path: string
    authHeader?: string
    bodyJson?: Record<string, unknown>
  }>
  defaultGitHead?: string
  simulateGetError?: number
  simulatePublishError?: number
  simulatePublishErrorBody?: string
  simulateConfirmationNotFound?: boolean
  simulateConfirmationError?: number
}
async function createFakeNpmRegistryServer(initialState?: Partial<FakeNpmState>): Promise<{
  server: Server
  url: string
  state: FakeNpmState
  close: () => Promise<void>
}> {
  const state: FakeNpmState = {
    packages: new Map(initialState?.packages || []),
    publishRequests: [],
    defaultGitHead: initialState?.defaultGitHead,
    simulateGetError: initialState?.simulateGetError,
    simulatePublishError: initialState?.simulatePublishError,
    simulatePublishErrorBody: initialState?.simulatePublishErrorBody,
    simulateConfirmationNotFound: initialState?.simulateConfirmationNotFound,
    simulateConfirmationError: initialState?.simulateConfirmationError,
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const method = req.method || 'GET'
    const authHeader = req.headers.authorization

    let bodyText = ''
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(chunk)
      }
      bodyText = Buffer.concat(chunks).toString('utf8')
    }
    let bodyJson: Record<string, unknown> | undefined
    try {
      if (bodyText) {
        bodyJson = JSON.parse(bodyText) as Record<string, unknown>
      }
    } catch {}

    // Track requests
    state.publishRequests.push({
      method,
      path: url.pathname,
      authHeader,
      bodyJson,
    })

    // Simulate get error
    if (state.simulateGetError && method === 'GET') {
      res.writeHead(state.simulateGetError, {
        'Content-Type': 'application/json',
        Connection: 'close',
      })
      res.end(JSON.stringify({ error: 'Internal Server Error' }))
      return
    }

    // Simulate publish error
    if (state.simulatePublishError && method === 'PUT') {
      res.writeHead(state.simulatePublishError, {
        'Content-Type': 'application/json',
        Connection: 'close',
      })
      res.end(
        state.simulatePublishErrorBody ||
          JSON.stringify({ error: 'Simulated publication failure' }),
      )
      return
    }

    // Route: GET /:package/:version (e.g. GET /drovr/0.1.0)
    const pkgVersionMatch = /^\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (pkgVersionMatch && method === 'GET') {
      if (state.simulateConfirmationError) {
        res.writeHead(state.simulateConfirmationError, {
          'Content-Type': 'application/json',
          Connection: 'close',
        })
        res.end(JSON.stringify({ error: 'Simulated confirmation lookup failure' }))
        return
      }
      if (state.simulateConfirmationNotFound) {
        res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify({ error: 'version not found' }))
        return
      }

      const pkgName = decodeURIComponent(pkgVersionMatch[1])
      const ver = decodeURIComponent(pkgVersionMatch[2])

      const pkg = state.packages.get(pkgName)
      if (pkg && pkg.versions.has(ver)) {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify(pkg.versions.get(ver)))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ error: 'version not found' }))
      return
    }

    // Route: GET /:package (e.g. GET /drovr)
    const pkgRootMatch = /^\/([^/]+)$/.exec(url.pathname)
    if (pkgRootMatch && method === 'GET') {
      const pkgName = decodeURIComponent(pkgRootMatch[1])
      const pkg = state.packages.get(pkgName)
      if (pkg) {
        const versionsObj: Record<string, unknown> = {}
        for (const [v, data] of pkg.versions.entries()) {
          versionsObj[v] = data
        }
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(
          JSON.stringify({
            name: pkg.name,
            versions: versionsObj,
            'dist-tags': pkg.distTags,
          }),
        )
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    // Route: PUT /:package (npm publish payload)
    if (pkgRootMatch && method === 'PUT') {
      const pkgName = decodeURIComponent(pkgRootMatch[1])
      let pkg = state.packages.get(pkgName)
      if (!pkg) {
        pkg = {
          name: pkgName,
          versions: new Map(),
          distTags: {},
        }
        state.packages.set(pkgName, pkg)
      }

      if (bodyJson && typeof bodyJson.versions === 'object' && bodyJson.versions !== null) {
        for (const [v, verData] of Object.entries(bodyJson.versions)) {
          const versionObj = { ...(verData as FakeNpmPackageVersion) }
          if (!versionObj.gitHead && state.defaultGitHead) {
            versionObj.gitHead = state.defaultGitHead
          }
          pkg.versions.set(v, versionObj)
        }
      }
      if (bodyJson && typeof bodyJson['dist-tags'] === 'object' && bodyJson['dist-tags'] !== null) {
        pkg.distTags = {
          ...pkg.distTags,
          ...(bodyJson['dist-tags'] as Record<string, string>),
        }
      }

      res.writeHead(201, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ ok: true, id: pkgName, rev: '1-test' }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
    res.end(JSON.stringify({ error: `Not found: ${method} ${url.pathname}` }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `http://127.0.0.1:${port}`

  return {
    server,
    url,
    state,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// ----------------------------------------------------------------------------
// Test Suite: Issue #41 - Publish npm before exposing the GitHub Release
// ----------------------------------------------------------------------------

describe('Issue #41: Publish npm before exposing the GitHub Release', () => {
  const cleanupDirs: string[] = []
  const cleanupServers: Array<() => Promise<void>> = []

  beforeAll(() => {
    if (!existsSync(drovr)) {
      execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
    }
  })

  afterEach(async () => {
    for (const closeServer of cleanupServers) {
      await closeServer().catch(() => {})
    }
    cleanupServers.length = 0

    for (const dir of cleanupDirs) {
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
    cleanupDirs.length = 0
  })

  // --------------------------------------------------------------------------
  // Slice 1: Version Validation & Prerelease Rejection
  // --------------------------------------------------------------------------
  describe('Prerelease and version validation', () => {
    it('rejects prerelease versions and does not publish or mutate GitHub Releases', async () => {
      const repo = await initRepo({ version: '0.1.0-alpha.1' })
      cleanupDirs.push(repo)

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--version',
        '0.1.0-alpha.1',
      ])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/prerelease/i)
      expect(result.stderr).toMatch(/0\.1\.0-alpha\.1/)
    })

    it('rejects other prerelease formats like rc or beta tags', async () => {
      const repo = await initRepo({ version: '1.0.0-rc.0' })
      cleanupDirs.push(repo)

      const result = await runDrovr(repo, ['package-release', 'publish', '--tag', 'v1.0.0-rc.0'])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/prerelease/i)
    })
  })

  // --------------------------------------------------------------------------
  // Slice 2: Source Boundary & Git Tag Verification
  // --------------------------------------------------------------------------
  describe('Source boundary and tag verification', () => {
    it('fails when local tag does not exist rather than creating it', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--sha',
        headSha,
      ])

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Tag "v0.1.0" does not exist locally/i)

      // Ensure tag was NOT created
      const localTags = runGit(repo, ['tag', '-l', 'v0.1.0'])
      expect(localTags).toBe('')
    })

    it('fails with actionable diagnostic if local tag points to mismatched commit', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)

      const commit1 = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', commit1])

      await writeFile(join(repo, 'extra.txt'), 'extra\n', 'utf8')
      runGit(repo, ['add', 'extra.txt'])
      runGit(repo, ['commit', '-m', 'feat: extra commit'])
      const commit2 = runGit(repo, ['rev-parse', 'HEAD'])

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--sha',
        commit2,
      ])

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Tag "v0.1.0" already exists locally/i)
      expect(result.stderr).toMatch(/immutable/i)

      // Ensure tag was not deleted or moved
      const currentTagSha = runGit(repo, ['rev-parse', 'v0.1.0^{commit}'])
      expect(currentTagSha).toBe(commit1)
    })

    it('fails when remote GitHub tag does not exist rather than creating it', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer()
      cleanupServers.push(fakeGh.close)

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
      ])

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Tag "v0.1.0" does not exist on GitHub/i)
      expect(fakeGh.state.tags.size).toBe(0)
    })

    it('fails with actionable diagnostic if remote GitHub tag points to mismatched commit', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: '0000000000000000000000000000000000000000',
                type: 'commit',
              },
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
      ])

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Tag "v0.1.0" already exists on GitHub/i)
      expect(result.stderr).toMatch(/immutable/i)
    })
  })

  // --------------------------------------------------------------------------
  // Slice 3: Happy Path End-to-End Publication & Finalization
  // --------------------------------------------------------------------------
  describe('Successful ordering and finalization', () => {
    it('verifies tarball, publishes to npm, confirms on registry, and transitions GitHub Release from draft to public', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const fakeGh = await createFakeGitHubServer()
      cleanupServers.push(fakeGh.close)

      const fakeNpm = await createFakeNpmRegistryServer()
      cleanupServers.push(fakeNpm.close)

      // Set up real build artifacts in dist/ so verifyPackageTarball passes without skipping
      const distDir = join(repo, 'dist')
      await mkdir(distDir, { recursive: true })
      await writeFile(join(distDir, 'index.mjs'), 'export const version = "0.1.0";\n', 'utf8')
      await writeFile(
        join(distDir, 'index.d.mts'),
        'export declare const version: string;\n',
        'utf8',
      )
      await writeFile(
        join(distDir, 'cli.mjs'),
        '#!/usr/bin/env node\nif (process.argv.includes("--help") || process.argv.includes("-h")) { console.log("help"); process.exit(0); }\nconsole.log("drovr v0.1.0");\n',
        'utf8',
      )
      await chmod(join(distDir, 'cli.mjs'), 0o755)

      runGit(repo, ['add', '-A'])
      runGit(repo, ['commit', '-m', 'feat: add build artifacts'])
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      fakeGh.state.tags.set('refs/tags/v0.1.0', {
        ref: 'refs/tags/v0.1.0',
        object: {
          sha: headSha,
          type: 'commit',
        },
      })
      fakeGh.state.releases.set(101, {
        id: 101,
        tag_name: 'v0.1.0',
        target_commitish: headSha,
        name: 'v0.1.0',
        body: '## Added\n- initial release',
        draft: true,
        prerelease: false,
      })
      // Run verify-pack with --skip-build (artifacts already exist in dist)
      const verifyRes = await runDrovr(repo, [
        'package-release',
        'verify-pack',
        '--skip-build',
        '--keep-temp',
        '--json',
      ])
      expect(verifyRes.status, `verify-pack stderr: ${verifyRes.stderr}`).toBe(0)
      const verifyJson = JSON.parse(verifyRes.stdout) as { valid: boolean; tarballPath: string }
      expect(verifyJson.valid).toBe(true)

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--tarball',
        verifyJson.tarballPath,
        '--npm-token',
        'fake-npm-token',
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--json',
      ])

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        action: string
        tag: string
        version: string
        draft: boolean
      }
      expect(parsed.action).toBe('published')
      expect(parsed.tag).toBe('v0.1.0')
      expect(parsed.version).toBe('0.1.0')
      expect(parsed.draft).toBe(false)

      // Verify npm registry received the package
      const npmPkg = fakeNpm.state.packages.get('drovr')
      expect(npmPkg).toBeDefined()
      expect(npmPkg?.versions.has('0.1.0')).toBe(true)
      expect(npmPkg?.distTags.latest).toBe('0.1.0')

      // Verify GitHub Release transitioned to public
      const ghRelease = fakeGh.state.releases.get(101)
      expect(ghRelease).toBeDefined()
      expect(ghRelease?.draft).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // Slice 4: Failure & Recovery Modes
  // --------------------------------------------------------------------------
  describe('Failure and recovery modes', () => {
    it('leaves GitHub Release in draft state when npm publication fails', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: headSha,
                type: 'commit',
              },
            },
          ],
        ]),
        releases: new Map([
          [
            101,
            {
              id: 101,
              tag_name: 'v0.1.0',
              target_commitish: headSha,
              name: 'v0.1.0',
              body: '## Added\n- initial release',
              draft: true,
              prerelease: false,
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      const fakeNpm = await createFakeNpmRegistryServer({
        simulatePublishError: 500,
        simulatePublishErrorBody: JSON.stringify({ error: 'npm registry 500 server error' }),
      })
      cleanupServers.push(fakeNpm.close)

      const distDir = join(repo, 'dist')
      await mkdir(distDir, { recursive: true })
      await writeFile(join(distDir, 'index.mjs'), 'export const v = "0.1.0";\n', 'utf8')
      await writeFile(join(distDir, 'index.d.mts'), 'export declare const v: string;\n', 'utf8')
      await writeFile(join(distDir, 'cli.mjs'), '#!/usr/bin/env node\n', 'utf8')

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--npm-token',
        'fake-npm-token',
        '--skip-checks',
        '--no-provenance',
      ])

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/npm/i)

      // GitHub Release must remain in draft
      const ghRelease = fakeGh.state.releases.get(101)
      expect(ghRelease?.draft).toBe(true)
    })

    it('leaves GitHub Release in draft state when npm confirmation lookup fails', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: headSha,
                type: 'commit',
              },
            },
          ],
        ]),
        releases: new Map([
          [
            101,
            {
              id: 101,
              tag_name: 'v0.1.0',
              target_commitish: headSha,
              name: 'v0.1.0',
              body: '## Added\n- initial release',
              draft: true,
              prerelease: false,
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      // npm PUT succeeds, but confirmation lookup simulates 404 version not found
      const fakeNpm = await createFakeNpmRegistryServer({
        simulateConfirmationNotFound: true,
      })
      cleanupServers.push(fakeNpm.close)

      const distDir = join(repo, 'dist')
      await mkdir(distDir, { recursive: true })
      await writeFile(join(distDir, 'index.mjs'), 'export const v = "0.1.0";\n', 'utf8')
      await writeFile(join(distDir, 'index.d.mts'), 'export declare const v: string;\n', 'utf8')
      await writeFile(join(distDir, 'cli.mjs'), '#!/usr/bin/env node\n', 'utf8')

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--npm-token',
        'fake-npm-token',
        '--skip-checks',
        '--no-provenance',
      ])

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/confirmed/i)

      // GitHub Release must remain in draft
      const ghRelease = fakeGh.state.releases.get(101)
      expect(ghRelease?.draft).toBe(true)
    })

    it('leaves GitHub Release in draft state when GitHub finalization fails, and resumes on rerun', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const fakeGh = await createFakeGitHubServer({
        simulateUpdateReleaseError: 500,
      })
      cleanupServers.push(fakeGh.close)

      const fakeNpm = await createFakeNpmRegistryServer()
      cleanupServers.push(fakeNpm.close)

      const distDir = join(repo, 'dist')
      await mkdir(distDir, { recursive: true })
      await writeFile(join(distDir, 'index.mjs'), 'export const v = "0.1.0";\n', 'utf8')
      await writeFile(join(distDir, 'index.d.mts'), 'export declare const v: string;\n', 'utf8')
      await writeFile(join(distDir, 'cli.mjs'), '#!/usr/bin/env node\n', 'utf8')

      runGit(repo, ['add', '-A'])
      runGit(repo, ['commit', '-m', 'feat: add build artifacts'])
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])
      fakeNpm.state.defaultGitHead = headSha
      fakeGh.state.tags.set('refs/tags/v0.1.0', {
        ref: 'refs/tags/v0.1.0',
        object: {
          sha: headSha,
          type: 'commit',
        },
      })
      fakeGh.state.releases.set(101, {
        id: 101,
        tag_name: 'v0.1.0',
        target_commitish: headSha,
        name: 'v0.1.0',
        body: '## Added\n- initial release',
        draft: true,
        prerelease: false,
      })
      // First run: npm publish succeeds, but GitHub release update fails (500)
      const firstRun = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--npm-token',
        'fake-npm-token',
        '--skip-checks',
        '--no-provenance',
      ])

      expect(firstRun.status).not.toBe(0)
      expect(firstRun.stderr).toMatch(/GitHub release/i)

      // npm package was published
      expect(fakeNpm.state.packages.get('drovr')?.versions.has('0.1.0')).toBe(true)

      // GitHub Release is still in draft
      expect(fakeGh.state.releases.get(101)?.draft).toBe(true)

      // Now clear simulated error on GitHub and rerun
      fakeGh.state.simulateUpdateReleaseError = undefined

      const secondRun = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--npm-token',
        'fake-npm-token',
        '--skip-checks',
        '--no-provenance',
      ])

      expect(secondRun.status, `stderr: ${secondRun.stderr}`).toBe(0)

      // GitHub Release is now public!
      expect(fakeGh.state.releases.get(101)?.draft).toBe(false)
    })

    it('resumes safely when npm version is already published and finalizes draft GitHub Release without republishing', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: headSha,
                type: 'commit',
              },
            },
          ],
        ]),
        releases: new Map([
          [
            101,
            {
              id: 101,
              tag_name: 'v0.1.0',
              target_commitish: headSha,
              name: 'v0.1.0',
              body: '## Added\n- initial release',
              draft: true,
              prerelease: false,
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      // npm already has version 0.1.0 matching headSha
      const fakeNpm = await createFakeNpmRegistryServer({
        packages: new Map([
          [
            'drovr',
            {
              name: 'drovr',
              versions: new Map([
                [
                  '0.1.0',
                  {
                    name: 'drovr',
                    version: '0.1.0',
                    gitHead: headSha,
                  },
                ],
              ]),
              distTags: { latest: '0.1.0' },
            },
          ],
        ]),
      })
      cleanupServers.push(fakeNpm.close)

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--npm-token',
        'fake-npm-token',
        '--skip-checks',
        '--no-provenance',
      ])

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      // GitHub Release must now be public
      const ghRelease = fakeGh.state.releases.get(101)
      expect(ghRelease?.draft).toBe(false)

      // npm was NOT re-published (no PUT requests)
      const putRequests = fakeNpm.state.publishRequests.filter((r) => r.method === 'PUT')
      expect(putRequests.length).toBe(0)
    })

    it('succeeds idempotently on rerun when both npm and GitHub Release are already published', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: headSha,
                type: 'commit',
              },
            },
          ],
        ]),
        releases: new Map([
          [
            101,
            {
              id: 101,
              tag_name: 'v0.1.0',
              target_commitish: headSha,
              name: 'v0.1.0',
              body: '## Added\n- initial release',
              draft: false,
              prerelease: false,
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      const fakeNpm = await createFakeNpmRegistryServer({
        packages: new Map([
          [
            'drovr',
            {
              name: 'drovr',
              versions: new Map([
                [
                  '0.1.0',
                  {
                    name: 'drovr',
                    version: '0.1.0',
                    gitHead: headSha,
                  },
                ],
              ]),
              distTags: { latest: '0.1.0' },
            },
          ],
        ]),
      })
      cleanupServers.push(fakeNpm.close)

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--npm-token',
        'fake-npm-token',
        '--skip-checks',
        '--no-provenance',
        '--json',
      ])

      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        action: string
        draft: boolean
      }
      expect(parsed.action).toBe('already-published')
      expect(parsed.draft).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // Slice 5: Immutable State Mismatch Protection
  // --------------------------------------------------------------------------
  describe('Immutable state mismatch protection', () => {
    it('fails without mutation when already-published npm version points to a different commit', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: headSha,
                type: 'commit',
              },
            },
          ],
        ]),
        releases: new Map([
          [
            101,
            {
              id: 101,
              tag_name: 'v0.1.0',
              target_commitish: headSha,
              name: 'v0.1.0',
              body: '## Added\n- initial release',
              draft: true,
              prerelease: false,
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      const fakeNpm = await createFakeNpmRegistryServer({
        packages: new Map([
          [
            'drovr',
            {
              name: 'drovr',
              versions: new Map([
                [
                  '0.1.0',
                  {
                    name: 'drovr',
                    version: '0.1.0',
                    gitHead: '1111111111111111111111111111111111111111',
                  },
                ],
              ]),
              distTags: { latest: '0.1.0' },
            },
          ],
        ]),
      })
      cleanupServers.push(fakeNpm.close)

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--npm-token',
        'fake-npm-token',
        '--skip-checks',
        '--no-provenance',
      ])

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/already published/i)
      expect(result.stderr).toMatch(/does not match/i)

      // GitHub Release must not have been modified
      const ghRelease = fakeGh.state.releases.get(101)
      expect(ghRelease?.draft).toBe(true)
    })

    it('fails without mutation when already-published npm version is missing gitHead', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: headSha,
                type: 'commit',
              },
            },
          ],
        ]),
        releases: new Map([
          [
            101,
            {
              id: 101,
              tag_name: 'v0.1.0',
              target_commitish: headSha,
              name: 'v0.1.0',
              body: '## Added\n- initial release',
              draft: true,
              prerelease: false,
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      // npm version exists but without gitHead
      const fakeNpm = await createFakeNpmRegistryServer({
        packages: new Map([
          [
            'drovr',
            {
              name: 'drovr',
              versions: new Map([
                [
                  '0.1.0',
                  {
                    name: 'drovr',
                    version: '0.1.0',
                    // no gitHead
                  },
                ],
              ]),
              distTags: { latest: '0.1.0' },
            },
          ],
        ]),
      })
      cleanupServers.push(fakeNpm.close)

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--npm-token',
        'fake-npm-token',
        '--skip-checks',
        '--no-provenance',
      ])

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/already published/i)
      expect(result.stderr).toMatch(/does not match/i)

      // GitHub Release must remain in draft
      const ghRelease = fakeGh.state.releases.get(101)
      expect(ghRelease?.draft).toBe(true)

      // npm was not mutated (no PUT requests)
      const putRequests = fakeNpm.state.publishRequests.filter((r) => r.method === 'PUT')
      expect(putRequests.length).toBe(0)
    })
  })

  // --------------------------------------------------------------------------
  // Slice 6: Authentication Modes (Token vs OIDC)
  // --------------------------------------------------------------------------
  describe('Authentication modes', () => {
    it('supports granular token via --npm-token flag', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: headSha,
                type: 'commit',
              },
            },
          ],
        ]),
        releases: new Map([
          [
            101,
            {
              id: 101,
              tag_name: 'v0.1.0',
              target_commitish: headSha,
              name: 'v0.1.0',
              body: '## Added\n- initial release',
              draft: true,
              prerelease: false,
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      const fakeNpm = await createFakeNpmRegistryServer()
      cleanupServers.push(fakeNpm.close)

      const distDir = join(repo, 'dist')
      await mkdir(distDir, { recursive: true })
      await writeFile(join(distDir, 'index.mjs'), 'export const v = "0.1.0";\n', 'utf8')
      await writeFile(join(distDir, 'index.d.mts'), 'export declare const v: string;\n', 'utf8')
      await writeFile(join(distDir, 'cli.mjs'), '#!/usr/bin/env node\n', 'utf8')

      const result = await runDrovr(repo, [
        'package-release',
        'publish',
        '--tag',
        'v0.1.0',
        '--version',
        '0.1.0',
        '--sha',
        headSha,
        '--github-api-url',
        fakeGh.url,
        '--github-token',
        'fake-token',
        '--repo',
        'ricardogzm/drovr',
        '--npm-registry',
        fakeNpm.url,
        '--npm-token',
        'granular-secret-token-12345',
        '--skip-checks',
        '--no-provenance',
      ])

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      // Verify auth header was sent on publish
      const putReq = fakeNpm.state.publishRequests.find((r) => r.method === 'PUT')
      expect(putReq).toBeDefined()
      expect(putReq?.authHeader).toMatch(/granular-secret-token-12345/)
    })
    it('publishes without token when --npm-token is omitted and NODE_AUTH_TOKEN is empty (tokenless OIDC default)', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: headSha,
                type: 'commit',
              },
            },
          ],
        ]),
        releases: new Map([
          [
            101,
            {
              id: 101,
              tag_name: 'v0.1.0',
              target_commitish: headSha,
              name: 'v0.1.0',
              body: '## Added\n- initial release',
              draft: true,
              prerelease: false,
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      const fakeNpm = await createFakeNpmRegistryServer()
      cleanupServers.push(fakeNpm.close)

      const distDir = join(repo, 'dist')
      await mkdir(distDir, { recursive: true })
      await writeFile(join(distDir, 'index.mjs'), 'export const v = "0.1.0";\n', 'utf8')
      await writeFile(join(distDir, 'index.d.mts'), 'export declare const v: string;\n', 'utf8')
      await writeFile(join(distDir, 'cli.mjs'), '#!/usr/bin/env node\n', 'utf8')

      const result = await runDrovr(
        repo,
        [
          'package-release',
          'publish',
          '--tag',
          'v0.1.0',
          '--version',
          '0.1.0',
          '--sha',
          headSha,
          '--github-api-url',
          fakeGh.url,
          '--github-token',
          'fake-token',
          '--repo',
          'ricardogzm/drovr',
          '--npm-registry',
          fakeNpm.url,
          '--skip-checks',
          '--no-provenance',
        ],
        { NODE_AUTH_TOKEN: '', NPM_TOKEN: '' },
      )

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      // Verify PUT request was recorded and had no Authorization header
      const putReq = fakeNpm.state.publishRequests.find((r) => r.method === 'PUT')
      expect(putReq).toBeDefined()
      expect(putReq?.authHeader).toBeUndefined()

      // Verify GitHub Release transitioned to public (not draft)
      const ghRelease = fakeGh.state.releases.get(101)
      expect(ghRelease?.draft).toBe(false)
    })

    it('treats empty NODE_AUTH_TOKEN as tokenless without sending empty or invalid Bearer header in registry queries', async () => {
      const repo = await initRepo({ version: '0.1.0' })
      cleanupDirs.push(repo)
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])
      runGit(repo, ['tag', 'v0.1.0', headSha])

      const fakeGh = await createFakeGitHubServer({
        tags: new Map([
          [
            'refs/tags/v0.1.0',
            {
              ref: 'refs/tags/v0.1.0',
              object: {
                sha: headSha,
                type: 'commit',
              },
            },
          ],
        ]),
        releases: new Map([
          [
            101,
            {
              id: 101,
              tag_name: 'v0.1.0',
              target_commitish: headSha,
              name: 'v0.1.0',
              body: '## Added\n- initial release',
              draft: true,
              prerelease: false,
            },
          ],
        ]),
      })
      cleanupServers.push(fakeGh.close)

      const fakeNpm = await createFakeNpmRegistryServer({
        packages: new Map([
          [
            'drovr',
            {
              name: 'drovr',
              versions: new Map([
                [
                  '0.1.0',
                  {
                    name: 'drovr',
                    version: '0.1.0',
                    gitHead: headSha,
                  },
                ],
              ]),
              distTags: { latest: '0.1.0' },
            },
          ],
        ]),
      })
      cleanupServers.push(fakeNpm.close)

      // When NODE_AUTH_TOKEN is empty string, getPackageVersion queries the registry without Authorization header
      const result = await runDrovr(
        repo,
        [
          'package-release',
          'publish',
          '--tag',
          'v0.1.0',
          '--version',
          '0.1.0',
          '--sha',
          headSha,
          '--github-api-url',
          fakeGh.url,
          '--github-token',
          'fake-token',
          '--repo',
          'ricardogzm/drovr',
          '--npm-registry',
          fakeNpm.url,
          '--skip-checks',
          '--no-provenance',
        ],
        { NODE_AUTH_TOKEN: '' },
      )

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      // Verify GET requests did NOT include Authorization header
      const getReqs = fakeNpm.state.publishRequests.filter((r) => r.method === 'GET')
      expect(getReqs.length).toBeGreaterThan(0)
      for (const req of getReqs) {
        expect(req.authHeader).toBeUndefined()
      }
    })
  })

  // --------------------------------------------------------------------------
  // Slice 7: Static Workflow Validation & Permission Contract
  // --------------------------------------------------------------------------
  describe('Static workflow validation & permission contract', () => {
    const workflowFile = join(root, '.github/workflows/package-release.yml')
    const schemaPath = join(root, 'tests/fixtures/schemas/github-workflow.json')
    const ajv = new Ajv({ allErrors: true, strict: false })

    it('validates .github/workflows/package-release.yml against published GitHub Workflow schema', () => {
      expect(existsSync(schemaPath)).toBe(true)
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
      const validate = ajv.compile(schema)

      const workflow = parseYaml(readFileSync(workflowFile, 'utf8')) as object
      const valid = validate(workflow)
      expect(validate.errors ?? []).toEqual([])
      expect(valid).toBe(true)
    })

    it('enforces trusted publishing and minimal job permissions contract', () => {
      const workflow = parseYaml(readFileSync(workflowFile, 'utf8')) as {
        jobs?: Record<
          string,
          {
            'runs-on'?: string
            permissions?: Record<string, string>
            steps?: Array<{
              name?: string
              id?: string
              run?: string
              uses?: string
              with?: Record<string, unknown>
              env?: Record<string, unknown>
            }>
          }
        >
      }

      expect(workflow.jobs).toBeDefined()
      const jobs = workflow.jobs!

      // 1. Validate-metadata job
      expect(jobs['validate-metadata']).toBeDefined()
      expect(jobs['validate-metadata']['runs-on']).toBe('ubuntu-latest')
      expect(jobs['validate-metadata'].permissions).toBeUndefined() // No write permissions

      // 2. Release-please job
      expect(jobs['release-please']).toBeDefined()
      expect(jobs['release-please']['runs-on']).toBe('ubuntu-latest')
      expect(jobs['release-please'].permissions).toEqual({
        contents: 'write',
        'pull-requests': 'write',
      })

      // 3. Publish-package job (id is publish-package)
      expect(jobs['publish-package']).toBeDefined()
      expect(jobs['publish-package']['runs-on']).toBe('ubuntu-latest')
      expect(jobs['publish-package'].permissions).toEqual({
        contents: 'write',
        'id-token': 'write',
      })

      // 4. Validate exact ordered checks in publish-package
      const steps = jobs['publish-package'].steps ?? []
      const runCommands = steps.map((s) => s.run ?? '').filter(Boolean)

      expect(runCommands.some((c) => c.includes('pnpm install --frozen-lockfile'))).toBe(true)
      expect(runCommands.some((c) => c.includes('pnpm run typecheck'))).toBe(true)
      expect(runCommands.some((c) => c.includes('pnpm run lint'))).toBe(true)
      expect(runCommands.some((c) => c.includes('pnpm run fmt:check'))).toBe(true)
      expect(runCommands.some((c) => c.includes('pnpm test'))).toBe(true)
      expect(runCommands.some((c) => c.includes('pnpm run build'))).toBe(true)

      // 5. Verify tarball path is captured from verify-pack and passed into publish
      const verifyStep = steps.find((s) => s.name === 'Verify package tarball')
      expect(verifyStep).toBeDefined()
      expect(verifyStep?.id).toBe('verify-pack')
      expect(verifyStep?.run).toContain('package-release verify-pack --keep-temp --json')
      expect(verifyStep?.run).toContain('GITHUB_OUTPUT')

      const publishStep = steps.find((s) => s.name === 'Publish to npm and finalize GitHub Release')
      expect(publishStep).toBeDefined()
      const publishEnv = publishStep?.env as Record<string, string> | undefined
      // Assert OIDC default: NODE_AUTH_TOKEN is NOT unconditionally injected in step env
      expect(publishEnv?.NODE_AUTH_TOKEN).toBeUndefined()
      expect(publishEnv?.NPM_TOKEN).toBe('${{ secrets.NPM_TOKEN }}')
      expect(publishStep?.run).toContain('if [ -n "${NPM_TOKEN:-}" ]; then')
      expect(publishStep?.run).toContain('export NODE_AUTH_TOKEN="$NPM_TOKEN"')
      expect(publishStep?.run).toContain('package-release publish')
      expect(publishStep?.run).toContain('--tarball')
    })
  })
})
