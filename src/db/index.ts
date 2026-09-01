import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import fs from 'node:fs'
import path from 'node:path'
import type { DB } from './schema.js'

const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  harness TEXT NOT NULL,
  current_version_id TEXT,
  pinned_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, type, name, rel_path)
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
-- SQLite treats NULLs as distinct in UNIQUE constraints, so global artifacts need their own index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_global_unique ON artifacts(type, name, rel_path) WHERE project_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_versions_artifact ON versions(artifact_id, created_at);
CREATE TABLE IF NOT EXISTS project_artifacts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_project_artifacts_artifact ON project_artifacts(artifact_id);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_path TEXT NOT NULL UNIQUE,
  project_path TEXT,
  title TEXT,
  started_at TEXT,
  ended_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  source_size INTEGER NOT NULL DEFAULT 0,
  source_mtime_ms INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT,
  tool_name TEXT,
  tool_use_id TEXT,
  timestamp TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_sessions_harness ON sessions(harness, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
`

/** Rebuild artifacts if it predates nullable project_id (global artifacts). */
function migrateArtifactsNullableProjectId(sqlite: SQLite.Database): void {
  const columns = sqlite.pragma(`table_info('artifacts')`) as Array<{ name: string; notnull: number }>
  const projectId = columns.find((c) => c.name === 'project_id')
  if (!projectId || projectId.notnull === 0) return
  sqlite.pragma('foreign_keys = OFF')
  sqlite.exec(`
    BEGIN;
    CREATE TABLE artifacts_new (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      harness TEXT NOT NULL,
      current_version_id TEXT,
      pinned_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, type, name, rel_path)
    );
    INSERT INTO artifacts_new SELECT id, project_id, type, name, rel_path, harness, current_version_id, pinned_version_id, created_at, updated_at FROM artifacts;
    DROP TABLE artifacts;
    ALTER TABLE artifacts_new RENAME TO artifacts;
    COMMIT;
  `)
  sqlite.pragma('foreign_keys = ON')
}

/** Drop the messages.raw column from older DBs: it duplicated every transcript and nothing read it. */
function migrateDropMessagesRaw(sqlite: SQLite.Database): void {
  const columns = sqlite.pragma(`table_info('messages')`) as Array<{ name: string }>
  if (columns.some((c) => c.name === 'raw')) sqlite.exec('ALTER TABLE messages DROP COLUMN raw')
}

/** Add model + token-usage columns to sessions/messages in DBs created before usage tracking. */
function migrateAddUsageColumns(sqlite: SQLite.Database): void {
  const usageColumns = ['model TEXT', 'input_tokens INTEGER', 'output_tokens INTEGER', 'cache_read_tokens INTEGER', 'cache_write_tokens INTEGER']
  for (const table of ['sessions', 'messages']) {
    const existing = new Set((sqlite.pragma(`table_info('${table}')`) as Array<{ name: string }>).map((c) => c.name))
    for (const column of usageColumns) {
      if (!existing.has(column.split(' ')[0])) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`)
    }
  }
}

export function openDb(dbPath: string): Kysely<DB> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const sqlite = new SQLite(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  migrateArtifactsNullableProjectId(sqlite)
  migrateDropMessagesRaw(sqlite)
  sqlite.exec(DDL)
  migrateAddUsageColumns(sqlite)
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })
}
