# V1 logging library decision

**Issue:** [#17 Which logging library fits the V1 contract?](https://github.com/ricardogzm/drovr/issues/17)  
**Research date:** 2026-08-17  
**Recommendation:** `winston` (no companion package)

## Decision

Use Winston's built-in `Stream` and `Console` transports, with a Node `fs.createWriteStream()` in append mode as the file stream and a separate format on each transport. This is the best fit for V1: Winston supplies the transport fan-out, per-destination formatting, level routing, and logger lifecycle; Node supplies the direct append stream whose errors Drovr can observe. No custom Winston transport or third-party pretty-printer is required.

Winston's built-in `File` transport is a useful comparison point, but it is **not** the recommended fallback design: its source attaches the underlying `fs.WriteStream` error to diagnostics rather than forwarding it as a transport error. The `Stream` transport lets Drovr retain the `fs.WriteStream` reference and subscribe to its `error` event directly. [Winston File source](https://github.com/winstonjs/winston/blob/master/lib/winston/transports/file.js), [Winston Stream source](https://github.com/winstonjs/winston/blob/master/lib/winston/transports/stream.js), [Node `fs.createWriteStream`](https://nodejs.org/api/fs.html#fscreatewritestreampath-options)

Winston 3.19.0 is published as CommonJS (`main: ./lib/winston.js`) while shipping TypeScript declarations (`types: ./index.d.ts`). The current ESM/TypeScript toolchain should use its supported default-import/interoperability path and verify that import at implementation time. [Winston package metadata](https://raw.githubusercontent.com/winstonjs/winston/master/package.json), [Winston declarations](https://raw.githubusercontent.com/winstonjs/winston/master/index.d.ts), [Drovr TypeScript settings](https://github.com/ricardogzm/drovr/blob/main/tsconfig.json)

## Contract to satisfy

- append semantic one-line text events to `.drovr/drovr.log` across fresh and resume starts;
- keep file output free of ANSI escapes;
- with `--verbose`, mirror events to stderr with independent terminal formatting;
- enable color only for a TTY and disable it when `NO_COLOR` is present;
- if opening or appending the file fails, report the failure, switch subsequent events to stderr, and leave orchestration outcomes unchanged;
- let Drovr own stable event names and fields; the logger supplies transport/routing/format mechanics;
- support the TypeScript ESM package and avoid worker-thread/process lifecycle surprises.

Drovr should render its semantic line as the Winston message (or equivalent `info[MESSAGE]`) and keep the plain file format separate from terminal formatting. The logger must not invent Drovr event names or fields.

## Comparison

| Library | Sink and formatting | TTY / `NO_COLOR` | Flush and errors | TS/ESM, weight, lifecycle | Result |
| --- | --- | --- | --- | --- | --- |
| **Winston 3.19.0** | Built-in `Stream` transport wraps a Node append stream; built-in `Console`; each transport has its own format; `stderrLevels` can route INFO and ERROR to stderr. | Winston routes streams but its colorizer forces colors. Drovr gates color using `process.stderr.isTTY` and `NO_COLOR`; file format never uses colorize. | Logger emits `finish` after `end()` flushes transports and emits logger errors. Drovr also owns the fs stream's `error` listener, so append failures can trigger fallback. | Type declarations included; package is CJS. No transport worker/process. Runtime deps are more numerous than LogTape but no companion is required. | **Choose.** One maintained package plus Node core, with explicit error/fallback seam. |
| **Pino 10.3.1 + `pino-pretty` if used** | Built-in `pino/file` and multiple targets; pretty/color is a separate package. | Requires separate target configuration; core does not provide Drovr's stderr TTY/`NO_COLOR` policy. | Transport docs describe async worker operation and `sync: true`; startup/readiness/close cross a worker boundary. | Declarations included; CJS; runtime stack includes `thread-stream`, `sonic-boom`, and `pino-abstract-transport`. | **Reject.** Capable, but worker lifecycle and extra pretty package add avoidable V1 risk. |
| **Consola 3.4.2** | Reporter API and fancy/basic console reporters; no built-in file append sink, so Drovr would own a custom reporter/sink. | Its source honors `NO_COLOR` and checks `tty.isatty(1)` (stdout), not stderr. | Reporter API has no built-in file append/flush/error contract comparable to a direct fs stream. | Native ESM/conditional exports and declarations; no worker. Lightweight, but missing required sink. | **Reject.** Good CLI color behavior, not a complete file + stderr solution. |

## Primary-source findings

### Winston

Winston defines a transport as a log storage device and lists `Console`, `File`, and `Stream` as built-ins. Its transport docs specify `Console.stderrLevels`, `File` append options, and `Stream` as accepting any Node stream. [Winston transports documentation](https://github.com/winstonjs/winston/blob/master/docs/transports.md#built-in-to-winston)

The README shows multiple transports and says each transport can have its own format, including `format.combine(format.colorize(), format.simple())` on Console. Drovr can therefore give the file stream a deterministic plain formatter and the stderr transport an independent readable formatter. [Winston README, per-transport formats](https://github.com/winstonjs/winston/blob/master/README.md#common-transport-options)

Winston is a Node stream: after `logger.end()`, `finish` means logs have flushed to all transports, and the logger emits `error` for logger errors. [Winston README, awaiting logs](https://github.com/winstonjs/winston/blob/master/README.md#awaiting-logs-to-be-written-in-winston)

The `Stream` transport writes the formatted message plus EOL to the supplied stream and does not hide that stream behind a worker. Drovr can retain the `fs.WriteStream`, listen for its `error`, report once, remove the file transport, and route later events to stderr. The `File` transport is less suitable for this exact fallback: its `fs.createWriteStream(...).on('error', err => debug(err))` handler only sends the error to diagnostics. [Winston Stream source](https://github.com/winstonjs/winston/blob/master/lib/winston/transports/stream.js), [Winston File source](https://github.com/winstonjs/winston/blob/master/lib/winston/transports/file.js)

Winston's logform colorizer sets `colors.enabled = true`; it must not be assumed to honor TTY or `NO_COLOR`. Drovr must choose the format before constructing the Console transport: color only when `verbose && process.stderr.isTTY && !Object.hasOwn(process.env, "NO_COLOR")`; otherwise use the same formatter without ANSI. Never attach colorize to the file format. [Winston logform colorize source](https://github.com/winstonjs/logform/blob/master/colorize.js)

Winston publishes runtime dependencies, CommonJS entry metadata, and `index.d.ts`; this is a larger dependency tree than LogTape's zero-dependency core but avoids a separate pretty package and worker transport. [Winston package metadata](https://github.com/winstonjs/winston/blob/master/package.json), [Winston TypeScript declarations](https://github.com/winstonjs/winston/blob/master/index.d.ts)

### Pino

Pino recommends processing/reformatting in a separate process or thread and recommends `pino.transport`. Its transport documentation says v7+ transport code executes in a separate worker thread, is asynchronous unless `sync: true`, supports ESM transport modules, multi-target routing, and the `pino/file` target. [Pino README](https://github.com/pinojs/pino#transports--log-processing), [Pino transport documentation](https://github.com/pinojs/pino/blob/main/docs/transports.md#v7-transports)

The Pino source constructs `ThreadStream` and registers process-exit flushing. This can be durable, but it is an unnecessary worker lifecycle boundary for a short-lived CLI that must switch sinks on a file error. [Pino transport source](https://github.com/pinojs/pino/blob/main/lib/transport.js)

Pino has declarations but its package metadata is CJS. Its runtime dependency list includes `thread-stream`, `sonic-boom`, and `pino-abstract-transport`; `pino-pretty` is separate from the runtime package. [Pino package metadata](https://github.com/pinojs/pino/blob/main/package.json), [pino-pretty repository](https://github.com/pinojs/pino-pretty)

### Consola

Consola is TypeScript and publishes conditional ESM/CJS exports and declarations. Its README documents pluggable reporters, fancy/basic reporters, and a custom reporter with a `log(logObject)` method. [Consola README](https://github.com/unjs/consola#custom-reporters), [Consola package metadata](https://github.com/unjs/consola/blob/main/package.json)

Its documented package surface is reporter-oriented and has no file append transport. Writing `.drovr/drovr.log` would require Drovr to create and maintain a custom reporter, including append, flush, error propagation, and fallback behavior. [Consola README](https://github.com/unjs/consola#custom-reporters), [Consola reporter source tree](https://github.com/unjs/consola/tree/main/src/reporters)

Consola's color utility disables color when `NO_COLOR` is present and checks `TERM=dumb`, CI, and `tty.isatty(1)`. That is good general CLI behavior, but fd 1 is stdout; Drovr's contract requires stderr-specific TTY detection. [Consola color source](https://github.com/unjs/consola/blob/main/src/utils/color.ts)

## Minimum integration shape (not implementation)

1. Construct one Winston logger per `drovr start` invocation. Create `const fileStream = fs.createWriteStream(path, { flags: "a" })`, retain the reference, and wrap it in Winston's `Stream` transport. Add a Console transport only for `--verbose`, with `stderrLevels: ["info", "error"]`.
2. Give the file transport a deterministic plain formatter: RFC 3339 UTC timestamp, `INFO`/`ERROR`, Drovr-owned event name, and escaped event-specific key/value fields. Do not use `format.colorize()` there.
3. Give Console a separate readable formatter. Add color only when `process.stderr.isTTY` is true and `NO_COLOR` is absent; otherwise use the same formatter without ANSI.
4. Subscribe to `fileStream.error` before the first append. On the first open/append error, write one diagnostic directly to stderr, remove/disable the file transport, and route subsequent events to an uncolored stderr transport. The handler must not throw into orchestration code.
5. At command shutdown call `logger.end()` and await `finish`; close the file stream after the logger has drained. Logger/stream errors must remain non-throwing to Claim, Lease, Completion, callback, and command outcomes.
6. Keep event names, required fields, escaping, and payload redaction in Drovr's event adapter. Never log prompt bodies or child process output.

This is a design boundary only; no dependency installation or production implementation is part of issue 17.

## Unresolved risk

Winston's CJS packaging plus `export =` declarations may require a precise import form under final ESM bundling; confirm during ordinary implementation typecheck/build. Its colorizer forces colors globally, so color gating and separate file formatting are mandatory. Finally, `logger.info()` only queues a write: the retained fs stream's asynchronous `error` event—not a successful log call—must drive the fallback. The chosen design addresses this by using Winston `Stream` over a directly observed Node append stream rather than relying on the File transport's diagnostics-only write-error handler.
