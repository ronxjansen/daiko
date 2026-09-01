import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SQLite from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-migrate-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A DB as created before canonical artifacts: harness + rel_path were part of identity. */
function createLegacyDb(file: string): SQLite.Database {
  const sqlite = new SQLite(file)
  sqlite.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL, name TEXT NOT NULL, rel_path TEXT NOT NULL, harness TEXT NOT NULL,
      current_version_id TEXT, pinned_version_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, type, name, rel_path)
    );
    CREATE TABLE versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      hash TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE project_artifacts (
      project_id TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, artifact_id)
    );
  `)
  return sqlite
}

describe('openDb migration to canonical artifacts', () => {
  it('merges per-harness rows into one artifact, keeping all versions and seeding targets', async () => {
    const file = path.join(tmp, 'daiko.sqlite')
    const legacy = createLegacyDb(file)
    legacy
      .prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)')
      .run('p1', 'proj', '/repo', '2024-01-01', '2024-01-01')
    const insertArtifact = legacy.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertVersion = legacy.prepare('INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)')

    // The same skill tracked twice, once per harness. a1 is older (survivor); a2 was updated last.
    insertArtifact.run('a1', 'p1', 'skill', 'demo', '.claude/skills/demo/SKILL.md', 'claude', 'v1', null, '2024-01-01', '2024-01-01')
    insertVersion.run('v1', 'a1', 'h1', 'old body', 'add', '2024-01-01')
    insertArtifact.run('a2', 'p1', 'skill', 'demo', '.codex/skills/demo/SKILL.md', 'codex', 'v2', null, '2024-02-01', '2024-03-01')
    insertVersion.run('v2', 'a2', 'h2', 'new body', 'add', '2024-03-01')

    // Instruction files kept their on-disk names; they all become the canonical 'instructions'.
    insertArtifact.run('b1', 'p1', 'agent_md', 'CLAUDE.md', 'CLAUDE.md', 'claude', null, null, '2024-01-01', '2024-01-01')
    insertArtifact.run('b2', 'p1', 'agent_md', 'AGENTS.md', 'AGENTS.md', 'codex', null, null, '2024-01-02', '2024-01-02')

    // A codex global server used to render into .mcp.json for want of anywhere else.
    insertArtifact.run('c1', null, 'mcp_server', 'srv', '~/.codex/config.toml', 'codex', null, null, '2024-01-01', '2024-01-01')
    legacy.close()

    const db = openDb(file)
    try {
      const skill = await db.selectFrom('artifacts').selectAll().where('type', '=', 'skill').executeTakeFirstOrThrow()
      expect(skill.id).toBe('a1') // oldest row survives
      expect(skill.name).toBe('demo')
      expect(skill.origin_harness).toBe('claude')
      expect(skill.origin_path).toBe('.claude/skills/demo/SKILL.md')
      expect(skill.current_version_id).toBe('v2') // most recently updated content is current

      // Nothing discarded: the merged-away revision stays in the survivor's history.
      const versions = await db.selectFrom('versions').select(['id', 'artifact_id']).orderBy('id').execute()
      expect(versions).toEqual([
        { id: 'v1', artifact_id: 'a1' },
        { id: 'v2', artifact_id: 'a1' },
      ])

      const targets = await db
        .selectFrom('artifact_targets')
        .select('harness')
        .where('artifact_id', '=', 'a1')
        .orderBy('harness')
        .execute()
      expect(targets.map((t) => t.harness)).toEqual(['claude', 'codex'])

      const agents = await db.selectFrom('artifacts').selectAll().where('type', '=', 'agent_md').execute()
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('instructions')

      // The codex global server keeps the claude target it was actually written to
      // (.mcp.json belongs to claude), so an existing working tree syncs unchanged.
      const srvTargets = await db
        .selectFrom('artifact_targets')
        .select('harness')
        .where('artifact_id', '=', 'c1')
        .orderBy('harness')
        .execute()
      expect(srvTargets.map((t) => t.harness)).toEqual(['claude', 'codex'])
    } finally {
      await db.destroy()
    }
  })

  it('opens a migrated DB again without re-running the migration', async () => {
    const file = path.join(tmp, 'daiko.sqlite')
    const legacy = createLegacyDb(file)
    legacy
      .prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('a1', null, 'mcp_server', 'srv', '~/.claude.json', 'claude', null, null, '2024-01-01', '2024-01-01')
    legacy.close()

    const first = openDb(file)
    await first.destroy()
    const second = openDb(file) // must be a no-op, not a crash or a duplicate merge
    try {
      const rows = await second.selectFrom('artifacts').selectAll().execute()
      expect(rows).toHaveLength(1)
      expect(rows[0].origin_harness).toBe('claude')
    } finally {
      await second.destroy()
    }
  })
})
