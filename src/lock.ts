import { DatabaseSync } from 'node:sqlite'

export type CheckoutLock = {
  release(): void
}

export function acquireCheckoutLock(lockPath: string): CheckoutLock {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(lockPath)
    db.exec('PRAGMA busy_timeout = 0;')
    db.exec('PRAGMA locking_mode = EXCLUSIVE;')
    db.exec('BEGIN EXCLUSIVE;')
  } catch (error) {
    if (db) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('locked') || message.includes('busy') || message.includes('SQLITE_BUSY')) {
      throw new Error('another drovr process is already running in this checkout')
    }
    throw error
  }

  return {
    release() {
      try {
        db?.close()
      } catch {
        // ignore
      }
    },
  }
}
