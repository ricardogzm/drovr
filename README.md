# Drovr

Drovr is a programmable orchestration runtime for OMP Workers running in visible Herdr panes.

A TypeScript Workflow tells Drovr which GitHub Issues to process and how to process them. Drovr handles Claims, bounded concurrency, isolated git Worktrees, persistent Workers, scarce Resources, crash recovery, and operator logs. It leaves coding, commits, reviews, pull requests, and merges to the Worker or the user.

Name is the continuity key. The same Name reconnects the same Claim, Worktree, Worker, Lease, and Completion after a restart.

## Requirements

- A git repository with a GitHub remote
- Node.js with native TypeScript type stripping. Development and tests currently run on Node.js 24.
- The [`gh`](https://cli.github.com/) CLI, authenticated for every repository the Workflow uses
- Herdr with OMP available as an agent kind

Run Drovr from a normal terminal, outside Herdr. Drovr creates and controls Herdr workspaces while its own process stays in the Start checkout.

## Install

Add the package to the repository that will own the Workflow:

```sh
pnpm add -D drovr
pnpm exec drovr setup
```

`drovr setup` creates `.drovr/main.ts`:

```ts
import type { Drovr } from 'drovr'

export default async function workflow(_drovr: Drovr): Promise<void> {}
```

Setup adds these entries:

```text
# .drovr/.gitignore
state.sqlite*
drovr.log

# <git-common-dir>/info/exclude
/.worktrees/
```

The first `drovr start` also ignores `.drovr/start.lock*`.

Setup refuses to overwrite an existing `.drovr/main.ts`. It checks for that file before changing ignore files. Setup is optional, but `drovr start` still requires a Workflow at `.drovr/main.ts`.

## A complete Workflow

This Workflow claims two eligible Issues, gives each one an isolated Worktree and visible Worker, runs both items concurrently, and serializes the section that uses a shared test environment.

```ts
import type { Drovr, Issue, Name } from 'drovr'

export default async function workflow(drovr: Drovr): Promise<void> {
  const issues = await drovr.issues.list()
  const testEnvironment = await drovr.resource('test-environment', {
    capacity: 1,
  })

  await drovr.map(
    issues.slice(0, 2),
    {
      concurrency: 2,
      name: issueName,
    },
    async (issue) => {
      const name = issueName(issue)

      await drovr.issues.claim(issue, { name })

      const worktree = await drovr.worktree({ name })
      const worker = await drovr.start({
        name,
        cwd: worktree.path,
      })

      await worker.prompt(`Read GitHub Issue #${issue.number} and implement it in this Worktree.`)

      await testEnvironment.lease({ name }, async () => {
        await worker.prompt('Run the focused tests for your change and fix any failures.')
      })

      await drovr.issues.close(issue)
    },
  )
}

function issueName(issue: Issue): Name {
  return `issue-${issue.number}`
}
```

Run it with:

```sh
pnpm exec drovr start --verbose
```

If Drovr exits before every item returns, resume it with:

```sh
pnpm exec drovr start --resume --verbose
```

Do not use a fresh `start` to recover interrupted work. Fresh mode rejects existing managed Worktree paths or branches rather than adopting them.

## CLI

| Command                          | What it does                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `drovr setup`                    | Creates a typed starter Workflow and merges the required ignore entries.                               |
| `drovr start`                    | Runs the current Workflow in fresh mode. It creates the Project database when needed.                  |
| `drovr start --verbose`          | Runs fresh mode and mirrors semantic events to stderr.                                                 |
| `drovr start --resume`           | Reruns the current Workflow and reconnects unfinished Names. It requires an existing Project database. |
| `drovr start --resume --verbose` | Resumes and mirrors semantic events to stderr.                                                         |

Every `start` invocation takes a nonblocking checkout lock at `.drovr/start.lock`. A second Drovr process in the same Start checkout fails before it opens the database or loads the Workflow.

Drovr resolves the git root from the current directory. It refuses to start from inside its own `.worktrees` directory.

## Workflow contract

A Workflow is the default exported async function in `.drovr/main.ts`:

```ts
import type { Drovr } from 'drovr'

export default async function workflow(drovr: Drovr): Promise<void> {
  // Author orchestration here.
}
```

The package root exports six types and no runtime library values:

- `Drovr`
- `Issue`
- `Worker`
- `Worktree`
- `Resource`
- `Name`

Use `import type` in the Workflow. The CLI owns the runtime and injects the `Drovr` handle.

### Names

`Name` is a string with this runtime grammar:

```text
[a-z][a-z0-9_-]{0,31}
```

Names are lowercase, start with a letter, and contain at most 32 characters. Drovr rejects invalid Names and never rewrites them. It validates every Name before the keyed operation begins.

### Mapping work

```ts
await drovr.map(
  items,
  {
    concurrency: 4,
    name: (item) => item.name,
  },
  async (item) => {
    // One item callback.
  },
)
```

`map` requires a positive integer concurrency value and a synchronous Name selector. It derives and validates every Name before it starts any callback. Duplicate Names reject the whole map before partial work begins.

Items run up to the requested concurrency. A failed item does not cancel active or pending siblings. Drovr waits for the map to settle, then makes the command fail if any item failed.

A returned callback records a Completion. A thrown callback does not. Resume removes completed Names before scheduling, so skipped items consume no concurrency.

### GitHub Issues and Claims

```ts
const issues = await drovr.issues.list()
const otherRepoIssues = await drovr.issues.list({ repo: 'owner/repo' })

await drovr.issues.claim(issue, { name })
await drovr.issues.close(issue)
// Or hand responsibility to the retained assignee:
await drovr.issues.release(issue)
```

Default listing uses the Start checkout repository. It returns open Issues that have the `ready-for-agent` label and are either unassigned or already Claimed in this Project database. Drovr uses the host `gh` CLI for listing and mutation.

Claiming first reserves the repository and Issue number in the Project database. It then assigns the authenticated GitHub user without removing `ready-for-agent`. The same Name reconnects its Claim. A different Name cannot steal it.

`close` requires a local Claim. It closes the GitHub Issue, retains its assignee and readiness label, then releases the Claim. `release` deletes only the local Claim. It does not close, unassign, relabel, or requeue the Issue.

An `Issue` is a readonly snapshot with these fields:

| Field       | Type                          |
| ----------- | ----------------------------- |
| `repo`      | `string` in `owner/repo` form |
| `number`    | `number`                      |
| `title`     | `string`                      |
| `body`      | `string`                      |
| `url`       | `string`                      |
| `state`     | `"OPEN"` or `"CLOSED"`        |
| `labels`    | `readonly string[]`           |
| `assignees` | `readonly string[]`           |
| `author`    | `string` or `null`            |
| `createdAt` | ISO 8601 string               |
| `updatedAt` | ISO 8601 string               |

Comments, reactions, milestones, project metadata, and raw `gh` output are not part of the Workflow interface.

### Worktrees

```ts
const worktree = await drovr.worktree({ name })

console.log(worktree.name)
console.log(worktree.path)
```

Drovr derives these values from Name:

```text
path:   <start-checkout>/.worktrees/<Name>
branch: drovr/<Name>
```

Fresh creation starts at the Start checkout HEAD. Uncommitted files are not copied. A dirty Start checkout produces a warning but does not block unrelated work.

Fresh mode fails if the path or branch already exists. Resume reconnects a matching Worktree in place, including dirty files. If the directory is missing but the managed branch survives, Drovr recreates the Worktree from that branch. It refuses foreign directories, wrong branches, and states where both the path and branch are missing.

Drovr does not delete failed Worktrees or branches.

### Worktree setup

Commit an optional `.drovr/worktrees.json` file when every new Worktree needs repository preparation:

```json
["pnpm install --frozen-lockfile", "pnpm run build"]
```

Drovr reads this file from each physically created Worktree. Commands run sequentially in that Worktree with the system shell. Each command receives `DROVR_START_CHECKOUT`, which contains the absolute Start checkout path.

Drovr streams command output. A nonzero exit, signal, invalid file, or interrupted run leaves setup pending and starts no Worker. Resume reruns the full command list from the first command. Write setup commands so running them again is safe.

### Workers

```ts
const worker = await drovr.start({
  name,
  cwd: worktree.path,
})

await worker.prompt('Implement the Issue.')
await worker.prompt('Run the focused tests.')
```

A new Worker gets one unfocused Herdr workspace rooted at the Worktree. Herdr starts one visible OMP process in its root pane. The pane remains after the Workflow exits.

A matching live Worker reconnects by Name only when its cwd matches the requested Worktree. Drovr waits for an in-flight turn to become idle or done before it returns the Worker handle.

Prompts are sequential. Each call waits without a timeout for idle or done. Drovr does not read or return the transcript. A blocked Worker stays visible for human interaction and does not count as successful. Overlapping prompts and stalled waits fail the map item.

### Capacity Resources

```ts
const gpu = await drovr.resource('gpu', { capacity: 1 })

const result = await gpu.lease({ name }, async () => {
  return runGpuWork()
})
```

A Resource name must be a nonempty string. Capacity must be a positive integer. A Lease occupies one slot for its Name, returns the callback value, and releases after the callback returns or throws.

A full Resource waits. It does not fail or spin in a tight loop. One Name occupies at most one slot in a Resource and may hold Leases in other Resources.

If Drovr crashes inside the callback, the Lease remains in the Project database. The same Name reconnects that Lease on resume.

### Port Resources

A Port Resource reserves a complete declared set. It does not choose a port for the callback.

```ts
const appPort = await drovr.resource('app-port', { ports: 4173 })

const browserPorts = await drovr.resource('browser-ports', {
  ports: [4173, 4174, 4175],
})

const testRange = await drovr.resource('test-range', {
  ports: { from: 5100, to: 5110 },
})

await browserPorts.lease({ name }, async () => {
  await runBrowserTests()
})
```

Port Resources have implicit capacity one. Declarations accept one port, a nonempty unique list, or an inclusive range. Every port must be an integer from 1 through 65535. Drovr rejects duplicates, empty lists, reversed ranges, mixed capacity and port specs, and out-of-range values.

Different Port Resources cannot hold overlapping declared sets at the same time. Disjoint sets may proceed concurrently. Changing a live Port Resource's declaration fails.

After acquisition, Drovr probes IPv4 and IPv6 loopback for each declared port. It logs `available`, `in-use`, or `unavailable` when the probe cannot determine either state. These probes are informational. They do not delay or reject the logical Lease, because operating-system availability can change immediately after a probe.

## Resume and failure behavior

Resume reruns the current `.drovr/main.ts` from the top against current GitHub data. Drovr does not restore a saved call stack or an old Workflow file.

As the Workflow reaches each keyed call, Drovr reconnects state by Name:

- Completed Names skip before map scheduling.
- Claims reconnect when the same Name claims the same Issue.
- Matching Worktrees reconnect with their current files intact.
- Live Workers reconnect only when their cwd matches.
- Existing Leases reconnect for the same Resource and Name.
- Pending Worktree setup reruns from command one.

An unfinished callback restarts from its beginning. This is at-least-once execution. Prompts and other side effects before the crash may run again. Workflow code and Worker instructions should tolerate replay.

Drovr leaves omitted Names alone. Changing the Workflow does not sweep their Claims, Leases, Worktrees, panes, or branches.

Recovery assumes Herdr and OMP survived. Recreating a missing Worker after OMP death is best effort. Drovr does not guarantee recovery after Herdr loss, machine reboot, or deletion of both a managed Worktree and its branch.

## State and logs

Drovr keeps project files under `.drovr`:

| Path                    | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `.drovr/main.ts`        | Current user-authored Workflow                                   |
| `.drovr/state.sqlite`   | Claims, Completions, Resources, Leases, and Worktree setup state |
| `.drovr/drovr.log`      | Append-only semantic event log                                   |
| `.drovr/start.lock`     | Checkout-level invocation lock                                   |
| `.drovr/worktrees.json` | Optional Worktree setup commands                                 |

The Project database uses schema version 1. Drovr does not keep a run journal, prompt history, Worker transcript, Workflow snapshot, or wait queue.

The log records these stable event names:

```text
start.begin
start.complete
start.fail
map.item.start
map.item.skip
map.item.complete
map.item.fail
resource.lease.request
resource.lease.wait
resource.lease.acquire
resource.ports.probe
```

Each line has an RFC 3339 UTC timestamp, an `INFO` or `ERROR` level, the event name, and the identifiers required for that event. Drovr never writes prompt bodies to its log.

Normal mode writes lifecycle events only to `.drovr/drovr.log`. `--verbose` also mirrors them to stderr. File output never contains ANSI color codes. If the log file cannot open or append, Drovr reports the problem on stderr and keeps running the Workflow.

## What Drovr does not do

Drovr V1 has narrow ownership. It does not:

- create commits, run reviews, open pull requests, or merge branches
- provide a Task type, checkpoints, retries, or exactly-once callbacks
- clean up failed Worktrees, branches, Claims, Leases, panes, or omitted Names
- allocate ports or enforce operating-system port availability
- coordinate Claims or Resources across separate Project databases
- expose status or stop commands
- guarantee recovery after OMP, Herdr, or machine loss

Visible Workers and retained state are deliberate. Operators can inspect a failed Worker in Herdr, repair its Worktree, then run `drovr start --resume`.

## Development

Install dependencies and run the repository checks:

```sh
pnpm install
pnpm run build
pnpm run check
pnpm run fmt:check
pnpm exec vitest run
```

The tests drive the packaged CLI in temporary git repositories. They replace `gh` and `herdr` with controlled executables, but treat git, files, child processes, and SQLite as real dependencies. Tests verify behavior through CLI output and external state rather than importing Drovr internals.

## License

MIT
