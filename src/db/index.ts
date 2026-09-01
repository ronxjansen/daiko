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
  origin_harness TEXT NOT NULL,
  origin_path TEXT NOT NULL,
  current_version_id TEXT,
  pinned_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, type, name)
);
CREATE TABLE IF NOT EXISTS artifact_targets (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  harness TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, harness)
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  content TEXT NOT NULL,
  files TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
-- SQLite treats NULLs as distinct in UNIQUE constraints, so global artifacts need their own index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_global_unique ON artifacts(type, name) WHERE project_id IS NULL;
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

/**
 * Project MCP config paths as they were when artifacts still carried a harness and a path.
 * Frozen here on purpose: the migration must reproduce what old rows actually rendered to,
 * not what the current registry would choose. Harnesses with no project MCP location fell
 * back to .mcp.json, which Claude owns.
 */
const LEGACY_PROJECT_MCP: Record<string, string> = { claude: '.mcp.json', cursor: '.cursor/mcp.json' }

interface LegacyArtifact {
  id: string
  project_id: string | null
  type: string
  name: string
  rel_path: string
  harness: string
  current_version_id: string | null
  pinned_version_id: string | null
  created_at: string
  updated_at: string
}

/**
 * Make artifacts canonical: drop harness/rel_path from their identity, record where each
 * one came from as provenance, and move deployment into artifact_targets.
 *
 * Rows that only differed by harness or path are the same logical object, so they are
 * merged: the oldest row survives and absorbs the others' versions, project links and
 * targets, with the most recently updated row's content becoming current. Nothing is
 * discarded — a merged-away revision stays in the survivor's history. Targets are seeded
 * from what each row actually wrote before, so an existing working tree syncs unchanged.
 */
function migrateCanonicalArtifacts(sqlite: SQLite.Database): void {
  const columns = sqlite.pragma(`table_info('artifacts')`) as Array<{ name: string }>
  if (columns.length === 0) return // fresh DB: the DDL below creates the canonical shape
  const names = new Set(columns.map((c) => c.name))
  if (names.has('origin_harness') || !names.has('harness')) return

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS artifact_targets (
      artifact_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, harness)
    );
  `)

  const rows = sqlite.prepare('SELECT * FROM artifacts').all() as LegacyArtifact[]
  const addTarget = sqlite.prepare('INSERT OR IGNORE INTO artifact_targets (artifact_id, harness, created_at) VALUES (?, ?, ?)')
  const canonicalName = (a: LegacyArtifact) => (a.type === 'agent_md' ? 'instructions' : a.name)

  sqlite.pragma('foreign_keys = OFF')
  const migrate = sqlite.transaction(() => {
    for (const a of rows) {
      addTarget.run(a.id, a.harness, a.created_at)
      // A global MCP server used to be written to its harness's project config, or to
      // .mcp.json when it had none: keep that harness as a target so sync is a no-op.
      if (a.type === 'mcp_server' && a.rel_path.startsWith('~')) {
        const rendered = LEGACY_PROJECT_MCP[a.harness] ?? '.mcp.json'
        const owner = Object.keys(LEGACY_PROJECT_MCP).find((h) => LEGACY_PROJECT_MCP[h] === rendered)
        if (owner) addTarget.run(a.id, owner, a.created_at)
      }
    }

    const groups = new Map<string, LegacyArtifact[]>()
    for (const a of rows) {
      const key = `${a.project_id ?? ''}\u0000${a.type}\u0000${canonicalName(a)}`
      groups.set(key, [...(groups.get(key) ?? []), a])
    }

    for (const group of groups.values()) {
      const byAge = [...group].sort((x, y) => (x.created_at === y.created_at ? x.id.localeCompare(y.id) : x.created_at < y.created_at ? -1 : 1))
      const survivor = byAge[0]
      const newest = [...group].sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1))[0]
      const losers = byAge.slice(1).map((a) => a.id)

      if (losers.length > 0) {
        const list = losers.map(() => '?').join(',')
        sqlite.prepare(`UPDATE versions SET artifact_id = ? WHERE artifact_id IN (${list})`).run(survivor.id, ...losers)
        sqlite.prepare(`UPDATE OR IGNORE project_artifacts SET artifact_id = ? WHERE artifact_id IN (${list})`).run(survivor.id, ...losers)
        sqlite.prepare(`DELETE FROM project_artifacts WHERE artifact_id IN (${list})`).run(...losers)
        sqlite.prepare(`UPDATE OR IGNORE artifact_targets SET artifact_id = ? WHERE artifact_id IN (${list})`).run(survivor.id, ...losers)
        sqlite.prepare(`DELETE FROM artifact_targets WHERE artifact_id IN (${list})`).run(...losers)
        sqlite.prepare(`DELETE FROM artifacts WHERE id IN (${list})`).run(...losers)
      }
      // A merged link from the artifact's own project is not a share; sync writes it anyway.
      if (survivor.project_id) {
        sqlite.prepare('DELETE FROM project_artifacts WHERE artifact_id = ? AND project_id = ?').run(survivor.id, survivor.project_id)
      }
      sqlite
        .prepare('UPDATE artifacts SET name = ?, current_version_id = ?, pinned_version_id = ?, updated_at = ? WHERE id = ?')
        .run(
          canonicalName(survivor),
          newest.current_version_id,
          group.map((a) => a.pinned_version_id).find((v) => v !== null) ?? null,
          newest.updated_at,
          survivor.id,
        )
    }

    sqlite.exec(`
      CREATE TABLE artifacts_canonical (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        origin_harness TEXT NOT NULL,
        origin_path TEXT NOT NULL,
        current_version_id TEXT,
        pinned_version_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, type, name)
      );
      INSERT INTO artifacts_canonical
        SELECT id, project_id, type, name, harness, rel_path, current_version_id, pinned_version_id, created_at, updated_at FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_canonical RENAME TO artifacts;
    `)
  })
  migrate()
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

/** Add versions.files (a skill's bundled scripts/references/assets) to DBs created before skill bundles. */
function migrateAddVersionFiles(sqlite: SQLite.Database): void {
  const columns = sqlite.pragma(`table_info('versions')`) as Array<{ name: string }>
  if (columns.length > 0 && !columns.some((c) => c.name === 'files')) {
    sqlite.exec('ALTER TABLE versions ADD COLUMN files TEXT')
  }
}

export function openDb(dbPath: string): Kysely<DB> {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const sqlite = new SQLite(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  migrateArtifactsNullableProjectId(sqlite)
  migrateDropMessagesRaw(sqlite)
  migrateCanonicalArtifacts(sqlite)
  sqlite.exec(DDL)
  migrateAddUsageColumns(sqlite)
  migrateAddVersionFiles(sqlite)
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })
}
