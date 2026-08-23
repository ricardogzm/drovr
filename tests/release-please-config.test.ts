import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const drovr = join(root, 'dist/cli.mjs')
const configFile = join(root, 'release-please-config.json')
const manifestFile = join(root, '.release-please-manifest.json')
const workflowFile = join(root, '.github/workflows/package-release.yml')
const packageJsonFile = join(root, 'package.json')
const pnpmLockFile = join(root, 'pnpm-lock.yaml')
const schemasDir = join(root, 'tests/fixtures/schemas')

function runDrovr(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [drovr, ...args], {
    cwd,
    encoding: 'utf8',
  })
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()
}

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drovr-rp-test-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  runGit(dir, ['add', 'README.md'])
  runGit(dir, ['commit', '-m', 'chore: initial commit'])
  return dir
}

const SAMPLE_RP_BODY = `:robot: I have created a release *beep* *boop*
---


## [0.1.0](https://github.com/ricardogzm/drovr/compare/v0.0.0...v0.1.0) (2026-08-22)

### Added
- placeholder

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#readme).
`

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('Issue #39: Maintain the reviewed Package Release PR', () => {
  describe('Sole version authority (bumpp removal)', () => {
    it('does not define bumpp in package.json scripts', () => {
      const pkg = JSON.parse(readFileSync(packageJsonFile, 'utf8')) as {
        scripts?: Record<string, string>
      }
      expect(pkg.scripts?.release).toBeUndefined()
      const scriptValues = Object.values(pkg.scripts ?? {})
      for (const script of scriptValues) {
        expect(script).not.toContain('bumpp')
      }
    })

    it('does not have bumpp in dependencies or devDependencies', () => {
      const pkg = JSON.parse(readFileSync(packageJsonFile, 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      expect(pkg.dependencies?.bumpp).toBeUndefined()
      expect(pkg.devDependencies?.bumpp).toBeUndefined()
    })

    it('does not retain bumpp in pnpm-lock.yaml', () => {
      const lockContent = readFileSync(pnpmLockFile, 'utf8')
      expect(lockContent).not.toMatch(/bumpp@/)
      expect(lockContent).not.toMatch(/specifier:\s*\^?12\./)
    })
  })

  describe('Published static validators', () => {
    const ajv = new Ajv({ allErrors: true, strict: false })

    it('validates release-please-config.json against the published Release Please schema', () => {
      const schemaPath = join(schemasDir, 'release-please-config.json')
      expect(existsSync(schemaPath)).toBe(true)
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
      const validate = ajv.compile(schema)

      const config = JSON.parse(readFileSync(configFile, 'utf8')) as object
      const valid = validate(config)
      expect(validate.errors ?? []).toEqual([])
      expect(valid).toBe(true)
    })

    it('validates .release-please-manifest.json against the published Release Please manifest schema', () => {
      const schemaPath = join(schemasDir, 'release-please-manifest.json')
      expect(existsSync(schemaPath)).toBe(true)
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
      const validate = ajv.compile(schema)

      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as object
      const valid = validate(manifest)
      expect(validate.errors ?? []).toEqual([])
      expect(valid).toBe(true)
    })

    it('validates .github/workflows/package-release.yml against the published GitHub Workflow schema', () => {
      const schemaPath = join(schemasDir, 'github-workflow.json')
      expect(existsSync(schemaPath)).toBe(true)
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
      const validate = ajv.compile(schema)

      const workflow = parseYaml(readFileSync(workflowFile, 'utf8')) as object
      const valid = validate(workflow)
      expect(validate.errors ?? []).toEqual([])
      expect(valid).toBe(true)
    })
  })

  describe('Package Release PR notes envelope and category contract', () => {
    it('preserves Release Please envelope and formats canonical notes in exact category order', () => {
      const repo = createRepo()
      try {
        runGit(repo, ['commit', '--allow-empty', '-m', 'feat!: redesign public api #39'])
        runGit(repo, ['commit', '--allow-empty', '-m', 'feat(core): add execution worker #39'])
        runGit(repo, ['commit', '--allow-empty', '-m', 'perf(git): speed up rev walk #39'])

        const result = runDrovr(repo, [
          'package-release',
          'reconcile-pr',
          '--title',
          'chore(main): release 0.1.0',
          '--body',
          SAMPLE_RP_BODY,
          '--repo',
          'ricardogzm/drovr',
          '--cwd',
          repo,
          '--json',
        ])

        expect(result.status).toBe(0)
        const parsed = JSON.parse(result.stdout) as {
          action: string
          version: string
          tag: string
          body: string
        }

        expect(parsed.action).toBe('update')
        expect(parsed.version).toBe('0.1.0')
        expect(parsed.tag).toBe('v0.1.0')

        // Preserves RP envelope delimiters
        expect(parsed.body).toContain(':robot: I have created a release *beep* *boop*')
        expect(parsed.body).toContain('---')
        expect(parsed.body).toContain(
          'This PR was generated with [Release Please](https://github.com/googleapis/release-please).',
        )

        // Contains release heading
        expect(parsed.body).toContain('## 0.1.0')

        // Ordered categories: Breaking Changes, Added, Changed
        const breakingIdx = parsed.body.indexOf('### Breaking Changes')
        const addedIdx = parsed.body.indexOf('### Added')
        const changedIdx = parsed.body.indexOf('### Changed')

        expect(breakingIdx).toBeGreaterThanOrEqual(0)
        expect(addedIdx).toBeGreaterThan(breakingIdx)
        expect(changedIdx).toBeGreaterThan(addedIdx)

        // Breaking change not duplicated under Added
        expect(parsed.body).toContain('### Breaking Changes\n- redesign public api #39')
        expect(parsed.body).toContain('### Added\n- add execution worker #39')
        expect(parsed.body).toContain('### Changed\n- speed up rev walk #39')
        const addedSection = parsed.body.slice(addedIdx, changedIdx)
        expect(addedSection).not.toContain('redesign public api #39')

        // Empty categories are omitted
        expect(parsed.body).not.toContain('### Fixed')
        expect(parsed.body).not.toContain('### Removed')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })

    it('does not leave a Package Release PR open when history contains only hidden changes', () => {
      const repo = createRepo()
      try {
        runGit(repo, ['commit', '--allow-empty', '-m', 'docs: update readme #39'])
        runGit(repo, ['commit', '--allow-empty', '-m', 'test: add coverage #39'])
        runGit(repo, ['commit', '--allow-empty', '-m', 'chore: update lockfile #39'])

        const result = runDrovr(repo, [
          'package-release',
          'reconcile-pr',
          '--title',
          'chore(main): release 0.1.0',
          '--body',
          SAMPLE_RP_BODY,
          '--repo',
          'ricardogzm/drovr',
          '--cwd',
          repo,
          '--json',
        ])

        expect(result.status).toBe(0)
        const parsed = JSON.parse(result.stdout) as {
          action: string
          reason?: string
        }

        expect(parsed.action).toBe('close')
        expect(parsed.reason).toMatch(/no user-facing changes/i)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })

    it('fails with nonzero status when release version cannot be extracted from PR title and body', () => {
      const repo = createRepo()
      try {
        runGit(repo, ['commit', '--allow-empty', '-m', 'feat: add feature #39'])

        const result = runDrovr(repo, [
          'package-release',
          'reconcile-pr',
          '--title',
          'invalid title without version',
          '--body',
          'invalid body without version',
          '--repo',
          'ricardogzm/drovr',
          '--cwd',
          repo,
          '--json',
        ])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/could not extract release version/i)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })
  })
})
