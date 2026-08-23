import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(root, 'scripts/bootstrap-package-release.sh')
const templatePath = join(root, '.agents/skills/wizard/template.sh')

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

async function runScript(
  args: string[],
  options: {
    cwd?: string
    env?: Record<string, string>
    input?: string
  } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { promise, resolve } = withResolvers<{
    status: number | null
    stdout: string
    stderr: string
  }>()

  const child = spawn('bash', [scriptPath, ...args], {
    cwd: options.cwd || root,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  child.stdout.on('data', (d) => {
    stdout += d.toString('utf8')
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString('utf8')
  })

  if (options.input !== undefined) {
    child.stdin.write(options.input)
    child.stdin.end()
  } else {
    child.stdin.end()
  }

  child.on('close', (status) => {
    resolve({
      status,
      stdout,
      stderr,
    })
  })

  child.on('error', (err) => {
    resolve({
      status: -1,
      stdout,
      stderr: err.message,
    })
  })

  return promise
}

describe('Package Release 0.1.0 Bootstrap and OIDC Cutover Wizard', () => {
  const cleanupDirs: string[] = []

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop()
      if (dir && existsSync(dir)) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  })

  describe('Seam 1: Script file, permissions, and syntax validation (AC 12)', () => {
    it('exists at scripts/bootstrap-package-release.sh and is executable', () => {
      expect(existsSync(scriptPath)).toBe(true)
      const stat = statSync(scriptPath)
      // Check executable bits (user executable: 0o100)
      expect(stat.mode & 0o100).toBe(0o100)
    })

    it('passes bash syntax check (bash -n)', () => {
      const output = execFileSync('bash', ['-n', scriptPath], {
        encoding: 'utf8',
      })
      expect(output).toBe('')
    })

    it('passes shellcheck if the binary exists or skips cleanly', () => {
      let shellcheckAvailable = false
      try {
        execFileSync('which', ['shellcheck'], { stdio: 'ignore' })
        shellcheckAvailable = true
      } catch {}

      const output = shellcheckAvailable
        ? execFileSync('shellcheck', [scriptPath], { encoding: 'utf8' })
        : ''
      expect(output).toBe('')
    })

    it('preserves the wizard template library above the STAGES marker verbatim', () => {
      const scriptContent = readFileSync(scriptPath, 'utf8')
      const templateContent = readFileSync(templatePath, 'utf8')

      const marker = '# STAGES'
      expect(scriptContent).toContain(marker)
      expect(templateContent).toContain(marker)

      const scriptLibrary = scriptContent.split(marker)[0]
      const templateLibrary = templateContent.split(marker)[0]

      expect(scriptLibrary.trim()).toBe(templateLibrary.trim())
    })
  })

  describe('Seam 2: Static trace of captured secrets and destinations (AC 3, AC 4, AC 7)', () => {
    it('uses ask_secret for NPM_TOKEN and never plain ask', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Must capture secret with ask_secret
      expect(stagesSection).toMatch(/ask_secret\s+NPM_TOKEN/)
      // Must NOT capture token with plain ask
      expect(stagesSection).not.toMatch(/ask\s+NPM_TOKEN/)
    })

    it('never persists NPM_TOKEN in repository or environment files (no write_env for secret)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Must NOT call write_env with NPM_TOKEN
      expect(stagesSection).not.toMatch(/write_env\s+NPM_TOKEN/)
      expect(stagesSection).not.toMatch(/write_env\s+.*TOKEN/)
    })

    it('sets the exact GitHub Actions secret NPM_TOKEN consumed by workflow and never prints the token', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Must set secret NPM_TOKEN
      expect(stagesSection).toMatch(/(?:set_secret|gh\s+secret\s+set)\s+NPM_TOKEN/)
      // Value must never be printed to stdout/stderr
      expect(stagesSection).not.toMatch(/echo\s+["']?\$NPM_TOKEN/)
      expect(stagesSection).not.toMatch(/printf\s+[^;]*\$NPM_TOKEN/)
    })

    it('includes authoritative npm token and trusted publisher URLs', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Authoritative URLs
      expect(stagesSection).toMatch(/https:\/\/www\.npmjs\.com\/settings\/tokens/)
      expect(stagesSection).toMatch(/https:\/\/www\.npmjs\.com\/package\/drovr\/access/)
    })

    it('provides exact GitHub owner, repo, workflow filename, and npm publish allowed action for OIDC (AC 7)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      expect(stagesSection).toContain('ricardogzm')
      expect(stagesSection).toContain('drovr')
      expect(stagesSection).toContain('package-release.yml')
      expect(stagesSection).toMatch(/Allowed actions:.*npm publish/i)
    })

    it('never invokes live publication commands directly (no npm publish or gh release create)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Script must not run `npm publish` or `gh release create` directly
      expect(stagesSection).not.toMatch(/^\s*npm\s+publish/m)
      expect(stagesSection).not.toMatch(/^\s*gh\s+release\s+create/m)
    })
  })

  describe('Seam 3: Pre-flight checks and tool verification (AC 1, AC 2)', () => {
    it('checks for required tools and auth status and fails when unauthenticated', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-test-bin-'))
      cleanupDirs.push(tempDir)

      // Create a fake unauthenticated gh
      await writeFile(
        join(tempDir, 'gh'),
        `#!/usr/bin/env bash
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  echo "You are not logged into any GitHub hosts" >&2
  exit 1
fi
exit 0
`,
      )
      await chmod(join(tempDir, 'gh'), 0o755)

      // Create a fake npm that fails whoami
      await writeFile(
        join(tempDir, 'npm'),
        `#!/usr/bin/env bash
if [[ "$1" == "whoami" ]]; then
  echo "eneedauth: need auth" >&2
  exit 1
fi
exit 0
`,
      )
      await chmod(join(tempDir, 'npm'), 0o755)

      const result = await runScript(['--check-only'], {
        env: {
          PATH: `${tempDir}:${process.env.PATH}`,
        },
        input: '\n',
      })

      // The pre-flight check should report authentication issues or instructions
      expect(result.status).not.toBe(0)
      expect(result.stdout + result.stderr).toMatch(/gh|npm|auth/i)
    })

    it('succeeds in check-only mode when all tools and authentications pass', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-test-bin-ok-'))
      cleanupDirs.push(tempDir)

      // Create mock gh
      await writeFile(
        join(tempDir, 'gh'),
        `#!/usr/bin/env bash
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  echo "Logged in to github.com account maintainer"
  exit 0
fi
if [[ "$1" == "api" && "$2" == "user" ]]; then
  echo "maintainer"
  exit 0
fi
exit 0
`,
      )
      await chmod(join(tempDir, 'gh'), 0o755)

      // Create mock npm
      await writeFile(
        join(tempDir, 'npm'),
        `#!/usr/bin/env bash
if [[ "$1" == "whoami" ]]; then
  echo "maintainer"
  exit 0
fi
exit 0
`,
      )
      await chmod(join(tempDir, 'npm'), 0o755)

      const result = await runScript(['--check-only'], {
        env: {
          PATH: `${tempDir}:${process.env.PATH}`,
        },
        input: '\n',
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/All pre-flight checks passed/i)
    })

    it('aborts with exit 1 on unexpected existing npm package versions (AC 2)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Must abort if package exists at version != 0.1.0
      expect(stagesSection).toMatch(
        /EXISTING_VERSION.*!=.*BOOTSTRAP_VERSION|EXISTING_VERSION.*==.*BOOTSTRAP_VERSION/,
      )
      expect(stagesSection).not.toMatch(/Do you want to proceed despite the existing package/)
    })
  })

  describe('Seam 4: Idempotence, Stage Progression & Verification (AC 5, AC 6, AC 8, AC 9, AC 10, AC 11)', () => {
    it('declares TOTAL_STAGES matching stage definitions', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''
      const totalMatch = stagesSection.match(/TOTAL_STAGES=(\d+)/)
      expect(totalMatch).not.toBeNull()
      const totalStages = parseInt(totalMatch![1], 10)

      const stageMatches = stagesSection.match(/stage\s+"[^"]+"/g) || []
      expect(stageMatches.length).toBe(totalStages)
      expect(totalStages).toBeGreaterThanOrEqual(6)
    })

    it('guides authorizing and monitoring Package Release without bypassing reviewed PR (AC 5)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      expect(stagesSection).toContain('pulls')
      expect(stagesSection).toContain('actions/workflows/package-release.yml')
      expect(stagesSection).toContain('Release Please')
      expect(stagesSection).toContain('publish-package')
    })

    it('requires hard confirmation gates before irreversible actions and exits 1 if declined (AC 8, AC 11)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Must have confirm calls for irreversible actions (e.g. deleting secret, revoking token, merging PR)
      const confirmCalls = stagesSection.match(/confirm\s+"[^"]+"/g) || []
      expect(confirmCalls.length).toBeGreaterThanOrEqual(3)

      // AC8: if trusted-publisher confirm is declined, exit 1
      expect(stagesSection).toMatch(
        /if ! confirm "Have you configured the Trusted Publisher.*"; then[\s\S]*exit 1[\s\S]*fi/,
      )
    })

    it('deletes NPM_TOKEN secret after trusted publishing is configured and verifies absence without false-absent (AC 8, AC 9)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Must contain command to delete NPM_TOKEN secret
      expect(stagesSection).toMatch(/gh\s+secret\s+delete\s+NPM_TOKEN/)
      // Distinguishes verified absent from list failure
      expect(stagesSection).toMatch(/Could not verify GitHub repository secrets via gh CLI/)
      expect(stagesSection).toContain('OIDC')
      expect(stagesSection).toMatch(/OIDC[- ]only|OIDC Cutover Complete/i)
    })

    it('participates all verification items in VERIFY_FAILED and exits 1 on failure (AC 6)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      expect(stagesSection).toContain('drovr@0.1.0')
      expect(stagesSection).toContain('dist.attestations')
      expect(stagesSection).toContain('v0.1.0')
      expect(stagesSection).toContain('isDraft')
      expect(stagesSection).toContain('isPrerelease')
      expect(stagesSection).toContain('VERIFY_FAILED=1')
      expect(stagesSection).not.toMatch(/Do you want to proceed with OIDC configuration anyway/)
    })

    it('requires real npm provenance attestations and does not pass on gitHead alone (AC 6, AC 12)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Must inspect dist.attestations
      expect(stagesSection).toMatch(/npm view drovr@0\.1\.0 dist\.attestations/)
      // Must not treat gitHead as satisfying provenance check
      expect(stagesSection).not.toMatch(/NPM_GIT_HEAD.*!=.*undefined.*VERIFY_FAILED=0/)
      expect(stagesSection).not.toMatch(/NPM_GIT_HEAD.*Provenance attestations verified/)
    })

    it('requires Full Changelog and heading-form category in release notes, rejecting Release Notes alias (AC 6, AC 12)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Must require Full Changelog
      expect(stagesSection).toMatch(/grep -F "Full Changelog"/)
      // Must require heading-form category: ### Breaking Changes, Added, Changed, Fixed, Removed
      expect(stagesSection).toMatch(/\^### \(Breaking Changes\|Added\|Changed\|Fixed\|Removed\)/)
      // Must not accept bare 'Release Notes'
      expect(stagesSection).not.toMatch(/grep -E ".*Release Notes.*"/)
    })

    it('provides clear recovery instructions with Package Release workflow URL on verification failure (AC 11)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      expect(stagesSection).toMatch(/Recovery instruction/i)
      expect(stagesSection).toContain('actions/workflows/package-release.yml')
    })

    it('recognizes completed stages on re-run and skips token creation when 0.1.0 is published (AC 10)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      // Stage 3 skips token creation whenever drovr@0.1.0 is published
      expect(stagesSection).toMatch(
        /if \[\[ "\$NPM_STATUS" == "published" \]\];\s*then[\s\S]*Skipping bootstrap token creation/,
      )
      expect(stagesSection).toMatch(/Skipping Package Release trigger stage/)
    })

    it('uses correct glossary terms (Package Release / GitHub Release, never bare Release)', () => {
      const content = readFileSync(scriptPath, 'utf8')
      const stagesSection = content.split('# STAGES')[1] || ''

      expect(stagesSection).not.toContain('Continue to release verification')
      expect(stagesSection).toContain('Continue to Package Release verification')
      expect(stagesSection).toContain('Skipping Package Release trigger stage')
    })
  })
})
