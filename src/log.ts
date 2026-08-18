import { createWriteStream } from 'node:fs'
import winston from 'winston'

export interface DrovrLoggerCounts {
  started: number
  skipped: number
  completed: number
  failed: number
}

export interface DrovrLoggerOptions {
  logPath: string
  verbose?: boolean
}

export interface DrovrLogger {
  startBegin(mode: 'fresh' | 'resume'): void
  startComplete(mode: 'fresh' | 'resume', counts?: DrovrLoggerCounts): void
  startFail(mode: 'fresh' | 'resume', counts?: DrovrLoggerCounts, error?: unknown): void
  mapItemStart(name: string): void
  mapItemSkip(name: string): void
  mapItemComplete(name: string): void
  mapItemFail(name: string, error?: unknown): void
  resourceLeaseRequest(resource: string, name: string): void
  resourceLeaseWait(resource: string, name: string): void
  resourceLeaseAcquire(resource: string, name: string): void
  resourcePortProbe?(
    resource: string,
    name: string,
    port: number,
    address: '127.0.0.1' | '::1',
    status: 'available' | 'in-use' | 'unavailable',
  ): void
  close(): Promise<void>
}

const DEFAULT_COUNTS: DrovrLoggerCounts = {
  started: 0,
  skipped: 0,
  completed: 0,
  failed: 0,
}
function formatErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      try {
        if (typeof error.message === 'string') {
          return error.message
        }
      } catch {}
    }
    if (typeof error === 'string') {
      return error
    }
    if (typeof error === 'number') {
      return String(error)
    }
    if (typeof error === 'boolean') {
      return error ? 'true' : 'false'
    }
    if (typeof error === 'bigint') {
      return `${BigInt.prototype.toString.call(error)}n`
    }
    if (error === undefined) {
      return 'unknown error'
    }
    if (error === null) {
      return 'null'
    }
    try {
      const serialized = JSON.stringify(error)
      if (serialized !== undefined) {
        return serialized
      }
    } catch {}
    try {
      if (typeof error === 'object') {
        return Object.prototype.toString.call(error)
      }
      if (typeof error === 'function') {
        return Function.prototype.toString.call(error)
      }
      if (typeof error === 'symbol') {
        return Symbol.prototype.toString.call(error)
      }
    } catch {}
  } catch {}
  return 'unknown error'
}

export function createDrovrLogger(options: DrovrLoggerOptions): DrovrLogger {
  const { logPath, verbose = false } = options

  const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: () => new Date().toISOString() }),
    winston.format.printf(
      ({ level, message, timestamp }) =>
        `${String(timestamp)} ${String(level).toUpperCase()} ${String(message)}`,
    ),
  )

  const plainConsoleFormat = winston.format.combine(
    winston.format.timestamp({ format: () => new Date().toISOString() }),
    winston.format.printf(
      ({ level, message, timestamp }) =>
        `${String(timestamp)} ${String(level).toUpperCase()} ${String(message)}`,
    ),
  )

  const useColor = Boolean(process.stderr.isTTY) && process.env.NO_COLOR === undefined

  const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: () => new Date().toISOString() }),
    ...(useColor ? [winston.format.colorize()] : []),
    winston.format.printf(
      ({ level, message, timestamp }) =>
        `${String(timestamp)} ${useColor ? String(level) : String(level).toUpperCase()} ${String(message)}`,
    ),
  )

  const fileStream = createWriteStream(logPath, { flags: 'a' })
  const fileTransport = new winston.transports.Stream({
    stream: fileStream,
    format: fileFormat,
  })

  const transports: winston.transport[] = [fileTransport]
  if (verbose) {
    transports.push(
      new winston.transports.Console({
        stderrLevels: ['info', 'error', 'warn', 'debug', 'verbose', 'silly'],
        format: consoleFormat,
      }),
    )
  }

  const logger = winston.createLogger({ transports })
  logger.on('error', () => {
    // Swallow internal logger errors to avoid crashing orchestration
  })

  let fileErrorEmitted = false
  fileStream.on('error', (err: Error) => {
    if (fileErrorEmitted) return
    fileErrorEmitted = true
    process.stderr.write(`drovr: failed to write to ${logPath}: ${err.message}\n`)
    try {
      logger.remove(fileTransport)
    } catch {
      // Ignore transport removal errors
    }
    if (!verbose) {
      logger.add(
        new winston.transports.Console({
          stderrLevels: ['info', 'error', 'warn', 'debug', 'verbose', 'silly'],
          format: plainConsoleFormat,
        }),
      )
    }
  })

  return {
    startBegin(mode: 'fresh' | 'resume') {
      logger.info(`start.begin mode=${mode}`)
    },
    startComplete(mode: 'fresh' | 'resume', counts: DrovrLoggerCounts = DEFAULT_COUNTS) {
      logger.info(
        `start.complete mode=${mode} started=${counts.started} skipped=${counts.skipped} completed=${counts.completed} failed=${counts.failed}`,
      )
    },
    startFail(
      mode: 'fresh' | 'resume',
      counts: DrovrLoggerCounts = DEFAULT_COUNTS,
      error?: unknown,
    ) {
      const errMessage = formatErrorMessage(error)
      logger.error(
        `start.fail mode=${mode} started=${counts.started} skipped=${counts.skipped} completed=${counts.completed} failed=${counts.failed} error=${JSON.stringify(errMessage)}`,
      )
    },
    mapItemStart(name: string) {
      logger.info(`map.item.start name=${name}`)
    },
    mapItemSkip(name: string) {
      logger.info(`map.item.skip name=${name}`)
    },
    mapItemComplete(name: string) {
      logger.info(`map.item.complete name=${name}`)
    },
    mapItemFail(name: string, error?: unknown) {
      const errMessage = formatErrorMessage(error)
      logger.error(`map.item.fail name=${name} error=${JSON.stringify(errMessage)}`)
    },
    resourceLeaseRequest(resource: string, name: string) {
      logger.info(`resource.lease.request resource=${resource} name=${name}`)
    },
    resourceLeaseWait(resource: string, name: string) {
      logger.info(`resource.lease.wait resource=${resource} name=${name}`)
    },
    resourceLeaseAcquire(resource: string, name: string) {
      logger.info(`resource.lease.acquire resource=${resource} name=${name}`)
    },
    resourcePortProbe(
      resource: string,
      name: string,
      port: number,
      address: '127.0.0.1' | '::1',
      status: 'available' | 'in-use' | 'unavailable',
    ) {
      logger.info(
        `resource.port.probe resource=${resource} name=${name} port=${port} address=${address} status=${status}`,
      )
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        let resolved = false
        const done = () => {
          if (!resolved) {
            resolved = true
            resolve()
          }
        }
        logger.once('finish', () => {
          if (!fileStream.writableEnded && !fileStream.destroyed) {
            try {
              fileStream.end(() => done())
            } catch {
              done()
            }
          } else {
            done()
          }
        })
        logger.once('error', done)
        fileStream.once('error', done)
        logger.end()
        setTimeout(done, 1000).unref()
      })
    },
  }
}
