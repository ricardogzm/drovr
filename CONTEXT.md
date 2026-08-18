# Drovr

Programmable orchestration runtime for OMP agents running in Herdr.

## Language

**Drovr**:
The orchestration runtime this repository specifies. The package and CLI use this spelling.
_Avoid_: Drover, drover

**Workflow**:
The user-authored TypeScript program at `.drovr/main.ts` that Drovr loads and runs.
_Avoid_: pipeline, playbook, drovr.config.ts

**Worker**:
A persistent OMP session Drovr can prompt more than once, shown in a Herdr pane.
_Avoid_: agent execution, subagent (when meaning the live session)

**Name**:
The user-supplied slug that keys a Worker, Worktree, Claim, Resource lease, and Completion so a second pass reconnects instead of duplicating. It is also the live Herdr agent name: `[a-z][a-z0-9_-]{0,31}` — lowercase, 1–32 characters, starting with a letter. Illegal Names fail immediately; Drovr does not slugify.
_Avoid_: task id, run id (as the reconnect key)

**Start checkout**:
The git checkout from which Drovr was launched. Drovr does not switch its branch.
_Avoid_: main working tree (unless it is also the launch directory)

**Worktree**:
A second git checkout of the same repository, keyed by Name, that isolates a Worker's files from the Start checkout.
_Avoid_: sandbox, clone (as the isolation unit)

**Worktree setup**:
The repository-defined preparation Drovr must finish after physically creating a Worktree and before its Worker may start.
_Avoid_: dependency installation (too narrow), Task

**Resource**:
A named, capacity-limited lock Drovr leases so scarce environments are not used in parallel. Capacity is defined before the first lease.
_Avoid_: mutex, semaphore (as the domain name)

**Port Resource**:
A Resource whose capacity-one Lease reserves an entire declared set of local TCP ports. Operating-system availability is informational and does not gate acquisition.
_Avoid_: port pool, allocated port

**Lease**:
One Name occupying one slot of a Resource.
_Avoid_: lock, hold, reservation (when meaning a Resource slot)

**Issue**:
A GitHub issue the workflow can list, claim, or close via the `gh` CLI. User code maps over issues and starts workers; Drovr does not wrap them in its own task type.
_Avoid_: Task, TaskSource

**Claim**:
Durable ownership of an Issue by a Workflow Name. Claiming assigns the authenticated GitHub user, but that assignment may remain after the Claim ends.
_Avoid_: lock, checkout

**Close**:
A Workflow call that closes the GitHub Issue and releases its Claim while retaining its assignee and readiness label.
_Avoid_: complete, finish

**Release**:
A Workflow call that releases a Claim without closing or unassigning the Issue, handing responsibility to the retained assignee rather than requeueing it.
_Avoid_: unclaim, requeue

**Completion**:
A Name whose map callback returned, recorded in the project database so `--resume` skips it. A throw is not a Completion.
_Avoid_: Close, checkpoint, step log

**Project database**:
The SQLite file shared by Drovr processes in one Start checkout. It is the collision boundary for Claims, Leases, and Completions.
_Avoid_: state file, global store, ~/.drovr
