import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const drovr = join(root, 'dist/cli.mjs')

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

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('npm tarball verification', () => {
  describe('drovr package-release verify-pack CLI', () => {
    it('verifies the real drovr package tarball end-to-end', async () => {
      const result = runDrovr(root, ['package-release', 'verify-pack'])
      expect(result.status, `Expected verify-pack to succeed. Stderr: ${result.stderr}`).toBe(0)
      expect(result.stdout).toMatch(/verified npm tarball/i)
      expect(result.stderr).toBe('')
    })

    it('supports aliases pack-verify, verify-tarball, and verify', async () => {
      const res1 = runDrovr(root, ['package-release', 'pack-verify', '--skip-build'])
      expect(res1.status, `Stderr: ${res1.stderr}`).toBe(0)

      const res2 = runDrovr(root, ['package-release', 'verify-tarball', '--skip-build'])
      expect(res2.status, `Stderr: ${res2.stderr}`).toBe(0)

      const res3 = runDrovr(root, ['package-release', 'verify', '--skip-build'])
      expect(res3.status, `Stderr: ${res3.stderr}`).toBe(0)
    })

    it('supports --json output flag', async () => {
      const result = runDrovr(root, ['package-release', 'verify-pack', '--skip-build', '--json'])
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout) as {
        valid: boolean
        tarballPath: string
        files: string[]
      }
      expect(parsed.valid).toBe(true)
      expect(Array.isArray(parsed.files)).toBe(true)
      expect(parsed.files).toContain('package.json')
      expect(parsed.files).toContain('dist/cli.mjs')
      expect(parsed.files).toContain('dist/index.mjs')
      expect(parsed.files).toContain('dist/index.d.mts')
    })

    it('verifies an explicitly provided valid tarball path', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-custom-tar-'))
      try {
        execFileSync('npm', ['pack', '--pack-destination', tempDir], {
          cwd: root,
          encoding: 'utf8',
        })
        const tarballPath = join(tempDir, 'drovr-0.0.0.tgz')
        expect(existsSync(tarballPath)).toBe(true)

        const result = runDrovr(root, ['package-release', 'verify-pack', '--tarball', tarballPath])
        expect(result.status, `Stderr: ${result.stderr}`).toBe(0)
        expect(result.stdout).toMatch(/verified npm tarball/i)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('fails with actionable diagnostic when tarball does not exist', async () => {
      const result = runDrovr(root, [
        'package-release',
        'verify-pack',
        '--tarball',
        '/nonexistent/path/drovr-99.99.99.tgz',
      ])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/error: tarball file not found/i)
    })

    it('fails with actionable diagnostic on unexpected arguments', async () => {
      const result = runDrovr(root, ['package-release', 'verify-pack', '--unknown-flag'])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/error: unexpected argument for verify-pack: --unknown-flag/i)
    })
  })

  describe('contract inspection and failure modes', () => {
    it('fails when tarball is missing required runtime entry point or declarations', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-bad-tar-'))
      try {
        const pkgDir = join(tempDir, 'pkg')
        await mkdir(pkgDir, { recursive: true })
        await mkdir(join(pkgDir, 'dist'), { recursive: true })
        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify(
            {
              name: 'fake-drovr',
              version: '0.0.1',
              bin: { drovr: './dist/cli.mjs' },
              exports: {
                '.': {
                  types: './dist/index.d.mts',
                  default: './dist/index.mjs',
                },
              },
            },
            null,
            2,
          ),
          'utf8',
        )
        await writeFile(
          join(pkgDir, 'dist/cli.mjs'),
          '#!/usr/bin/env node\nconsole.log("cli");\n',
          'utf8',
        )
        // Deliberately omit dist/index.mjs and dist/index.d.mts

        execFileSync('npm', ['pack', '--pack-destination', tempDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        })
        const tarballPath = join(tempDir, 'fake-drovr-0.0.1.tgz')

        const result = runDrovr(root, ['package-release', 'verify-pack', '--tarball', tarballPath])
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/missing required/i)
        expect(result.stderr).toMatch(/dist\/index\.mjs/)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('fails when tarball is missing required bin target', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-nobin-tar-'))
      try {
        const pkgDir = join(tempDir, 'pkg')
        await mkdir(pkgDir, { recursive: true })
        await mkdir(join(pkgDir, 'dist'), { recursive: true })
        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify(
            {
              name: 'nobin-drovr',
              version: '0.0.1',
              bin: { drovr: './dist/cli.mjs' },
              exports: {
                '.': {
                  types: './dist/index.d.mts',
                  default: './dist/index.mjs',
                },
              },
            },
            null,
            2,
          ),
          'utf8',
        )
        await writeFile(join(pkgDir, 'dist/index.mjs'), 'export {};\n', 'utf8')
        await writeFile(join(pkgDir, 'dist/index.d.mts'), 'export {};\n', 'utf8')
        // Deliberately omit dist/cli.mjs

        execFileSync('npm', ['pack', '--pack-destination', tempDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        })
        const tarballPath = join(tempDir, 'nobin-drovr-0.0.1.tgz')

        const result = runDrovr(root, ['package-release', 'verify-pack', '--tarball', tarballPath])
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/missing required.*dist\/cli\.mjs/i)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('fails when tarball contains unexpected source files or repository automation', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-leaky-tar-'))
      try {
        const pkgDir = join(tempDir, 'pkg')
        await mkdir(pkgDir, { recursive: true })
        await mkdir(join(pkgDir, 'dist'), { recursive: true })
        await mkdir(join(pkgDir, 'src'), { recursive: true })
        await mkdir(join(pkgDir, '.github'), { recursive: true })

        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify(
            {
              name: 'leaky-drovr',
              version: '0.0.1',
              files: ['dist', 'src', '.github'],
              bin: { drovr: './dist/cli.mjs' },
              exports: {
                '.': {
                  types: './dist/index.d.mts',
                  default: './dist/index.mjs',
                },
              },
            },
            null,
            2,
          ),
          'utf8',
        )
        await writeFile(
          join(pkgDir, 'dist/cli.mjs'),
          '#!/usr/bin/env node\nconsole.log("cli");\n',
          'utf8',
        )
        await writeFile(join(pkgDir, 'dist/index.mjs'), 'export {};\n', 'utf8')
        await writeFile(join(pkgDir, 'dist/index.d.mts'), 'export {};\n', 'utf8')
        await writeFile(join(pkgDir, 'src/secret.ts'), 'export const secret = 1;\n', 'utf8')
        await writeFile(join(pkgDir, '.github/workflow.yml'), 'name: CI\n', 'utf8')

        execFileSync('npm', ['pack', '--pack-destination', tempDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        })
        const tarballPath = join(tempDir, 'leaky-drovr-0.0.1.tgz')

        const result = runDrovr(root, ['package-release', 'verify-pack', '--tarball', tarballPath])
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/unexpected file/i)
        expect(result.stderr).toMatch(/src\/secret\.ts|\.github/)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('fails when tarball contains tests or repository configuration files', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-config-leak-'))
      try {
        const pkgDir = join(tempDir, 'pkg')
        await mkdir(pkgDir, { recursive: true })
        await mkdir(join(pkgDir, 'dist'), { recursive: true })
        await mkdir(join(pkgDir, 'tests'), { recursive: true })

        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify(
            {
              name: 'config-leak-drovr',
              version: '0.0.1',
              files: ['dist', 'tests', 'tsconfig.json'],
              bin: { drovr: './dist/cli.mjs' },
              exports: {
                '.': {
                  types: './dist/index.d.mts',
                  default: './dist/index.mjs',
                },
              },
            },
            null,
            2,
          ),
          'utf8',
        )
        await writeFile(
          join(pkgDir, 'dist/cli.mjs'),
          '#!/usr/bin/env node\nconsole.log("cli");\n',
          'utf8',
        )
        await writeFile(join(pkgDir, 'dist/index.mjs'), 'export {};\n', 'utf8')
        await writeFile(join(pkgDir, 'dist/index.d.mts'), 'export {};\n', 'utf8')
        await writeFile(join(pkgDir, 'tests/sample.test.ts'), 'test("x", () => {});\n', 'utf8')
        await writeFile(join(pkgDir, 'tsconfig.json'), '{}\n', 'utf8')

        execFileSync('npm', ['pack', '--pack-destination', tempDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        })
        const tarballPath = join(tempDir, 'config-leak-drovr-0.0.1.tgz')

        const result = runDrovr(root, ['package-release', 'verify-pack', '--tarball', tarballPath])
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/unexpected file/i)
        expect(result.stderr).toMatch(/tsconfig\.json|tests\/sample\.test\.ts/)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('fails when the packaged CLI crashes upon process invocation', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-crashing-tar-'))
      try {
        const pkgDir = join(tempDir, 'pkg')
        await mkdir(pkgDir, { recursive: true })
        await mkdir(join(pkgDir, 'dist'), { recursive: true })
        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify(
            {
              name: 'crashing-drovr',
              version: '0.0.1',
              files: ['dist'],
              bin: { drovr: './dist/cli.mjs' },
              exports: {
                '.': {
                  types: './dist/index.d.mts',
                  default: './dist/index.mjs',
                },
              },
            },
            null,
            2,
          ),
          'utf8',
        )
        await writeFile(
          join(pkgDir, 'dist/cli.mjs'),
          '#!/usr/bin/env node\nthrow new Error("FATAL_STARTUP_CRASH");\n',
          'utf8',
        )
        await writeFile(join(pkgDir, 'dist/index.mjs'), 'export {};\n', 'utf8')
        await writeFile(join(pkgDir, 'dist/index.d.mts'), 'export {};\n', 'utf8')

        execFileSync('npm', ['pack', '--pack-destination', tempDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        })
        const tarballPath = join(tempDir, 'crashing-drovr-0.0.1.tgz')

        const result = runDrovr(root, ['package-release', 'verify-pack', '--tarball', tarballPath])
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/CLI execution failed|FATAL_STARTUP_CRASH/i)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
    it('fails with actionable diagnostic when consumer npm install fails', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-install-fail-tar-'))
      try {
        const pkgDir = join(tempDir, 'pkg')
        await mkdir(pkgDir, { recursive: true })
        await mkdir(join(pkgDir, 'dist'), { recursive: true })
        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify(
            {
              name: 'install-fail-drovr',
              version: '0.0.1',
              files: ['dist'],
              bin: { drovr: './dist/cli.mjs' },
              scripts: {
                preinstall: 'node -e "process.exit(1)"',
              },
              exports: {
                '.': {
                  types: './dist/index.d.mts',
                  default: './dist/index.mjs',
                },
              },
            },
            null,
            2,
          ),
          'utf8',
        )
        await writeFile(
          join(pkgDir, 'dist/cli.mjs'),
          '#!/usr/bin/env node\nconsole.log("cli");\n',
          'utf8',
        )
        await writeFile(join(pkgDir, 'dist/index.mjs'), 'export {};\n', 'utf8')
        await writeFile(join(pkgDir, 'dist/index.d.mts'), 'export {};\n', 'utf8')

        execFileSync('npm', ['pack', '--pack-destination', tempDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        })
        const tarballPath = join(tempDir, 'install-fail-drovr-0.0.1.tgz')

        const result = runDrovr(root, ['package-release', 'verify-pack', '--tarball', tarballPath])
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/failed to install tarball/i)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('temporary resource cleanup', () => {
    it('cleans up temporary pack and consumer directories on success and failure', async () => {
      const initialTempFiles = new Set(readdirSync(tmpdir()))

      // 1. Success case: creates pack & consumer temp directories and cleans them up
      const resultSuccess = runDrovr(root, ['package-release', 'verify-pack', '--skip-build'])
      expect(resultSuccess.status).toBe(0)

      const afterSuccessTempFiles = readdirSync(tmpdir())
      const leftoverSuccess = afterSuccessTempFiles.filter(
        (f) =>
          !initialTempFiles.has(f) &&
          (f.startsWith('drovr-pack-') || f.startsWith('drovr-consumer-')),
      )
      expect(leftoverSuccess).toEqual([])

      // 2. Failure case that actually creates consumer temp directory before failing
      const tempDir = await mkdtemp(join(tmpdir(), 'drovr-cleanup-fail-'))
      try {
        const pkgDir = join(tempDir, 'pkg')
        await mkdir(pkgDir, { recursive: true })
        await mkdir(join(pkgDir, 'dist'), { recursive: true })
        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify(
            {
              name: 'cleanup-fail-drovr',
              version: '0.0.1',
              files: ['dist'],
              bin: { drovr: './dist/cli.mjs' },
              exports: {
                '.': {
                  types: './dist/index.d.mts',
                  default: './dist/index.mjs',
                },
              },
            },
            null,
            2,
          ),
          'utf8',
        )
        await writeFile(
          join(pkgDir, 'dist/cli.mjs'),
          '#!/usr/bin/env node\nthrow new Error("CRASH_ON_BOOT");\n',
          'utf8',
        )
        await writeFile(join(pkgDir, 'dist/index.mjs'), 'export {};\n', 'utf8')
        await writeFile(join(pkgDir, 'dist/index.d.mts'), 'export {};\n', 'utf8')

        execFileSync('npm', ['pack', '--pack-destination', tempDir], {
          cwd: pkgDir,
          encoding: 'utf8',
        })
        const tarballPath = join(tempDir, 'cleanup-fail-drovr-0.0.1.tgz')

        const snapshotBeforeFail = new Set(readdirSync(tmpdir()))
        const resultFail = runDrovr(root, [
          'package-release',
          'verify-pack',
          '--tarball',
          tarballPath,
        ])
        expect(resultFail.status).toBe(1)
        expect(resultFail.stderr).toMatch(/CLI execution failed|CRASH_ON_BOOT/i)

        const afterFailTempFiles = readdirSync(tmpdir())
        const leftoverFail = afterFailTempFiles.filter(
          (f) =>
            !snapshotBeforeFail.has(f) &&
            (f.startsWith('drovr-pack-') || f.startsWith('drovr-consumer-')),
        )
        expect(leftoverFail).toEqual([])
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })
})
