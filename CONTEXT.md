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
The user-supplied git-safe slug that keys a Worker, Worktree, and Resource lease so a second pass reconnects instead of duplicating. Legal characters are `A-Za-z0-9._-`; it must not start with `.` or `-`.
_Avoid_: task id, run id (as the reconnect key)

**Start checkout**:
The git checkout from which Drovr was launched. Drovr does not switch its branch.
_Avoid_: main working tree (unless it is also the launch directory)

**Worktree**:
A second git checkout of the same repository, keyed by Name, that isolates a Worker's files from the Start checkout.
_Avoid_: sandbox, clone (as the isolation unit)

**Resource**:
A named, capacity-limited lock Drovr leases so scarce environments are not used in parallel. Capacity is defined before the first lease.
_Avoid_: mutex, semaphore (as the domain name)

**Issue**:
A GitHub issue the workflow can list or claim via the `gh` CLI. User code maps over issues and starts workers; Drovr does not wrap them in its own task type.
_Avoid_: Task, TaskSource

**Claim**:
Durable ownership of an Issue by a Workflow Name, reserved in the project database and shown on GitHub by assigning the authenticated user. A Claim remains until explicitly released.
_Avoid_: lock, checkout
