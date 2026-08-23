import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'

export interface TarballVerificationOptions {
  cwd?: string
  tarball?: string
  skipBuild?: boolean
  keepTemp?: boolean
}

export interface TarballContentReport {
  files: string[]
  manifest: Record<string, unknown>
  requiredFiles: string[]
  missingFiles: string[]
  unexpectedFiles: string[]
}

export interface TarballVerificationResult {
  valid: boolean
  tarballPath: string
  files: string[]
  error?: string
}

function normalizeTarPath(rawPath: string): string {
  let p = rawPath.trim()
  if (p.startsWith('./')) {
    p = p.slice(2)
  }
  if (p.startsWith('package/')) {
    p = p.slice('package/'.length)
  }
  if (p.startsWith('./')) {
    p = p.slice(2)
  }
  return normalize(p)
}

const FORBIDDEN_EXACT_FILES: Record<string, true> = {
  'tsconfig.json': true,
  'tsconfig.tests.json': true,
  'tsdown.config.ts': true,
  'tsdown.config.js': true,
  'tsdown.config.mjs': true,
  '.oxlintrc.json': true,
  '.oxfmtrc.json': true,
  'pnpm-lock.yaml': true,
  'skills-lock.json': true,
  'AGENTS.md': true,
  'CONTEXT.md': true,
}

const FORBIDDEN_DIR_PREFIXES = [
  'src/',
  'tests/',
  'test/',
  'fixtures/',
  '.github/',
  '.agents/',
  '.omp/',
  '.husky/',
  '.zed/',
  'docs/',
]

function isUnexpectedFile(filePath: string): boolean {
  const norm = normalizeTarPath(filePath)
  if (FORBIDDEN_EXACT_FILES[norm]) {
    return true
  }

  for (const prefix of FORBIDDEN_DIR_PREFIXES) {
    if (norm.startsWith(prefix) || norm === prefix.replace(/\/$/, '')) {
      return true
    }
  }

  // Raw typescript source files (excluding declaration files)
  if (/\.tsx?$/i.test(norm) && !/\.d\.(?:ts|mts|cts)$/i.test(norm)) {
    return true
  }

  // Test files
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(norm)) {
    return true
  }

  return false
}

export function listTarballFiles(tarballPath: string): string[] {
  const rawList = execFileSync('tar', ['-tf', tarballPath], {
    encoding: 'utf8',
  })

  return rawList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith('/'))
    .map(normalizeTarPath)
}

export function inspectTarballContent(tarballPath: string): TarballContentReport {
  const files = listTarballFiles(tarballPath)

  let manifestRaw = ''
  try {
    manifestRaw = execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`tarball is missing valid package.json manifest: ${msg}`)
  }

  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(manifestRaw) as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to parse package.json from tarball: ${msg}`)
  }

  const requiredFilesMap: Record<string, true> = { 'package.json': true }

  // Add bin targets
  if (manifest.bin) {
    if (typeof manifest.bin === 'string') {
      requiredFilesMap[normalizeTarPath(manifest.bin)] = true
    } else if (typeof manifest.bin === 'object' && manifest.bin !== null) {
      for (const target of Object.values(manifest.bin as Record<string, unknown>)) {
        if (typeof target === 'string') {
          requiredFilesMap[normalizeTarPath(target)] = true
        }
      }
    }
  }

  // Add exports targets
  if (manifest.exports) {
    const collectExports = (val: unknown) => {
      if (typeof val === 'string') {
        requiredFilesMap[normalizeTarPath(val)] = true
      } else if (typeof val === 'object' && val !== null) {
        for (const subVal of Object.values(val as Record<string, unknown>)) {
          collectExports(subVal)
        }
      }
    }
    collectExports(manifest.exports)
  }

  // Add main / types if present
  if (typeof manifest.main === 'string') {
    requiredFilesMap[normalizeTarPath(manifest.main)] = true
  }
  if (typeof manifest.types === 'string') {
    requiredFilesMap[normalizeTarPath(manifest.types)] = true
  }

  const requiredFiles = Object.keys(requiredFilesMap)
  const filesMap: Record<string, true> = {}
  for (const f of files) {
    filesMap[f] = true
  }

  const missingFiles = requiredFiles.filter((req) => !filesMap[req])
  const unexpectedFiles = files.filter((f) => isUnexpectedFile(f))

  return {
    files,
    manifest,
    requiredFiles,
    missingFiles,
    unexpectedFiles,
  }
}

export async function verifyPackageTarball(
  options: TarballVerificationOptions = {},
): Promise<TarballVerificationResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const trackedTempDirs: string[] = []

  try {
    let tarballPath = options.tarball ? resolve(cwd, options.tarball) : ''

    if (!tarballPath) {
      // Build and pack into a clean temporary directory
      const packTempDir = await mkdtemp(join(tmpdir(), 'drovr-pack-'))
      trackedTempDirs.push(packTempDir)

      if (!options.skipBuild) {
        try {
          execFileSync('pnpm', ['run', 'build'], {
            cwd,
            encoding: 'utf8',
            stdio: 'pipe',
          })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          return {
            valid: false,
            tarballPath: '',
            files: [],
            error: `failed to build package before packing: ${errMsg}`,
          }
        }
      }

      try {
        execFileSync('npm', ['pack', '--pack-destination', packTempDir], {
          cwd,
          encoding: 'utf8',
          stdio: 'pipe',
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return {
          valid: false,
          tarballPath: '',
          files: [],
          error: `failed to pack npm tarball: ${errMsg}`,
        }
      }

      const createdFiles = readdirSync(packTempDir)
      const tgzName = createdFiles.find((f) => f.endsWith('.tgz'))
      if (!tgzName) {
        return {
          valid: false,
          tarballPath: '',
          files: [],
          error: 'npm pack completed without producing a .tgz file',
        }
      }
      tarballPath = join(packTempDir, tgzName)
    } else {
      if (!existsSync(tarballPath)) {
        return {
          valid: false,
          tarballPath,
          files: [],
          error: `tarball file not found: ${tarballPath}`,
        }
      }
    }

    // Step 2: Content inspection
    let report: TarballContentReport
    try {
      report = inspectTarballContent(tarballPath)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        valid: false,
        tarballPath,
        files: [],
        error: errMsg,
      }
    }

    if (report.missingFiles.length > 0) {
      return {
        valid: false,
        tarballPath,
        files: report.files,
        error: `tarball is missing required runtime entry point or declarations: ${report.missingFiles.join(', ')}`,
      }
    }

    if (report.unexpectedFiles.length > 0) {
      return {
        valid: false,
        tarballPath,
        files: report.files,
        error: `tarball contains unexpected files: ${report.unexpectedFiles.join(', ')}`,
      }
    }

    // Step 3: Consumer installation
    const consumerTempDir = await mkdtemp(join(tmpdir(), 'drovr-consumer-'))
    trackedTempDirs.push(consumerTempDir)

    await writeFile(
      join(consumerTempDir, 'package.json'),
      JSON.stringify(
        {
          name: 'drovr-tarball-consumer-smoke',
          private: true,
          type: 'module',
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      execFileSync(
        'npm',
        ['install', '--no-package-lock', '--no-audit', '--no-fund', tarballPath],
        {
          cwd: consumerTempDir,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      )
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        valid: false,
        tarballPath,
        files: report.files,
        error: `failed to install tarball into isolated consumer project: ${errMsg}`,
      }
    }

    // Step 4: Process smoke-testing
    const binName =
      typeof report.manifest.bin === 'object' && report.manifest.bin !== null
        ? (Object.keys(report.manifest.bin)[0] ?? 'drovr')
        : 'drovr'

    const binPath = join(consumerTempDir, 'node_modules', '.bin', binName)
    if (!existsSync(binPath)) {
      return {
        valid: false,
        tarballPath,
        files: report.files,
        error: `installed CLI bin target "${binName}" not found at ${binPath}`,
      }
    }

    // Test 1: invoke with no arguments to observe CLI startup and diagnostic
    const noArgsRes = spawnSync(binPath, [], {
      cwd: consumerTempDir,
      encoding: 'utf8',
    })

    const noArgsErr = noArgsRes.stderr ?? ''
    const noArgsOut = noArgsRes.stdout ?? ''

    // If it threw an error starting the process (e.g. ENOENT, syntax error, fatal exception)
    if (noArgsRes.error) {
      return {
        valid: false,
        tarballPath,
        files: report.files,
        error: `CLI execution failed on process start: ${noArgsRes.error.message}`,
      }
    }

    // Drovr with no args exits with code 1 and "error: unknown command (none)"
    if (
      noArgsRes.status !== 1 ||
      (!noArgsErr.includes('error: unknown command') &&
        !noArgsOut.includes('error: unknown command'))
    ) {
      // Check if it failed with a runtime crash or something unexpected
      if (noArgsRes.status !== 0) {
        return {
          valid: false,
          tarballPath,
          files: report.files,
          error: `CLI execution failed with exit code ${noArgsRes.status}: ${(noArgsErr || noArgsOut).trim()}`,
        }
      }
    }

    // Test 2: invoke package-release validate to verify working CLI subcommand execution
    const validRes = spawnSync(binPath, ['package-release', 'validate', 'feat: smoke test'], {
      cwd: consumerTempDir,
      encoding: 'utf8',
    })

    if (validRes.error) {
      return {
        valid: false,
        tarballPath,
        files: report.files,
        error: `CLI execution failed on subcommand invocation: ${validRes.error.message}`,
      }
    }

    if (validRes.status !== 0) {
      return {
        valid: false,
        tarballPath,
        files: report.files,
        error: `CLI execution failed on subcommand invocation (code ${validRes.status}): ${(validRes.stderr || validRes.stdout).trim()}`,
      }
    }

    return {
      valid: true,
      tarballPath,
      files: report.files,
    }
  } finally {
    if (!options.keepTemp) {
      for (const dir of trackedTempDirs) {
        try {
          await rm(dir, { recursive: true, force: true })
        } catch {}
      }
    }
  }
}
