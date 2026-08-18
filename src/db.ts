import { DatabaseSync } from 'node:sqlite'

const V1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS resources (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('capacity', 'port')),
  capacity INTEGER NOT NULL CHECK(capacity >= 1)
);

CREATE TABLE IF NOT EXISTS resource_ports (
  resource_name TEXT NOT NULL REFERENCES resources(name) ON DELETE CASCADE,
  port INTEGER NOT NULL CHECK(port >= 1 AND port <= 65535),
  PRIMARY KEY (resource_name, port),
  UNIQUE (port)
);

CREATE TABLE IF NOT EXISTS leases (
  resource_name TEXT NOT NULL REFERENCES resources(name) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (resource_name, name)
);

CREATE TABLE IF NOT EXISTS claims (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (repo, issue_number)
);

CREATE TABLE IF NOT EXISTS completions (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS worktree_setups (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending', 'complete'))
);

PRAGMA user_version = 1;
`

export interface OpenProjectDatabaseOptions {
  mode?: 'fresh' | 'resume'
}

export function openProjectDatabase(
  dbPath: string,
  options: OpenProjectDatabaseOptions = {},
): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')

  const userVersionRow = db.prepare('PRAGMA user_version;').get() as { user_version: number }
  const userVersion = userVersionRow.user_version

  if (options.mode === 'resume') {
    if (userVersion !== 1) {
      db.close()
      throw new Error(`unsupported database version: ${userVersion}`)
    }
  } else {
    if (userVersion === 0) {
      db.exec(V1_SCHEMA_SQL)
    } else if (userVersion !== 1) {
      db.close()
      throw new Error(`unsupported database version: ${userVersion}`)
    }
  }

  return db
}
