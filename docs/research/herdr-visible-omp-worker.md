# Herdr control of visible OMP workers (0.8.0)

Research for Drovr issue [#2](https://github.com/ricardogzm/drovr/issues/2). Investigates what Herdr exposes for creating panes, starting OMP, prompting, waiting for idle, reading output, and rediscovering workers after Drovr exits — from primary Herdr sources only.

**Environment:** `herdr` 0.8.0 (protocol 19) at `~/.local/bin/herdr`; default session socket `~/.config/herdr/herdr.sock`; OMP integration v8 at `~/.omp/agent/extensions/herdr-omp-agent-state.ts` (`herdr integration status`).

**Non-goals:** Choosing Drovr's control path (issue #6); OMP session semantics (issue #3).

---

## Executive summary

| Question                      | Answer                                                                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create workspace / pane       | `herdr workspace create` (returns workspace, tab, root pane); `herdr tab create`; `herdr pane split`; optional `herdr worktree create` for Herdr-managed git worktrees.                                                                  |
| Start OMP in a pane           | `herdr agent start <name> --kind omp --pane <pane-id>` after the pane is at an interactive shell prompt; optional OMP args after `--`.                                                                                                   |
| Send a prompt                 | `herdr agent prompt <target> "<text>"` — submits text + Enter with bracketed-paste awareness.                                                                                                                                            |
| Wait until idle               | `herdr agent prompt … --wait` or `herdr agent wait <target>`; default settled states are `idle`, `done`, `blocked`.                                                                                                                      |
| Read terminal output          | `herdr agent read <target> --source recent-unwrapped --lines N` (text to stdout); `herdr pane read` for raw panes.                                                                                                                       |
| Rediscover after Drovr exit   | `herdr agent get <name>` or `herdr agent list` while the agent is still live; returns `pane_id`, `workspace_id`, `agent_status`, and `agent_session` (OMP JSONL path). Names are unique only among **live** agents.                      |
| Drovr inside vs outside Herdr | **Drovr does not need `HERDR_ENV=1`.** The `herdr` CLI talks to the local server socket from any process. `HERDR_ENV=1` is required **inside** OMP panes so the OMP integration can report lifecycle and session identity back to Herdr. |

---

## Control plane: socket API and CLI

Herdr runs a persistent server (default session `default`) exposing a Unix socket. The `herdr` CLI is a thin client over that socket.

| Fact                | Source                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Socket path         | `herdr status` → `server.socket` (observed: `/home/ricardogzm/.config/herdr/herdr.sock`) |
| Live state snapshot | `herdr api snapshot` (JSON)                                                              |
| Request schema      | `herdr api schema` / `herdr api schema --json` (protocol 19, schema_version 1)           |
| Named sessions      | `herdr --session <name>`; `herdr session list`                                           |
| Config override     | `HERDR_CONFIG_PATH` env (`herdr --help`)                                                 |

**Verified (2026-08-12):** `env -u HERDR_ENV herdr agent list`, `herdr workspace list`, and `herdr api snapshot` all succeed and return the same session data as in-pane calls. The agent skill (`herdr --skill`) instructs **coding agents inside a pane** to require `HERDR_ENV=1` before issuing control commands; that is guidance for agents co-located with the user, not a hard restriction on the `herdr` binary.

---

## Create a workspace or pane

### Workspaces and tabs

```bash
herdr workspace create --cwd /path/to/repo --label my-ws --no-focus
# → .result.workspace.workspace_id, .result.tab, .result.root_pane

herdr tab create --workspace w1 --cwd /path --label tab-2 --no-focus
# → .result.tab, .result.root_pane
```

`workspace create` optionally sets `--env KEY=VALUE` for the launched shell. Use `--no-focus` for background orchestration (`herdr --skill`).

**Source:** `herdr workspace create --help`; `herdr tab create --help`; `herdr --skill` (“Creation responses expose the IDs to use next”).

### Panes

```bash
herdr pane split --direction right --cwd "$PWD" --no-focus [PANE_ID]
# → .result.pane.pane_id
```

Pane IDs are opaque handles like `w3:p1`. After `pane move`, the pane receives a new ID; the skill documents `.result.move_result.pane.pane_id` as the continuation handle.

**Source:** `herdr pane split --help`; `herdr --skill` (IDs and move semantics).

### Herdr worktrees (optional layout primitive)

```bash
herdr worktree create --path /path/to/checkout --branch feat/x --label wt --no-focus
```

This is Herdr's git-worktree-backed **workspace**, separate from Drovr's own worktree story (issue #5). Listed in `herdr workspace list` with a `worktree` object (`checkout_path`, `repo_root`, etc.).

**Source:** `herdr worktree create --help`; observed `herdr workspace list` / `herdr api snapshot`.

---

## Start OMP in a pane

### Preferred: agent start

```bash
herdr agent start my-worker --kind omp --pane w3:p2 [--timeout MS] [-- omp-arg ...]
```

| Constraint   | Detail                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Pane state   | Must be at an interactive shell prompt (no foreground process).                                                                     |
| `--kind omp` | Listed in `herdr agent start --help` possible values; OMP integration installed (`herdr integration status` → `omp: current (v8)`). |
| Name         | First positional arg; pattern `[a-z][a-z0-9_-]{0,31}`, unique among live agents (`herdr --skill`).                                  |
| Readiness    | Command blocks until Herdr detects OMP ready for input (default 30s, max 300s).                                                     |
| OMP args     | Pass after `--` (e.g. `-- --resume <session-id> --cwd <dir>`).                                                                      |

**Source:** `herdr agent start --help`; API `AgentStartParams` (`name`, `kind`, `pane_id`, `args`, `timeout_ms`); `herdr --skill`.

### Alternative: raw pane run (not recommended for Drovr)

```bash
herdr pane run w3:p2 omp
```

Runs a shell command in the pane. OMP may start, but lifecycle/session reporting depends on Herdr injecting `HERDR_ENV`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` into managed panes — the OMP integration's `enabled()` gate requires all three (`~/.omp/agent/extensions/herdr-omp-agent-state.ts:18-20`). Without them, `agent prompt --wait` and idle detection are unreliable.

**Source:** `herdr pane run --help`; `herdr-omp-agent-state.ts`.

### What OMP reports back

When the integration is active, OMP sends:

- `pane.report_agent` — lifecycle (`idle`, `working`, `blocked`, `unknown`) with optional `agent_session_id` / `agent_session_path`.
- `pane.report_agent_session` — session identity on startup and session changes.

Observed on a live named agent:

```json
"agent_session": {
  "agent": "omp",
  "kind": "path",
  "source": "herdr:omp",
  "value": "/home/ricardogzm/.omp/agent/sessions/-Projects-drovr/2026-08-12T21-50-37-629Z_019ff7f4-b63d-7000-9a06-7d35f3f4a1d5.jsonl"
}
```

**Source:** `herdr api snapshot`; `herdr agent get drovr-worker`; `herdr-omp-agent-state.ts` (`reportSession`, `sendState`).

---

## Send a prompt

```bash
herdr agent prompt my-worker "Do the thing." --wait [--timeout 120000] [--until blocked]
```

| Behavior       | Detail                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Target         | Unique live agent **name** or **pane id** hosting that agent (`herdr agent` help).                   |
| Delivery       | Atomically writes text and Enter; honors bracketed-paste mode (`herdr --skill`).                     |
| `--wait`       | Waits for first settled state after submission: default `idle`, `done`, or `blocked`.                |
| Stall guard    | From non-working state, must observe a lifecycle change within 5s or returns `agent_prompt_stalled`. |
| Turn semantics | Does not track “turns”; if already `working`, completion of the active turn may satisfy `--wait`.    |

For interactive UI keys (approvals), use `herdr agent send-keys <target> <key>` (e.g. `esc`, `ctrl+c`).

**Source:** `herdr agent prompt --help`; `herdr agent send-keys --help`; API `AgentPromptParams`; `herdr --skill`.

**Cross-reference (issue #3):** Herdr injects into the pane PTY. This is how Drovr can steer a **visible interactive OMP TUI** without OMP's RPC mode — Herdr is the injection layer, not OMP's CLI.

---

## Wait until the worker is idle

Two equivalent surfaces:

```bash
herdr agent prompt my-worker "…" --wait --timeout 120000
herdr agent wait my-worker [--until idle|working|blocked|done|unknown] [--timeout MS]
```

### Agent status model

| Status    | Meaning (`herdr --skill`)                                   |
| --------- | ----------------------------------------------------------- |
| `idle`    | Ready for input; tab seen in focused Herdr UI.              |
| `done`    | Same underlying idle after unseen background work finished. |
| `working` | Agent actively processing.                                  |
| `blocked` | Approval/question UI detected.                              |
| `unknown` | Agent present but not confidently classified.               |

`idle` / `done` require the OMP integration to report state. Observed `agent explain drovr-worker` → `screen_detection_skip_reason: full_lifecycle_hook_authority` when hooks own lifecycle.

**Source:** `herdr agent wait --help`; API `AgentWaitParams`; API/event `AgentStatus` enum; `herdr --skill`; `herdr agent explain`.

### Pane-level wait (non-agent)

```bash
herdr pane wait-output <pane-id> --match "substring" [--timeout MS]
```

For ordinary shell commands, not OMP lifecycle. Use agent wait for workers.

**Source:** `herdr pane wait-output --help`; `herdr --skill`.

---

## Read terminal output

```bash
herdr agent read my-worker --source recent-unwrapped --lines 120 [--format text|ansi]
herdr pane read w3:p1 --source recent-unwrapped --lines 120
```

| `--source`         | Use                                                 |
| ------------------ | --------------------------------------------------- |
| `visible`          | Current viewport only.                              |
| `recent`           | Recent rendered output including soft wraps.        |
| `recent-unwrapped` | Soft wraps joined — preferred for logs/transcripts. |
| `detection`        | Bottom-buffer snapshot used for agent detection.    |

**Output format:** `agent read` / `pane read` write **plain text to stdout** (not JSON-wrapped), unlike `agent list` / `agent get`.

**Scrollback caveat:** If OMP uses the terminal alternate screen, completed response rows may not enter Herdr host scrollback; increasing `--lines` cannot recover them (`herdr --skill`). Fallback: have the agent write a file and read it from disk.

**Source:** `herdr agent read --help`; `herdr pane read --help`; `herdr --skill`.

---

## Rediscover an agent after Drovr exits

Herdr server and pane processes **outlive** a short-lived Drovr process. A new Drovr process reconnects via the same socket.

### Lookup by Name (Drovr's reconnect key)

```bash
herdr agent get <name>          # single agent
herdr agent list                # all live agents
```

A successful `agent get` returns:

- `name`, `pane_id`, `workspace_id`, `tab_id`
- `agent_status` (current lifecycle)
- `agent_session` (OMP JSONL path when integration active)
- `cwd` / `foreground_cwd`

**Name lifetime:** Unique among **live** agents only. Cleared when the agent exits, is released, or is replaced (`herdr --skill`). Drovr must handle `agent get` failure → worker gone (out of scope for required resume per map #1).

**Rename:** `herdr agent rename <target> <new-name>` or set name at `agent start`.

**Source:** `herdr agent get`; `herdr agent list`; `herdr agent rename --help`; `herdr --skill`; observed `drovr-worker` agent in snapshot.

### What to persist in Drovr SQLite (research hint)

| Field                 | Role                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `name`                | Primary Herdr lookup key (matches Drovr **Name** if aligned).    |
| `pane_id`             | Validate pane still hosts the named agent; re-fetch on mismatch. |
| `agent_session.value` | OMP JSONL path from `agent_session` (cross-check with issue #3). |
| `workspace_id`        | Layout context for debugging / focus.                            |

After Drovr crash with Herdr + OMP still up: new Drovr process calls `herdr agent get <name>` — no `HERDR_ENV` needed.

### Pane ID stability

Pane IDs are stable until `pane move` (then use new ID from move result). Closed pane IDs are not reused. Prefer **name** as the human/durable key; treat `pane_id` as a cache validated on resume.

**Source:** `herdr --skill` (IDs, move, name follows occupant).

---

## Inside Herdr vs separate Drovr process

| Actor                                            | Needs `HERDR_ENV=1`?          | Mechanism                                                                                                                               |
| ------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Drovr orchestrator** (library / `drovr start`) | **No**                        | `herdr` CLI → Unix socket → server API.                                                                                                 |
| **OMP in a managed pane**                        | **Yes** (for lifecycle hooks) | OMP integration reads `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`; reports via `pane.report_agent` / `pane.report_agent_session`. |
| **Coding agent using Herdr skill**               | **Yes** (by skill contract)   | `herdr --skill` requires `test "${HERDR_ENV:-}" = 1` before control commands.                                                           |

Drovr is expected to run as a normal host process (e.g. terminal tab or CI) and drive workers through `herdr`, while workers run visibly inside Herdr panes with OMP integration active.

**Source:** `herdr --skill`; `herdr-omp-agent-state.ts:11-20`; `env -u HERDR_ENV herdr agent list` (verified).

---

## End-to-end flow (reference sequence)

Illustrative only — not a Drovr design decision.

```bash
# 1. Layout (background)
RESP=$(herdr workspace create --cwd /path/to/worktree --label drovr-wt --no-focus)
PANE=$(echo "$RESP" | jq -r '.result.root_pane.pane_id')

# 2. Start visible OMP worker
herdr agent start issue-42 --kind omp --pane "$PANE" \
  -- --cwd /path/to/worktree

# 3. Prompt and wait
herdr agent prompt issue-42 "Implement the feature." --wait --timeout 600000

# 4. Read output
herdr agent read issue-42 --source recent-unwrapped --lines 200

# 5. After Drovr restart (Herdr still up)
herdr agent get issue-42   # → pane_id, agent_session, agent_status
```

---

## Implications for Drovr (research only)

1. **Herdr is viable as an external control plane** — Drovr can spawn and steer OMP without running inside a pane.
2. **Use the agent surface, not raw pane typing**, for prompt/wait/read so OMP lifecycle integration stays authoritative.
3. **Align Drovr Name with Herdr agent name** (same `[a-z][a-z0-9_-]{0,31}` rules) for `--resume` lookup via `agent get`.
4. **Persist `agent_session` path** from Herdr alongside OMP session ids from issue #3 — they should agree when integration is healthy.
5. **Do not rely on pane scrollback** for completed OMP turns; plan for `agent read` limits or file handoff.
6. **Issue #6** must still choose how Drovr combines Herdr agent control with OMP session flags (`--resume`, RPC vs TUI, etc.).

---

## Source index

| Claim                          | Primary source                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| CLI surface and env            | `herdr --help` (0.8.0)                                                                                                          |
| Agent skill semantics          | `herdr --skill`                                                                                                                 |
| Agent/pane/workspace commands  | `herdr agent`, `herdr pane`, `herdr workspace` (no subcommand)                                                                  |
| Command help text              | `herdr agent start --help`, `prompt --help`, `wait --help`, `read --help`, etc.                                                 |
| Socket API types               | `herdr api schema --json` (`AgentStartParams`, `AgentPromptParams`, `AgentWaitParams`, `AgentStatus`, `PaneInfo.agent_session`) |
| Live session state             | `herdr api snapshot`; `herdr status`                                                                                            |
| OMP integration behavior       | `~/.omp/agent/extensions/herdr-omp-agent-state.ts`; `herdr integration status`                                                  |
| External CLI without HERDR_ENV | `env -u HERDR_ENV herdr agent list` (verified 2026-08-12)                                                                       |
