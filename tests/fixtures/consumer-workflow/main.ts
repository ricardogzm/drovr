import type { Drovr, Issue, Name, Resource, Worker, Worktree } from 'drovr'

export default async function workflow(drovr: Drovr): Promise<void> {
  const name: Name = 'item-a'
  const issues: readonly Issue[] = await drovr.issues.list()
  const worktree: Worktree = await drovr.worktree({ name })
  const worker: Worker = await drovr.start({ name, cwd: worktree.path })
  const resource: Resource = await drovr.resource('supabase', { capacity: 1 })

  await drovr.map(
    issues,
    { concurrency: 2, name: (issue) => `issue-${issue.number}` },
    async (issue) => {
      await drovr.issues.claim(issue, { name })
      await resource.lease({ name }, async () => {
        await worker.prompt('first')
        await worker.prompt('second')
      })
      await drovr.issues.close(issue)
      await drovr.issues.release(issue)
    },
  )
}
