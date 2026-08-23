import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd()
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drovr-package-release-'))
  runGit(dir, ['init', '-b', 'main'])
  runGit(dir, ['config', 'user.email', 'test@example.com'])
  runGit(dir, ['config', 'user.name', 'Test User'])
  await writeFile(join(dir, 'README.md'), '# test\n', 'utf8')
  runGit(dir, ['add', 'README.md'])
  runGit(dir, ['commit', '-m', 'chore: init'])
  return dir
}

beforeAll(() => {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
})

describe('drovr package-release validate', () => {
  it('accepts valid conventional commit messages with and without scopes', async () => {
    const repo = await initRepo()
    try {
      const validMessages = [
        'feat: add new feature',
        'feat(workflow): add workflow support',
        'fix: resolve issue #12',
        'fix(core): correct null check',
        'perf: speed up startup',
        'perf(db): optimize query',
        'refactor: simplify parser',
        'refactor(git): extract helper',
        'remove: drop deprecated flag',
        'remove(cli): remove unused option',
        'docs: update guide',
        'docs(readme): fix typo',
        'test: add tests',
        'test(worker): add worker tests',
        'build: update tsdown config',
        'ci: add release workflow',
        'chore: tidy up',
        'chore(deps): update vitest',
      ]

      for (const msg of validMessages) {
        const result = runDrovr(repo, ['package-release', 'validate', msg])
        expect(result.status, `Expected "${msg}" to be valid. Stderr: ${result.stderr}`).toBe(0)
        expect(result.stderr).toBe('')
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('accepts valid breaking change markers in subject and footers', async () => {
    const repo = await initRepo()
    try {
      const breakingMessages = [
        'feat!: change public api',
        'feat(cli)!: change flag syntax',
        'fix!: breaking fix',
        'fix(db)!: change schema format',
        'remove!: drop public method',
        'remove(api)!: remove endpoint',
        'feat: new feature\n\nBREAKING CHANGE: changes public API contract',
        'fix(core): fix issue\n\nBREAKING-CHANGE: removes old config option',
      ]

      for (const msg of breakingMessages) {
        const result = runDrovr(repo, ['package-release', 'validate', msg])
        expect(result.status, `Expected "${msg}" to be valid. Stderr: ${result.stderr}`).toBe(0)
        expect(result.stderr).toBe('')
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('accepts valid commit message from file via --file', async () => {
    const repo = await initRepo()
    try {
      const filePath = join(repo, 'COMMIT_MSG')
      await writeFile(
        filePath,
        'feat(parser): add commit validator\n\nDetailed description.',
        'utf8',
      )

      const result = runDrovr(repo, ['package-release', 'validate', '--file', filePath])
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('accepts GitHub-generated merge boilerplate', async () => {
    const repo = await initRepo()
    try {
      const mergeMessages = [
        'Merge pull request #123 from user/feature-branch',
        "Merge branch 'main' into feature-branch",
        "Merge branch 'main' of https://github.com/ricardogzm/drovr into main",
        "Merge remote-tracking branch 'origin/main'",
        "Merge remote-tracking branch 'origin/main' into main",
      ]

      for (const msg of mergeMessages) {
        const result = runDrovr(repo, ['package-release', 'validate', msg])
        expect(result.status, `Expected merge boilerplate "${msg}" to be valid`).toBe(0)
        expect(result.stderr).toBe('')
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails non-boilerplate merge titles like "Merge the two parsers" with actionable diagnostic', async () => {
    const repo = await initRepo()
    try {
      const resultNoColon = runDrovr(repo, ['package-release', 'validate', 'Merge the two parsers'])
      expect(resultNoColon.status).toBe(1)
      expect(resultNoColon.stderr).toMatch(/error: commit message header must match/i)

      const resultWithColon = runDrovr(repo, [
        'package-release',
        'validate',
        'Merge: the two parsers',
      ])
      expect(resultWithColon.status).toBe(1)
      expect(resultWithColon.stderr).toMatch(/error: unknown commit type "Merge"/i)
      expect(resultWithColon.stderr).toMatch(
        /Expected one of: feat, fix, perf, refactor, remove, docs, test, build, ci, chore/i,
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('fails with actionable diagnostic for malformed commit messages and titles', async () => {
    const repo = await initRepo()
    try {
      // Empty
      const emptyResult = runDrovr(repo, ['package-release', 'validate', ''])
      expect(emptyResult.status).toBe(1)
      expect(emptyResult.stderr).toMatch(/error:.*empty/i)

      // Unknown type
      const unknownResult = runDrovr(repo, ['package-release', 'validate', 'unknown: some feature'])
      expect(unknownResult.status).toBe(1)
      expect(unknownResult.stderr).toMatch(/error: unknown commit type "unknown"/i)
      expect(unknownResult.stderr).toMatch(
        /feat, fix, perf, refactor, remove, docs, test, build, ci, chore/i,
      )

      // Missing colon / invalid header format
      const missingColonResult = runDrovr(repo, ['package-release', 'validate', 'feat add feature'])
      expect(missingColonResult.status).toBe(1)
      expect(missingColonResult.stderr).toMatch(/error: commit message header must match/i)

      // Empty subject
      const emptySubjectResult = runDrovr(repo, ['package-release', 'validate', 'feat:   '])
      expect(emptySubjectResult.status).toBe(1)
      expect(emptySubjectResult.stderr).toMatch(/error: commit subject cannot be empty/i)

      // Malformed scope
      const malformedScopeResult = runDrovr(repo, [
        'package-release',
        'validate',
        'feat(: something',
      ])
      expect(malformedScopeResult.status).toBe(1)
      expect(malformedScopeResult.stderr).toMatch(/error: malformed scope/i)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('drovr package-release classify', () => {
  it('classifies feat as minor before 1.0', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: add new feature'])
      const result = runDrovr(repo, ['package-release', 'classify'])
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('minor')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('classifies breaking changes (bang or footer) as minor before 1.0', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix!: breaking fix'])
      const result1 = runDrovr(repo, ['package-release', 'classify'])
      expect(result1.status).toBe(0)
      expect(result1.stdout.trim()).toBe('minor')

      const repo2 = await initRepo()
      try {
        runGit(repo2, [
          'commit',
          '--allow-empty',
          '-m',
          'remove: drop old api\n\nBREAKING CHANGE: removed public method',
        ])
        const result2 = runDrovr(repo2, ['package-release', 'classify'])
        expect(result2.status).toBe(0)
        expect(result2.stdout.trim()).toBe('minor')
      } finally {
        await rm(repo2, { recursive: true, force: true })
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('classifies fix, perf, refactor, and nonbreaking remove as patch', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix: resolve bug'])
      const resFix = runDrovr(repo, ['package-release', 'classify'])
      expect(resFix.stdout.trim()).toBe('patch')

      runGit(repo, ['commit', '--allow-empty', '-m', 'perf(db): optimize query'])
      const resPerf = runDrovr(repo, ['package-release', 'classify'])
      expect(resPerf.stdout.trim()).toBe('patch')

      runGit(repo, ['commit', '--allow-empty', '-m', 'refactor: simplify code'])
      const resRefactor = runDrovr(repo, ['package-release', 'classify'])
      expect(resRefactor.stdout.trim()).toBe('patch')

      runGit(repo, ['commit', '--allow-empty', '-m', 'remove(cli): drop unused flag'])
      const resRemove = runDrovr(repo, ['package-release', 'classify'])
      expect(resRemove.stdout.trim()).toBe('patch')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('prefers minor over patch when both are present in history', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix: bug fix'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: new feature'])
      const result = runDrovr(repo, ['package-release', 'classify'])
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('minor')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('classifies hidden-only history and merge boilerplate as not releasable (none)', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'docs: update readme'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'test: add test'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'ci: configure actions'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'build: update config'])
      runGit(repo, ['commit', '--allow-empty', '-m', "Merge branch 'main' into dev"])

      const result = runDrovr(repo, ['package-release', 'classify'])
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('none')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('supports specifying git range via --from and --to', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['tag', 'v0.1.0'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix: bug fix after tag'])

      const result = runDrovr(repo, [
        'package-release',
        'classify',
        '--from',
        'v0.1.0',
        '--to',
        'HEAD',
      ])
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('patch')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('drovr package-release notes', () => {
  it('fails with actionable diagnostic if --tag is missing', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: add feature'])
      const result = runDrovr(repo, ['package-release', 'notes', '--repo', 'ricardogzm/drovr'])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/error: missing required --tag argument/i)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('renders categorized sections in exact order and omits empty categories', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: add first feature'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix(core): correct edge case'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'remove: remove deprecated API'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'perf(query): speed up load'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'refactor: restructure engine'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat!: breaking change in config'])

      const result = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.1.0',
        '--repo',
        'ricardogzm/drovr',
      ])
      expect(result.status).toBe(0)
      const output = result.stdout

      // Exact category headings in order
      const breakingIdx = output.indexOf('### Breaking Changes')
      const addedIdx = output.indexOf('### Added')
      const changedIdx = output.indexOf('### Changed')
      const fixedIdx = output.indexOf('### Fixed')
      const removedIdx = output.indexOf('### Removed')

      expect(breakingIdx).toBeGreaterThanOrEqual(0)
      expect(addedIdx).toBeGreaterThan(breakingIdx)
      expect(changedIdx).toBeGreaterThan(addedIdx)
      expect(fixedIdx).toBeGreaterThan(changedIdx)
      expect(removedIdx).toBeGreaterThan(fixedIdx)

      // Content verification
      expect(output).toContain('### Breaking Changes\n- breaking change in config')
      expect(output).toContain('### Added\n- add first feature')
      expect(output).toContain('### Changed\n- speed up load\n- restructure engine')
      expect(output).toContain('### Fixed\n- correct edge case')
      expect(output).toContain('### Removed\n- remove deprecated API')

      // Breaking change should NOT appear under Added
      const addedSection = output.slice(addedIdx, changedIdx)
      expect(addedSection).not.toContain('breaking change in config')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('omits empty category headings when no commits match that category', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: only a feature'])

      const result = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.1.0',
        '--repo',
        'ricardogzm/drovr',
      ])
      expect(result.status).toBe(0)
      const output = result.stdout

      expect(output).toContain('### Added\n- only a feature')
      expect(output).not.toContain('### Breaking Changes')
      expect(output).not.toContain('### Changed')
      expect(output).not.toContain('### Fixed')
      expect(output).not.toContain('### Removed')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('places breaking remove/fix/feat ONLY under Breaking Changes', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'remove!: drop old command'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix(api)!: alter return format'])

      const result = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.1.0',
        '--repo',
        'ricardogzm/drovr',
      ])
      expect(result.status).toBe(0)
      const output = result.stdout

      expect(output).toContain('### Breaking Changes\n- drop old command\n- alter return format')
      expect(output).not.toContain('### Removed')
      expect(output).not.toContain('### Fixed')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('excludes docs, test, build, ci, chore, and merge boilerplate from categorized notes', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'docs: update readme'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'test: add test'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'build: bump toolchain'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'ci: configure actions'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'chore: housekeeping'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'Merge pull request #99 from user/branch'])
      runGit(repo, ['commit', '--allow-empty', '-m', "Merge remote-tracking branch 'origin/main'"])
      runGit(repo, ['commit', '--allow-empty', '-m', 'fix: real fix'])

      const result = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.1.0',
        '--repo',
        'ricardogzm/drovr',
      ])
      expect(result.status).toBe(0)
      const output = result.stdout

      expect(output).toContain('### Fixed\n- real fix')
      expect(output).not.toContain('update readme')
      expect(output).not.toContain('add test')
      expect(output).not.toContain('bump toolchain')
      expect(output).not.toContain('configure actions')
      expect(output).not.toContain('housekeeping')
      expect(output).not.toContain('Merge pull request')
      expect(output).not.toContain('Merge remote-tracking branch')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('strips Conventional Commit type and scope prefix without rewriting canonical subject text', async () => {
    const repo = await initRepo()
    try {
      const subjects = [
        'feat(workflow): preserve `backticks` and UPPERCASE text and #123 issue',
        'fix(cli): keep "quotes" and punctuation intact!',
        'refactor: do not lowercase or uppercase first letter',
      ]
      for (const s of subjects) {
        runGit(repo, ['commit', '--allow-empty', '-m', s])
      }

      const result = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.1.0',
        '--repo',
        'ricardogzm/drovr',
      ])
      expect(result.status).toBe(0)
      const output = result.stdout

      expect(output).toContain('- preserve `backticks` and UPPERCASE text and #123 issue')
      expect(output).toContain('- keep "quotes" and punctuation intact!')
      expect(output).toContain('- do not lowercase or uppercase first letter')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('retains What’s Changed, removes New Contributors, and renders Full Changelog as final paragraph', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: add feature'])

      const fixtureGithubNotes = `## What's Changed
* feat: add feature by @ricardogzm in https://github.com/ricardogzm/drovr/pull/10
* fix: edge fix by @contributor in https://github.com/ricardogzm/drovr/pull/11

## New Contributors
* @contributor made their first contribution in https://github.com/ricardogzm/drovr/pull/11

**Full Changelog**: https://github.com/ricardogzm/drovr/compare/old...new`

      const result = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.1.0',
        '--repo',
        'ricardogzm/drovr',
        '--github-notes',
        fixtureGithubNotes,
      ])
      expect(result.status).toBe(0)
      const output = result.stdout

      // Retains What's Changed
      expect(output).toContain("## What's Changed")
      expect(output).toContain(
        '* feat: add feature by @ricardogzm in https://github.com/ricardogzm/drovr/pull/10',
      )
      expect(output).toContain(
        '* fix: edge fix by @contributor in https://github.com/ricardogzm/drovr/pull/11',
      )

      // Removes New Contributors block
      expect(output).not.toContain('New Contributors')
      expect(output).not.toContain('made their first contribution')

      // Full Changelog is final paragraph and appears exactly once
      const fullChangelogMatches = output.match(/\*\*Full Changelog\*\*:/g)
      expect(fullChangelogMatches?.length).toBe(1)
      expect(
        output
          .trimEnd()
          .endsWith('**Full Changelog**: https://github.com/ricardogzm/drovr/commits/v0.1.0'),
      ).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('renders commit history link for first release and compare link for subsequent releases with arbitrary tag names', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: initial release feature'])

      // First release: v0.5.0 without prev-tag
      const resFirst = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.5.0',
        '--repo',
        'ricardogzm/drovr',
      ])
      expect(resFirst.status).toBe(0)
      expect(resFirst.stdout).toContain(
        '**Full Changelog**: https://github.com/ricardogzm/drovr/commits/v0.5.0',
      )
      expect(resFirst.stdout).not.toContain('/compare/')

      // Subsequent release: v0.6.0 with prev-tag v0.5.0
      runGit(repo, ['tag', 'v0.5.0'])
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: second release feature'])

      const resSubsequent = runDrovr(repo, [
        'package-release',
        'notes',
        '--from',
        'v0.5.0',
        '--to',
        'HEAD',
        '--prev-tag',
        'v0.5.0',
        '--tag',
        'v0.6.0',
        '--repo',
        'ricardogzm/drovr',
      ])
      expect(resSubsequent.status).toBe(0)
      expect(resSubsequent.stdout).toContain(
        '**Full Changelog**: https://github.com/ricardogzm/drovr/compare/v0.5.0...v0.6.0',
      )
      expect(resSubsequent.stdout).not.toContain('/commits/v0.6.0')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('renders notes correctly when read from --github-notes-file and direct commits only', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, [
        'commit',
        '--allow-empty',
        '-m',
        'fix(api-v2): fix <script> &amp; entity encoding',
      ])
      runGit(repo, [
        'commit',
        '--allow-empty',
        '-m',
        'fix: bug fix\n\nBREAKING CHANGE: changes public signature',
      ])

      const fixturePath = join(repo, 'gh-notes.md')
      await writeFile(
        fixturePath,
        `## What's Changed\n* PR #1 by @dev in https://github.com/ricardogzm/drovr/pull/1\n\n## New Contributors\n* @dev made first contribution in #1\n\n**Full Changelog**: https://github.com/old/compare`,
        'utf8',
      )

      const result = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.1.0',
        '--repo',
        'ricardogzm/drovr',
        '--github-notes-file',
        fixturePath,
      ])
      expect(result.status).toBe(0)
      const output = result.stdout

      // Breaking change section contains breaking fix
      expect(output).toContain('### Breaking Changes\n- bug fix')
      expect(output).toContain('### Fixed\n- fix <script> &amp; entity encoding')
      expect(output).toContain("## What's Changed")
      expect(output).toContain('* PR #1 by @dev in https://github.com/ricardogzm/drovr/pull/1')
      expect(output).not.toContain('New Contributors')
      expect(
        output.endsWith('**Full Changelog**: https://github.com/ricardogzm/drovr/commits/v0.1.0\n'),
      ).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('renders release with no merged pull requests and direct commits only', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'feat: direct commit feature'])

      const result = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.1.0',
        '--repo',
        'ricardogzm/drovr',
      ])
      expect(result.status).toBe(0)
      const output = result.stdout

      expect(output).toBe(
        '### Added\n- direct commit feature\n\n**Full Changelog**: https://github.com/ricardogzm/drovr/commits/v0.1.0\n',
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('renders release with only pull requests (no categorized direct commits)', async () => {
    const repo = await initRepo()
    try {
      runGit(repo, ['commit', '--allow-empty', '-m', 'Merge pull request #1 from branch'])

      const fixtureNotes = `## What's Changed\n* feat: something by @author in https://github.com/ricardogzm/drovr/pull/1\n\n**Full Changelog**: https://github.com/ricardogzm/drovr/compare/old`

      const result = runDrovr(repo, [
        'package-release',
        'notes',
        '--tag',
        'v0.1.0',
        '--repo',
        'ricardogzm/drovr',
        '--github-notes',
        fixtureNotes,
      ])
      expect(result.status).toBe(0)
      const output = result.stdout

      expect(output).toBe(
        "## What's Changed\n* feat: something by @author in https://github.com/ricardogzm/drovr/pull/1\n\n**Full Changelog**: https://github.com/ricardogzm/drovr/commits/v0.1.0\n",
      )
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
