# OMP session control (17.2.15)

Research for Drovr issue [#3](https://github.com/ricardogzm/drovr/issues/3). Investigates how OMP on this machine identifies, resumes, and accepts prompts, with emphasis on visible Herdr panes and what survives orchestrator vs agent restarts.

**Environment:** `omp` v17.2.15 at `~/.bun/bin/omp` → `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` (package `@oh-my-pi/pi-coding-agent@17.2.15`).

**Non-goals:** Choosing Drovr's control path; implementing anything; Herdr-only mechanics (issue #2).

---

## Executive summary

| Question                           | Answer                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session identity                   | UUID v7 in JSONL header (`type: "session"`, field `id`); file name `{ISO-timestamp}_{uuid}.jsonl`.                                                                                                                                                  |
| Storage root                       | `PI_CODING_AGENT_DIR` (default `~/.omp/agent`); sessions under `<agentDir>/sessions/<cwd-encoded>/`.                                                                                                                                                |
| Resume                             | `--resume` / `-r` and `--continue` / `-c` **start a new OMP process** that opens persisted JSONL — there is **no attach-to-live-process** API.                                                                                                      |
| External prompt to live TUI        | **Not supported** on default interactive mode. Another process cannot call into a running interactive OMP without replacing it or racing on the session file.                                                                                       |
| External prompt with observability | **`--mode rpc` or `--mode rpc-ui`** on the **same** OMP process: JSON commands on stdin (`type: "prompt"`, `steer`, `follow_up`, …); events on stdout. `rpc-ui` enables extension/tool UI bridging but **does not** start the full interactive TUI. |
| Drovr restart, OMP still running   | OMP process + in-memory state survive; Drovr must re-derive session id/path from its SQLite + OMP `get_state` / file path.                                                                                                                          |
| OMP restart                        | Transcript on disk survives; in-memory turn state, queues, and hub peers are lost; resume reloads JSONL in a new process.                                                                                                                           |

---

## Session IDs and on-disk layout

### Agent directory

`omp --help` documents:

- `PI_CODING_AGENT_DIR` — session storage directory (default `~/.omp/agent`).
- `--session-dir=<path>` — directory for session storage and lookup for **this run**.
- `PI_CODING_AGENT_SESSION_DIR` — read at CLI parse time as the default for `--session-dir` when the flag is omitted (`src/cli/args.ts`).

On this machine, `~/.omp/agent/` also holds `agent.db`, `config.yml`, `blobs/`, `terminal-sessions/`, etc.

**Source:** `omp --help`; `src/cli/help-extra.ts`; `src/cli/args.ts:156`; `~/.omp/agent/` listing (2026-08-12).

### Per-project session folder

Sessions are grouped by **canonical cwd**, not by Drovr worker name:

```
~/.omp/agent/sessions/<encoded-cwd>/
  2026-08-12T19-32-26-189Z_019ff776-31cd-7000-a06f-421b3ed96497.jsonl
  2026-08-12T19-32-26-189Z_019ff776-31cd-7000-a06f-421b3ed96497/   # artifact dir (tool logs, subagent transcripts)
```

Encoding rules (`src/session/session-paths.ts`):

- Paths under `$HOME` → `-<home-relative>` with `/`, `\`, `:` → `-` (e.g. `/home/user/Projects/drovr` → `-Projects-drovr`).
- Paths under temp → `-tmp<relative>`.
- Other absolute paths → legacy absolute encoding.

**Source:** `src/session/session-paths.ts` (`getDefaultSessionDirName`, `computeDefaultSessionDir`); `src/session/session-manager.ts:1073-1076` (file naming); observed paths under `~/.omp/agent/sessions/-Projects-drovr/`.

### Session UUID and JSONL header

New sessions allocate a UUID and write:

```json
{
  "type": "session",
  "version": 3,
  "id": "019ff776-31cd-7000-a06f-421b3ed96497",
  "timestamp": "...",
  "cwd": "/home/ricardogzm/Projects/drovr"
}
```

File basename: `{fileSafeTimestamp}_{sessionId}.jsonl`.

**Source:** `src/session/session-manager.ts` (`#resetToNewSession`); sample file on this machine.

### Resume lookup keys

`resolveResumableSession` matches `--resume <arg>` when `<arg>` is a prefix of:

1. `session.id` (UUID),
2. full file basename (without `.jsonl`), or
3. UUID suffix after the last `_` in the basename.

A full path ending in `.jsonl` is opened directly.

**Source:** `src/session/session-listing.ts` (`sessionMatchesResumeArg`, `resolveResumableSession`).

**Empirical:** `omp -r 019ff776 --cwd /home/ricardogzm/Projects/drovr -p "reply with exactly: resumed-ok"` → `resumed-ok` (prefix match works).

---

## `--continue` vs `--resume`

Both are implemented in `createSessionManager` (`src/main.ts`). Neither attaches to an already-running OMP; each launch builds a `SessionManager` and then starts interactive, print, or RPC mode.

### `--continue` / `-c`

`SessionManager.continueRecent(cwd, sessionDir)` (`src/session/session-manager.ts:2684-2762`):

1. Read **terminal breadcrumb** for the current TTY (`~/.omp/agent/terminal-sessions/<terminal-id>`), written as `cwd\nsessionFile\n[fresh\n]`.
2. If breadcrumb cwd matches launch cwd → open that session file.
3. Else apply move/re-root heuristics, else `findMostRecentSession` in the project session dir.
4. If nothing found → new session.

Breadcrumbs map **one terminal** to **one session file** so concurrent OMP instances in different panes do not steal each other's "continue" target.

**Source:** `src/session/session-paths.ts` (breadcrumb section); `src/session/session-manager.ts` (`continueRecent`).

`omp --help` example: `omp --continue "What did we discuss?"`

### `--resume` / `-r`

| Form                           | Behavior                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `-r <id-prefix\|path\|.jsonl>` | Resolve and `SessionManager.open` (`src/main.ts:778-820`).                                                            |
| `-r` (no value)                | Interactive session picker (`src/main.ts:1468-1509`).                                                                 |
| `-c <uuid>`                    | Normalized to `-r <uuid>` when the next token is a full UUID (`normalizeContinueSessionArgs`, `src/main.ts:727-745`). |

`--from-claude` / `--from-codex` cannot combine with `--continue`, `--resume`, or `--fork` (`src/main.ts:616-617`).

### `autoResume` setting

When `autoResume` is true in settings, a plain `omp` (no flags) calls `continueRecent` like `--continue` (`src/main.ts:834-839`; `src/config/settings-schema.ts:401-409`). Default is **false**.

### `--no-session`

Ephemeral in-memory session; nothing persisted (`SessionManager.inMemory`, `src/main.ts:773-774`).

---

## Output modes and prompting

`omp --help`: `--mode=<value>` — `text` (default), `json`, `rpc`, or `rpc-ui`. `-p` / `--print` — non-interactive: process prompt and exit.

Classification in `src/main.ts:1270-1274`:

- **Interactive:** no `-p`, no `--mode`, stdin is a TTY (not protocol mode).
- **Print / JSON:** `-p` or piped stdin without `--mode`.
- **Protocol:** `rpc`, `rpc-ui`, or `acp` — stdin is **not** read as a user prompt; RPC uses `claimRpcInput()` (`src/main.ts:1238`, `src/modes/rpc/rpc-input.ts`).

### Default interactive (Herdr-visible TUI)

- Full TUI via `runInteractiveMode` (`src/main.ts:1762-1778`).
- Prompts: keyboard input in the pane, optional initial positional message, `@file` attachments.
- `setInteractiveHost(true)` — Agent Hub / subagent tree available (`src/main.ts:1275-1278`).
- Session persistence appends to JSONL continuously; breadcrumb updated on create/switch.

**External process cannot inject prompts** into this mode through any documented CLI or RPC surface. The only first-party cross-session prompt paths are:

- **Collab** (`/join`, `src/collab/host.ts`) — network guests prompt the **host** session over a relay (not a generic local IPC API).
- **Hub IRC** (`src/tools/hub/messaging.ts`) — agent-to-agent messaging **inside one OMP process** (subagents / task tree), not between separate top-level OMP instances.
- **Hub daemon `send`** (`src/tools/hub/launch.ts`) — stdin to processes started via the hub broker, not to arbitrary interactive OMP.

Starting a second `omp -r <same-session> -p "..."` while interactive OMP holds that session is a **second process** writing the same JSONL. OMP does not implement file locking for exclusive session access (no `flock` / "already open" guard in `session-storage.ts` / `session-manager.ts`). **Unsafe for concurrent writers.**

### `-p` / print mode

`src/modes/print-mode.ts`: send prompt(s), emit final text or JSON event stream, exit. Can combine with `-r` / `-c` to run one shot against a persisted session (verified on this machine). Destroys live TUI because the process exits.

Piped stdin without `-p` auto-enters print mode (`src/main.ts:1273`, `readPipedInput`).

### `--mode json`

Print-mode event stream with trimmed `message_update` payloads (`src/modes/print-mode.ts:56-82`).

### `--mode rpc`

Headless JSON line protocol (`src/modes/rpc/rpc-mode.ts` header comment):

- **stdin:** commands (`RpcCommand` in `src/modes/rpc/rpc-types.ts`) — `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `switch_session`, …
- **stdout:** `ready` frame, then `response` objects and `AgentSessionEvent` streams.
- Stdout is **exclusive** protocol channel (`PI_NOTIFICATIONS=off`, no stray TUI output).
- No full TUI; extension UI becomes `extension_ui_request` / `extension_ui_response` over JSON.

**Empirical:** `echo '{"type":"prompt","message":"say hi","id":"1"}' | omp --mode rpc -p --no-session` emits `ready`, then `{"id":"1","type":"response","command":"prompt","success":true}`, plus agent events.

`get_state` returns `sessionId`, `sessionFile`, streaming flags, queue depth (`src/modes/rpc/rpc-mode.ts:1075-1103`).

### `--mode rpc-ui`

Same code path as `rpc` (`runRpcMode`), with differences (`src/main.ts`):

| Setting                                | `rpc`     | `rpc-ui`              |
| -------------------------------------- | --------- | --------------------- |
| `sessionOptions.hasUI`                 | false     | **true** (`1549`)     |
| `setToolUIContext` passed to RPC       | no        | **yes** (`1737`)      |
| `PI_NO_PTY`                            | unchanged | **set** (`1299-1300`) |
| Interactive TUI (`runInteractiveMode`) | no        | **no**                |

`rpc-ui` means "RPC host with extension/tool UI context bridged over the protocol," **not** "interactive OMP TUI plus RPC." There is still no native scrollback TUI in the Herdr pane for `rpc-ui`.

**Implication for Drovr:** A visible pane showing OMP's default TUI and an external orchestrator prompting via RPC are **mutually exclusive modes** on a single process. Combinations are:

1. **Interactive in pane** — human observability; Drovr prompts via PTY keystrokes (Herdr concern, issue #2) or does not prompt live.
2. **`rpc-ui` in pane** — Drovr (or a wrapper) owns stdin JSON; observability is from RPC event stream + whatever UI the host renders, not the standard OMP TUI.
3. **Interactive in pane + `omp -r … -p`** — new short-lived process; not live attach; risks JSONL races if overlapping with the pane process.

---

## Terminal breadcrumbs and TTY identity

Path: `~/.omp/agent/terminal-sessions/<terminal-id>` (from `getTerminalSessionsDir()` in `pi-utils/src/dirs.ts:816-818`).

Observed example:

```
/home/ricardogzm/Projects/Work/zonner
/home/ricardogzm/.omp/agent/sessions/-Projects-Work-zonner/2026-08-10T18-58-56-309Z_019fed0a-ceb5-7000-bd91-e3ee4945f5ca.jsonl
```

Files are named like `pts-0`, `pts-1`, … — tied to the **TTY** that started the session, not the OMP PID.

**Survives:** OMP exit and Drovr restart (file on disk).  
**Does not survive:** Reusing a different TTY without `--resume` (new breadcrumb on new terminal).  
**Scope:** Per-terminal "continue" hint; Drovr should store `sessionId` + `sessionFile` in its own SQLite rather than relying on breadcrumbs alone.

---

## What survives restarts

### Persisted across OMP exit and process restart

| Artifact            | Location                                  | Notes                                                |
| ------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Session transcript  | `*.jsonl` under `sessions/<encoded-cwd>/` | Authoritative history; resume replays this.          |
| Session artifacts   | `<basename>/` sibling dir                 | Tool logs, subagent JSONL, etc.                      |
| Agent config / DB   | `~/.omp/agent/`                           | `config.yml`, `agent.db`, models DB, blobs.          |
| Terminal breadcrumb | `terminal-sessions/<tty>`                 | Continue hint for that TTY only.                     |
| Daemon broker state | Project-scoped under OMP launch dirs      | Hub-managed processes (separate from session JSONL). |

### Lost on OMP process exit

- In-memory agent loop, streaming partial turn, approval dialogs.
- Steering / follow-up queues not yet flushed.
- IRC hub peer table and subagent registry for that process.
- RPC stdin connection (protocol mode ends with process).

Resume in a new process reloads JSONL; pending tool calls trigger a warning (`src/main.ts:1512-1524`).

### Drovr restart vs OMP restart

| Event                                   | OMP in Herdr pane                              | On-disk OMP session  | Drovr SQLite                                                                                                             |
| --------------------------------------- | ---------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Drovr restart**, OMP keeps running    | **Unchanged** — same PID, same live state      | Unchanged            | Drovr must reload; reconnect to worker by **Name** (per core spec #1) using stored `sessionId` / `sessionFile` / pane id |
| **OMP restart** (pane process replaced) | New process; must `-r` or `-c` or `autoResume` | Transcript preserved | Drovr updates live binding; re-run workflow from top against restored workers                                            |
| **Machine reboot**                      | Gone                                           | JSONL preserved      | Spec: not required recovery for OMP death / reboot (#1)                                                                  |

Drovr should treat **`sessionFile` or `sessionId` + cwd** as the stable OMP identity in SQLite. After OMP-only restart, Drovr can spawn `omp -r <id> --cwd <worktree>` in the same pane; that is **recovery**, not **attach**.

---

## RPC prompt contract (for orchestrators)

Minimal flow:

1. Start: `omp --mode rpc [--resume <id>] --cwd <dir>` (optionally `--session-dir`).
2. Wait for stdout `{"type":"ready",...}`.
3. Send JSON lines on stdin, e.g. `{"type":"prompt","message":"…","id":"1"}`.
4. Consume stdout: `response`, `AgentSessionEvent`, `prompt_result`, tool events.
5. Optional: `get_state` for `sessionId`, `sessionFile`, `isStreaming`, `queuedMessageCount`.

Steering while streaming: `steer` / `follow_up` / `abort` (`src/modes/rpc/rpc-types.ts:33-37`).

For a **visible** pane without the native TUI, `rpc-ui` adds extension UI request/response handling but still requires a host to render those requests (or leave them unanswered).

---

## Implications for Drovr (research only)

1. **Store** `sessionId`, `sessionFile`, `cwd`, and pane/broker name in Drovr SQLite when a worker starts.
2. **Do not assume** a second `omp` CLI invocation can steer a live interactive session in another pane.
3. **Choose one control plane per worker:** interactive TUI _or_ RPC on the same process; mixing requires PTY injection (Herdr) or collab, not stock OMP.
4. **On Drovr `--resume`**, if the OMP process is still alive, reconnect by name and prompt via the mode that process actually uses (likely RPC stdin if Drovr launched `rpc-ui`); if dead, re-launch with `omp -r <stored-id>`.
5. **Issue #2** covers whether Herdr can inject keystrokes into a pane without breaking the TUI; this ticket only establishes that OMP provides no first-party alternative for default interactive mode.

---

## Source index

| Claim                   | Primary source                                                         |
| ----------------------- | ---------------------------------------------------------------------- |
| CLI flags and env vars  | `omp --help` (17.2.15); `src/cli/help-extra.ts`                        |
| Session dir encoding    | `src/session/session-paths.ts`                                         |
| File naming, UUID       | `src/session/session-manager.ts`                                       |
| Resume matching         | `src/session/session-listing.ts`                                       |
| continue / resume logic | `src/main.ts` (`createSessionManager`, `normalizeContinueSessionArgs`) |
| Mode routing            | `src/main.ts:1270-1797`                                                |
| RPC protocol            | `src/modes/rpc/rpc-mode.ts`, `src/modes/rpc/rpc-types.ts`              |
| Print mode              | `src/modes/print-mode.ts`                                              |
| Breadcrumbs             | `src/session/session-paths.ts`; `pi-utils/src/dirs.ts`                 |
| Hub / collab boundaries | `src/tools/hub/messaging.ts`, `src/collab/host.ts`                     |
| Empirical resume + RPC  | Commands run on this machine, 2026-08-12                               |
