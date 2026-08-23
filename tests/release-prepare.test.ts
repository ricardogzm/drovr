import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

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

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drovr-prepare-release-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'drovr', version: '0.1.0' }, null, 2),
    'utf8',
  )
  await writeFile(join(dir, 'README.md'), '# test\n', 'utf8')
  runGit(dir, ['add', 'package.json', 'README.md'])
  runGit(dir, ['commit', '-m', 'chore: init'])
  return dir
}

interface FakeRelease {
  id: number
  tag_name: string
  target_commitish: string
  name: string
  body: string
  draft: boolean
  prerelease: boolean
  html_url?: string
}

interface FakeTagRef {
  ref: string
  object: {
    sha: string
    type: 'commit' | 'tag'
  }
}

interface FakeTagObject {
  tag: string
  sha: string
  object: {
    sha: string
    type: string
  }
}

interface FakeBranchRef {
  ref: string
  object: {
    sha: string
    type: 'commit'
  }
}

interface FakeGitHubState {
  tags: Map<string, FakeTagRef>
  tagObjects: Map<string, FakeTagObject>
  branches: Map<string, FakeBranchRef>
  releases: Map<number, FakeRelease>
  nextReleaseId: number
  generatedNotesBody?: string
  simulateGetRefError?: number
  simulateCreateRefError?: number
}

async function createFakeGitHubServer(initialState?: Partial<FakeGitHubState>): Promise<{
  server: Server
  url: string
  state: FakeGitHubState
  close: () => Promise<void>
}> {
  const state: FakeGitHubState = {
    tags: new Map(initialState?.tags || []),
    tagObjects: new Map(initialState?.tagObjects || []),
    branches: new Map(initialState?.branches || []),
    releases: new Map(initialState?.releases || []),
    nextReleaseId: initialState?.nextReleaseId || 100,
    generatedNotesBody: initialState?.generatedNotesBody,
    simulateGetRefError: initialState?.simulateGetRefError,
    simulateCreateRefError: initialState?.simulateCreateRefError,
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
    const bodyJson = bodyText ? JSON.parse(bodyText) : null

    // Simulated error for getRef
    if (state.simulateGetRefError && url.pathname.includes('/git/ref')) {
      res.writeHead(state.simulateGetRefError, {
        'Content-Type': 'application/json',
        Connection: 'close',
      })
      res.end(JSON.stringify({ message: 'Internal Server Error' }))
      return
    }

    // Simulated error for createRef
    if (state.simulateCreateRefError && url.pathname.endsWith('/git/refs') && method === 'POST') {
      res.writeHead(state.simulateCreateRefError, {
        'Content-Type': 'application/json',
        Connection: 'close',
      })
      res.end(JSON.stringify({ message: 'Internal Server Error' }))
      return
    }

    // Route: GET /repos/:owner/:repo/git/ref/tags/:tag or /repos/:owner/:repo/git/refs/tags/:tag
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

    // Route: GET /repos/:owner/:repo/git/ref/heads/:branch or /repos/:owner/:repo/git/refs/heads/:branch
    const branchMatch = /^\/repos\/[^/]+\/[^/]+\/git\/refs?\/heads\/(.+)$/.exec(url.pathname)
    if (branchMatch && method === 'GET') {
      const branch = branchMatch[1]
      const ref = state.branches.get(`refs/heads/${branch}`) || state.branches.get(branch)
      if (ref) {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify(ref))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ message: 'Not Found' }))
      return
    }

    // Route: GET /repos/:owner/:repo/git/tags/:sha
    const gitTagMatch = /^\/repos\/[^/]+\/[^/]+\/git\/tags\/(.+)$/.exec(url.pathname)
    if (gitTagMatch && method === 'GET') {
      const tagSha = gitTagMatch[1]
      const tagObj = state.tagObjects.get(tagSha)
      if (tagObj) {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify(tagObj))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ message: 'Not Found' }))
      return
    }

    // Route: POST /repos/:owner/:repo/git/refs
    if (/^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(url.pathname) && method === 'POST') {
      const refName = bodyJson.ref as string
      if (state.tags.has(refName)) {
        res.writeHead(422, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify({ message: 'Reference already exists' }))
        return
      }
      const tagRef: FakeTagRef = {
        ref: refName,
        object: {
          sha: bodyJson.sha as string,
          type: 'commit',
        },
      }
      state.tags.set(refName, tagRef)
      res.writeHead(201, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify(tagRef))
      return
    }

    // Route: GET /repos/:owner/:repo/releases/tags/:tag
    const releaseByTagMatch = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(url.pathname)
    if (releaseByTagMatch && method === 'GET') {
      const tag = releaseByTagMatch[1]
      const release = Array.from(state.releases.values()).find(
        (r) => r.tag_name === tag && !r.draft,
      )
      if (release) {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify(release))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ message: 'Not Found' }))
      return
    }

    // Route: GET /repos/:owner/:repo/releases
    if (/^\/repos\/[^/]+\/[^/]+\/releases$/.test(url.pathname) && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify(Array.from(state.releases.values())))
      return
    }

    // Route: POST /repos/:owner/:repo/releases
    if (/^\/repos\/[^/]+\/[^/]+\/releases$/.test(url.pathname) && method === 'POST') {
      const id = ++state.nextReleaseId
      const newRelease: FakeRelease = {
        id,
        tag_name: bodyJson.tag_name,
        target_commitish: bodyJson.target_commitish,
        name: bodyJson.name || bodyJson.tag_name,
        body: bodyJson.body || '',
        draft: bodyJson.draft ?? true,
        prerelease: bodyJson.prerelease ?? false,
        html_url: `https://github.com/test/repo/releases/tag/${bodyJson.tag_name}`,
      }
      state.releases.set(id, newRelease)
      res.writeHead(201, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify(newRelease))
      return
    }

    // Route: PATCH /repos/:owner/:repo/releases/:id
    const releasePatchMatch = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)$/.exec(url.pathname)
    if (releasePatchMatch && method === 'PATCH') {
      const id = Number.parseInt(releasePatchMatch[1], 10)
      const existing = state.releases.get(id)
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify({ message: 'Not Found' }))
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

    // Route: POST /repos/:owner/:repo/releases/generate-notes
    if (
      /^\/repos\/[^/]+\/[^/]+\/releases\/generate-notes$/.test(url.pathname) &&
      method === 'POST'
    ) {
      if (state.generatedNotesBody !== undefined) {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(
          JSON.stringify({
            name: bodyJson.tag_name,
            body: state.generatedNotesBody,
          }),
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(
        JSON.stringify({
          name: bodyJson.tag_name,
          body: `## What's Changed\n* feat: pull request item by @dev in https://github.com/test/repo/pull/1\n\n## New Contributors\n* @dev made their first contribution\n\n**Full Changelog**: https://github.com/test/repo/commits/${bodyJson.tag_name}`,
        }),
      )
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' })
    res.end(JSON.stringify({ message: `unhandled route ${method} ${url.pathname}` }))
  })

  const { promise: listenPromise, resolve: listenResolve } = withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listenResolve())
  await listenPromise

  const addr = server.address() as AddressInfo
  const urlString = `http://127.0.0.1:${addr.port}`

  return {
    server,
    url: urlString,
    state,
    close: () => {
      const { promise, resolve, reject } = withResolvers<void>()
      if (!server.listening) {
        resolve()
        return promise
      }
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
      server.close((err) => (err ? reject(err) : resolve()))
      return promise
    },
  }
}

let activeServers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of activeServers) {
    await close()
  }
  activeServers = []
})

beforeAll(() => {
  if (!existsSync(drovr)) {
    execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  }
})

describe('drovr package-release prepare', () => {
  it('1. no prior release: creates immutable v0.1.0 tag and draft release with commit history Full Changelog', async () => {
    const repo = await initRepo()
    const fakeGh = await createFakeGitHubServer()
    activeServers.push(fakeGh.close)

    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: add first capability'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix: correct startup issue'])
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])

      const result = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).toBe(0)

      // Local tag must exist and point to headSha
      const localTagSha = runGit(repo, ['rev-parse', 'v0.1.0^{commit}'])
      expect(localTagSha).toBe(headSha)

      // Remote tag ref must exist on GitHub
      const remoteRef = fakeGh.state.tags.get('refs/tags/v0.1.0')
      expect(remoteRef).toBeDefined()
      expect(remoteRef?.object.sha).toBe(headSha)

      // Draft release must exist in draft state
      const releases = Array.from(fakeGh.state.releases.values())
      expect(releases).toHaveLength(1)
      const draft = releases[0]
      expect(draft.tag_name).toBe('v0.1.0')
      expect(draft.target_commitish).toBe(headSha)
      expect(draft.draft).toBe(true)

      // Release body must follow metadata contract
      expect(draft.body).toContain('### Added\n- add first capability')
      expect(draft.body).toContain('### Fixed\n- correct startup issue')
      // No New Contributors
      expect(draft.body).not.toContain('## New Contributors')
      expect(draft.body).not.toContain('made their first contribution')
      // Full Changelog for 0.1.0 uses commit history at v0.1.0
      expect(draft.body).toContain(
        '**Full Changelog**: https://github.com/ricardogzm/drovr/commits/v0.1.0',
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('2. prior published release: prepares next draft version with previous-tag comparison Full Changelog', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: initial feature'])
    runGit(repo, ['tag', 'v0.1.0'])
    const v1Sha = runGit(repo, ['rev-parse', 'v0.1.0'])

    const fakeGh = await createFakeGitHubServer({
      tags: new Map([
        [
          'refs/tags/v0.1.0',
          {
            ref: 'refs/tags/v0.1.0',
            object: { sha: v1Sha, type: 'commit' },
          },
        ],
      ]),
      releases: new Map([
        [
          1,
          {
            id: 1,
            tag_name: 'v0.1.0',
            target_commitish: v1Sha,
            name: 'v0.1.0',
            body: '### Added\n- initial feature\n\n**Full Changelog**: https://github.com/ricardogzm/drovr/commits/v0.1.0',
            draft: false,
            prerelease: false,
          },
        ],
      ]),
    })
    activeServers.push(fakeGh.close)

    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: second feature'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'docs: update readme'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix: patch edge case'])
      const headSha = runGit(repo, ['rev-parse', 'HEAD'])

      const result = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.2.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).toBe(0)

      // Local tag v0.2.0 must exist and point to headSha
      expect(runGit(repo, ['rev-parse', 'v0.2.0^{commit}'])).toBe(headSha)

      // Remote tag ref v0.2.0 must exist
      expect(fakeGh.state.tags.get('refs/tags/v0.2.0')?.object.sha).toBe(headSha)

      // A new draft release for v0.2.0 must be created
      const releases = Array.from(fakeGh.state.releases.values())
      expect(releases).toHaveLength(2)
      const v2Draft = releases.find((r) => r.tag_name === 'v0.2.0')
      expect(v2Draft).toBeDefined()
      expect(v2Draft?.draft).toBe(true)
      expect(v2Draft?.target_commitish).toBe(headSha)

      // Release body only has commits in v0.1.0..v0.2.0 range and omits docs
      expect(v2Draft?.body).toContain('### Added\n- second feature')
      expect(v2Draft?.body).toContain('### Fixed\n- patch edge case')
      expect(v2Draft?.body).not.toContain('initial feature')
      expect(v2Draft?.body).not.toContain('update readme')

      // Full Changelog uses compare link from v0.1.0 to v0.2.0
      expect(v2Draft?.body).toContain(
        '**Full Changelog**: https://github.com/ricardogzm/drovr/compare/v0.1.0...v0.2.0',
      )

      // Prior published release remains unchanged
      const v1Release = releases.find((r) => r.tag_name === 'v0.1.0')
      expect(v1Release?.draft).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('3. tag-only recovery: reuses existing matching tag without deleting or moving it and creates draft', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: awesome feature'])
    const headSha = runGit(repo, ['rev-parse', 'HEAD'])
    runGit(repo, ['tag', 'v0.1.0', headSha])

    const fakeGh = await createFakeGitHubServer({
      tags: new Map([
        [
          'refs/tags/v0.1.0',
          {
            ref: 'refs/tags/v0.1.0',
            object: { sha: headSha, type: 'commit' },
          },
        ],
      ]),
      releases: new Map(), // No draft release yet
    })
    activeServers.push(fakeGh.close)

    try {
      const result = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).toBe(0)

      // Tag still points to headSha
      expect(runGit(repo, ['rev-parse', 'v0.1.0^{commit}'])).toBe(headSha)
      expect(fakeGh.state.tags.get('refs/tags/v0.1.0')?.object.sha).toBe(headSha)

      // Draft release now created
      const releases = Array.from(fakeGh.state.releases.values())
      expect(releases).toHaveLength(1)
      expect(releases[0].tag_name).toBe('v0.1.0')
      expect(releases[0].draft).toBe(true)
      expect(releases[0].body).toContain('### Added\n- awesome feature')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('4. tag-plus-draft recovery: updates existing draft notes idempotently without creating duplicate releases', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: feature one'])
    const headSha = runGit(repo, ['rev-parse', 'HEAD'])
    runGit(repo, ['tag', 'v0.1.0', headSha])

    const fakeGh = await createFakeGitHubServer({
      tags: new Map([
        [
          'refs/tags/v0.1.0',
          {
            ref: 'refs/tags/v0.1.0',
            object: { sha: headSha, type: 'commit' },
          },
        ],
      ]),
      releases: new Map([
        [
          42,
          {
            id: 42,
            tag_name: 'v0.1.0',
            target_commitish: headSha,
            name: 'v0.1.0',
            body: 'old placeholder draft body',
            draft: true,
            prerelease: false,
          },
        ],
      ]),
    })
    activeServers.push(fakeGh.close)

    try {
      const result = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).toBe(0)

      // Still exactly 1 release (no duplicates created)
      const releases = Array.from(fakeGh.state.releases.values())
      expect(releases).toHaveLength(1)
      expect(releases[0].id).toBe(42)
      expect(releases[0].draft).toBe(true)
      expect(releases[0].body).toContain('### Added\n- feature one')
      expect(releases[0].body).not.toContain('old placeholder draft body')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('5. already-prepared recovery: detects matching tag and draft with exact body and succeeds without duplicate calls', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: stable capability'])
    const headSha = runGit(repo, ['rev-parse', 'HEAD'])
    runGit(repo, ['tag', 'v0.1.0', headSha])

    // First run to prepare
    const fakeGh = await createFakeGitHubServer()
    activeServers.push(fakeGh.close)

    try {
      const firstRun = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )
      expect(firstRun.status).toBe(0)

      const firstRelease = Array.from(fakeGh.state.releases.values())[0]
      const exactBody = firstRelease.body

      // Second run: already prepared
      const secondRun = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )
      expect(secondRun.status).toBe(0)

      const releases = Array.from(fakeGh.state.releases.values())
      expect(releases).toHaveLength(1)
      expect(releases[0].body).toBe(exactBody)
      expect(releases[0].draft).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('6a. mismatched state (tag mismatch): fails with actionable diagnostic without deleting or moving existing tag', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: initial work'])
    const oldSha = runGit(repo, ['rev-parse', 'HEAD'])
    runGit(repo, ['tag', 'v0.1.0', oldSha])

    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: new work on main'])

    const fakeGh = await createFakeGitHubServer({
      tags: new Map([
        [
          'refs/tags/v0.1.0',
          {
            ref: 'refs/tags/v0.1.0',
            object: { sha: oldSha, type: 'commit' },
          },
        ],
      ]),
    })
    activeServers.push(fakeGh.close)

    try {
      const result = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Tag "v0.1.0" already exists/i)
      expect(result.stderr).toMatch(/does not match/i)
      expect(result.stderr).toMatch(/immutable/i)

      // Existing tag must NOT have been moved or deleted
      expect(runGit(repo, ['rev-parse', 'v0.1.0^{commit}'])).toBe(oldSha)
      expect(fakeGh.state.tags.get('refs/tags/v0.1.0')?.object.sha).toBe(oldSha)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('6b. mismatched state (draft target_commitish hex mismatch): fails with actionable diagnostic without destructive mutation', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: base commit'])
    const baseSha = runGit(repo, ['rev-parse', 'HEAD'])

    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: target commit'])

    const fakeGh = await createFakeGitHubServer({
      releases: new Map([
        [
          1,
          {
            id: 1,
            tag_name: 'v0.1.0',
            target_commitish: baseSha,
            name: 'v0.1.0',
            body: 'draft pointing to wrong commit',
            draft: true,
            prerelease: false,
          },
        ],
      ]),
    })
    activeServers.push(fakeGh.close)

    try {
      const result = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Draft release "v0.1.0"/i)
      expect(result.stderr).toMatch(/does not match/i)

      // Release must NOT be deleted or mutated
      expect(fakeGh.state.releases.get(1)?.target_commitish).toBe(baseSha)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('6c. matching tag+draft recovery when draft target_commitish is a branch whose HEAD moved: resumes and updates draft', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: authorized commit'])
    const authSha = runGit(repo, ['rev-parse', 'HEAD'])
    runGit(repo, ['tag', 'v0.1.0', authSha])

    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: subsequent commit on main'])
    const newerSha = runGit(repo, ['rev-parse', 'HEAD'])

    const fakeGh = await createFakeGitHubServer({
      branches: new Map([
        [
          'refs/heads/main',
          {
            ref: 'refs/heads/main',
            object: { sha: newerSha, type: 'commit' },
          },
        ],
      ]),
      tags: new Map([
        [
          'refs/tags/v0.1.0',
          {
            ref: 'refs/tags/v0.1.0',
            object: { sha: authSha, type: 'commit' },
          },
        ],
      ]),
      releases: new Map([
        [
          1,
          {
            id: 1,
            tag_name: 'v0.1.0',
            target_commitish: 'main',
            name: 'v0.1.0',
            body: 'placeholder draft notes',
            draft: true,
            prerelease: false,
          },
        ],
      ]),
    })
    activeServers.push(fakeGh.close)

    try {
      const result = await runDrovr(
        repo,
        [
          'package-release',
          'prepare',
          '--tag',
          'v0.1.0',
          '--sha',
          authSha,
          '--repo',
          'ricardogzm/drovr',
        ],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).toBe(0)

      // Remote tag must remain at authSha
      expect(fakeGh.state.tags.get('refs/tags/v0.1.0')?.object.sha).toBe(authSha)

      // Draft must be updated with canonical notes and remain a single draft
      const releases = Array.from(fakeGh.state.releases.values())
      expect(releases).toHaveLength(1)
      expect(releases[0].id).toBe(1)
      expect(releases[0].draft).toBe(true)
      expect(releases[0].body).toContain('### Added\n- authorized commit')
      expect(releases[0].body).not.toContain('placeholder draft notes')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('6d. mismatched state (annotated tag peeling mismatch): peels tag object and fails on commit mismatch without moving tag', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: base commit'])
    const baseSha = runGit(repo, ['rev-parse', 'HEAD'])

    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: new target commit'])
    const targetSha = runGit(repo, ['rev-parse', 'HEAD'])

    const tagObjSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const fakeGh = await createFakeGitHubServer({
      tags: new Map([
        [
          'refs/tags/v0.1.0',
          {
            ref: 'refs/tags/v0.1.0',
            object: { sha: tagObjSha, type: 'tag' },
          },
        ],
      ]),
      tagObjects: new Map([
        [
          tagObjSha,
          {
            tag: 'v0.1.0',
            sha: tagObjSha,
            object: { sha: baseSha, type: 'commit' },
          },
        ],
      ]),
    })
    activeServers.push(fakeGh.close)

    try {
      const result = await runDrovr(
        repo,
        [
          'package-release',
          'prepare',
          '--tag',
          'v0.1.0',
          '--sha',
          targetSha,
          '--repo',
          'ricardogzm/drovr',
        ],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Tag "v0.1.0" already exists/i)
      expect(result.stderr).toMatch(/does not match target commit/i)

      // Remote tag must not have been modified
      expect(fakeGh.state.tags.get('refs/tags/v0.1.0')?.object.sha).toBe(tagObjSha)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('7. retains What’s Changed PR items, removes New Contributors, and orders categories correctly with breaking precedence', async () => {
    const repo = await initRepo()
    const fakeGh = await createFakeGitHubServer({
      generatedNotesBody: `## What's Changed
* feat: pull request 10 by @alice in https://github.com/ricardogzm/drovr/pull/10
* fix: bugfix 11 by @bob in https://github.com/ricardogzm/drovr/pull/11

## New Contributors
* @alice made their first contribution in https://github.com/ricardogzm/drovr/pull/10

**Full Changelog**: https://github.com/ricardogzm/drovr/commits/v0.1.0`,
    })
    activeServers.push(fakeGh.close)

    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat!: breaking change marker'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: standard feature'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix: standard fix'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'perf: speed boost'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'remove: drop obsolete api'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'chore: ignore this'])

      const result = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr', '--json'],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).toBe(0)

      const jsonOutput = JSON.parse(result.stdout)
      expect(jsonOutput.tag).toBe('v0.1.0')
      expect(jsonOutput.draft).toBe(true)

      const body = jsonOutput.body

      // Section order: Breaking Changes, Added, Changed, Fixed, Removed, What's Changed, Full Changelog
      const idxBreaking = body.indexOf('### Breaking Changes')
      const idxAdded = body.indexOf('### Added')
      const idxChanged = body.indexOf('### Changed')
      const idxFixed = body.indexOf('### Fixed')
      const idxRemoved = body.indexOf('### Removed')
      const idxWhatsChanged = body.indexOf("## What's Changed")
      const idxChangelog = body.indexOf('**Full Changelog**')

      expect(idxBreaking).toBeGreaterThanOrEqual(0)
      expect(idxAdded).toBeGreaterThan(idxBreaking)
      expect(idxChanged).toBeGreaterThan(idxAdded)
      expect(idxFixed).toBeGreaterThan(idxChanged)
      expect(idxRemoved).toBeGreaterThan(idxFixed)
      expect(idxWhatsChanged).toBeGreaterThan(idxRemoved)
      expect(idxChangelog).toBeGreaterThan(idxWhatsChanged)

      // Breaking change is not in Added
      expect(body).toContain('### Breaking Changes\n- breaking change marker')
      expect(body).not.toContain('### Added\n- breaking change marker')

      // Hidden chore is omitted
      expect(body).not.toContain('ignore this')

      // New Contributors is removed
      expect(body).not.toContain('New Contributors')
      expect(body).not.toContain('made their first contribution')

      // What's Changed items are present
      expect(body).toContain('feat: pull request 10 by @alice')
      expect(body).toContain('fix: bugfix 11 by @bob')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('8a. remote API errors: getRef non-404 failure throws actionable diagnostic and creates no draft', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: valid commit'])

    // Server with 500 error on getRef
    const fakeGhError = await createFakeGitHubServer({
      simulateGetRefError: 500,
    })
    activeServers.push(fakeGhError.close)

    try {
      const result = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGhError.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Failed to get remote git ref/i)
      expect(result.stderr).toMatch(/500/i)

      // No releases should have been created
      expect(fakeGhError.state.releases.size).toBe(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('8b. remote API errors: createRef failure throws actionable diagnostic and creates no draft when tag is missing', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: valid commit'])

    // Server where getRef returns 404 but createRef returns 500
    const fakeGhError = await createFakeGitHubServer({
      simulateCreateRefError: 500,
    })
    activeServers.push(fakeGhError.close)

    try {
      const result = await runDrovr(
        repo,
        ['package-release', 'prepare', '--tag', 'v0.1.0', '--repo', 'ricardogzm/drovr'],
        {
          GITHUB_API_URL: fakeGhError.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Failed to create remote git ref/i)
      expect(result.stderr).toMatch(/500/i)

      // No releases should have been created
      expect(fakeGhError.state.releases.size).toBe(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('9. authorized commit pinning: --sha creates local and remote tag at the authorized commit', async () => {
    const repo = await initRepo()
    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: authorized commit'])
    const authSha = runGit(repo, ['rev-parse', 'HEAD'])

    runGit(repo, ['commit', '--allow-empty', '-m', 'feat: newer unreleased commit on main'])
    const headSha = runGit(repo, ['rev-parse', 'HEAD'])

    const fakeGh = await createFakeGitHubServer()
    activeServers.push(fakeGh.close)

    try {
      const result = await runDrovr(
        repo,
        [
          'package-release',
          'prepare',
          '--tag',
          'v0.1.0',
          '--sha',
          authSha,
          '--repo',
          'ricardogzm/drovr',
        ],
        {
          GITHUB_API_URL: fakeGh.url,
          GH_TOKEN: 'fake-token',
        },
      )

      expect(result.status).toBe(0)

      // Tag should point to authSha, NOT headSha
      expect(runGit(repo, ['rev-parse', 'v0.1.0^{commit}'])).toBe(authSha)
      expect(runGit(repo, ['rev-parse', 'v0.1.0^{commit}'])).not.toBe(headSha)

      // Remote tag should point to authSha
      expect(fakeGh.state.tags.get('refs/tags/v0.1.0')?.object.sha).toBe(authSha)

      // Draft release target_commitish should be authSha
      const releases = Array.from(fakeGh.state.releases.values())
      expect(releases).toHaveLength(1)
      expect(releases[0].target_commitish).toBe(authSha)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
