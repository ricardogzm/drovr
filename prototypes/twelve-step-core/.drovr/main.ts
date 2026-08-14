/**
 * PROTOTYPE — throwaway. Not the library, not a spec.
 *
 * Question: How should `.drovr/main.ts` look for the 12-step core?
 *
 * Locked inputs this file obeys:
 * - `map` with a concurrency limit is the spine; Worker is extra
 * - Resource is defined by name and capacity before it is leased
 * - Worktree: pass only Name; path / branch / cut are derived
 * - Worker control path: `start({ name, cwd })` then `worker.prompt(text)`
 * - `--resume` re-runs this file from the top; start / worktree / lease / claim reconnect by Name
 * - A map item leases a Resource only when it needs one; omit the lease block otherwise
 */

// --- proposed library surface (what `drovr` would export) ---

export type Name = string
export type Issue = {
  number: number
  title: string
  url: string
  repo: string
}
export type Worktree = { name: Name; path: string }
export type Worker = { prompt(text: string): Promise<void> }
export type Resource = {
  lease(opts: { name: Name }, fn: () => Promise<void>): Promise<void>
}

export type Drovr = {
  resource(name: string, spec: { capacity: number }): Promise<Resource>
  map<T>(items: T[], opts: { concurrency: number }, fn: (item: T) => Promise<void>): Promise<void>
  worktree(opts: { name: Name }): Promise<Worktree>
  start(opts: { name: Name; cwd: string }): Promise<Worker>
  issues: {
    list(opts?: { repo?: string }): Promise<Issue[]>
    claim(issue: Issue, opts: { name: Name }): Promise<void>
  }
}

// --- what a project actually puts in `.drovr/main.ts` ---

export default async function (drovr: Drovr) {
  const supabase = await drovr.resource('supabase', { capacity: 1 })

  const issues = await drovr.issues.list()

  await drovr.map(issues, { concurrency: 2 }, async (issue) => {
    const name = `issue-${issue.number}`

    await drovr.issues.claim(issue, { name })

    const worktree = await drovr.worktree({ name })

    const worker = await drovr.start({ name, cwd: worktree.path })

    // Lease only when this item needs the scarce environment. Omit the block otherwise.
    await supabase.lease({ name }, async () => {
      await worker.prompt(`Worktree is ${worktree.path}. Implement ${issue.url} (${issue.title}).`)
      await worker.prompt('If the change is complete, commit on this branch. Do not push.')
    })
  })
}
