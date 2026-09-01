// Smoke test for canonical artifacts: one stored object per logical skill / instruction
// document / MCP server, rendered into every harness that targets it. Run: npm test
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SQLite from 'better-sqlite3'
import { openDb } from '../src/db/index.js'
import { addGlobalMcpServers, addProject, attachArtifact, setTargets, syncProject, targetsOf } from '../src/core/store.js'
import { renderPaths } from '../src/core/render.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-targets-'))
const source = path.join(tmp, 'source')
const target = path.join(tmp, 'target')
const home = path.join(tmp, 'home')
for (const dir of [source, target, home]) fs.mkdirSync(dir, { recursive: true })

const write = (root: string, rel: string, content: string) => {
  const file = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, ...rel.split('/')))

// The same skill vendored into two harnesses, and the same instructions under two names.
write(source, '.claude/skills/shared/SKILL.md', 'shared v1\n')
write(source, '.codex/skills/shared/SKILL.md', 'shared v1\n')
write(source, 'CLAUDE.md', '# House rules\n')
write(source, 'AGENTS.md', '# House rules\n')

const realHomedir = os.homedir
;(os as any).homedir = () => home

const db = openDb(path.join(tmp, 'daiko.sqlite'))

try {
  const added = await addProject(db, source)
  assert.deepStrictEqual(added.conflicts, [], `identical copies should not conflict: ${JSON.stringify(added.conflicts)}`)

  // 1. Two harness copies of one skill are one artifact deployed to both.
  const skills = await db.selectFrom('artifacts').selectAll().where('type', '=', 'skill').execute()
  assert.strictEqual(skills.length, 1, `expected one canonical skill, got ${skills.map((s) => s.name).join(', ')}`)
  assert.deepStrictEqual(await targetsOf(db, skills[0].id), ['claude', 'codex'], 'both harnesses should be targets')

  // 2. CLAUDE.md and AGENTS.md are the same logical document, stored once.
  const instructions = await db.selectFrom('artifacts').selectAll().where('type', '=', 'agent_md').execute()
  assert.strictEqual(instructions.length, 1, `expected one instructions artifact, got ${instructions.length}`)
  assert.strictEqual(instructions[0].name, 'instructions')
  assert.deepStrictEqual(await targetsOf(db, instructions[0].id), ['claude', 'codex', 'generic'])
  // Codex and Generic both read AGENTS.md: one file serves both targets.
  assert.deepStrictEqual(
    renderPaths(instructions[0], ['claude', 'codex', 'generic']).map((r) => r.relPath),
    ['CLAUDE.md', 'AGENTS.md'],
  )

  // 3. Syncing into a fresh repo materializes every target, from one stored copy.
  await addProject(db, target)
  const project = await db.selectFrom('projects').selectAll().where('root_path', '=', target).executeTakeFirstOrThrow()
  await attachArtifact(db, project.id, skills[0].id)
  await attachArtifact(db, project.id, instructions[0].id)
  assert.strictEqual(read(target, '.claude/skills/shared/SKILL.md'), 'shared v1\n')
  assert.strictEqual(read(target, '.codex/skills/shared/SKILL.md'), 'shared v1\n', 'skill not rendered into its second target')
  assert.strictEqual(read(target, 'CLAUDE.md'), '# House rules\n')
  assert.strictEqual(read(target, 'AGENTS.md'), '# House rules\n')

  // 4. Adding a target renders the same stored artifact into another harness's layout.
  await setTargets(db, skills[0].id, ['claude', 'codex', 'cursor'])
  const retargeted = await syncProject(db, target)
  assert.ok(
    retargeted.written.includes('.cursor/skills/shared/SKILL.md'),
    `new target not written: ${JSON.stringify(retargeted.written)}`,
  )
  assert.strictEqual(read(target, '.cursor/skills/shared/SKILL.md'), 'shared v1\n')

  // 5. One copy edited: that copy is the change, the others are stale renderings of the old version.
  write(source, '.codex/skills/shared/SKILL.md', 'shared v2\n')
  const oneEdit = await addProject(db, source)
  assert.strictEqual(oneEdit.updated, 1, 'a single-copy edit should version the artifact')
  assert.deepStrictEqual(oneEdit.conflicts, [], 'a single-copy edit is not a conflict')
  await syncProject(db, target, { force: true })
  assert.strictEqual(read(target, '.claude/skills/shared/SKILL.md'), 'shared v2\n', 'edit did not propagate across harnesses')

  // 6. Both copies edited differently: no honest winner, so the store keeps its own version.
  write(source, '.claude/skills/shared/SKILL.md', 'claude says A\n')
  write(source, '.codex/skills/shared/SKILL.md', 'codex says B\n')
  const clash = await addProject(db, source)
  assert.strictEqual(clash.updated, 0, 'a conflict must not silently pick a copy')
  assert.deepStrictEqual(
    clash.conflicts.map((c) => [c.name, c.variants.map((v) => v.harnesses.join('+'))]),
    [['shared', ['claude', 'codex']]],
  )
  const stillV2 = await db
    .selectFrom('versions')
    .selectAll()
    .where('id', '=', (await db.selectFrom('artifacts').selectAll().where('type', '=', 'skill').executeTakeFirstOrThrow()).current_version_id!)
    .executeTakeFirstOrThrow()
  assert.strictEqual(stillV2.content, 'shared v2\n', 'conflict overwrote the stored version')

  // 7. A target that cannot hold the type is reported, never written to someone else's file.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.codexonly]\ncommand = "x"\n')
  await addGlobalMcpServers(db)
  const server = await db.selectFrom('artifacts').selectAll().where('name', '=', 'codexonly').executeTakeFirstOrThrow()
  assert.deepStrictEqual(await targetsOf(db, server.id), ['codex'])
  const noTarget = await attachArtifact(db, project.id, server.id)
  assert.deepStrictEqual(
    noTarget.skipped.filter((s) => s.reason === 'no-target').map((s) => [s.artifact, s.targets]),
    [['codexonly', ['codex']]],
    'a server with no hostable target should be reported',
  )
  assert.ok(!exists(target, '.mcp.json'), 'a Codex-only server was written into Claude’s config file')

  // ...and pointing it at a harness that can hold it deploys it, with no rescan needed.
  await setTargets(db, server.id, ['claude'])
  await syncProject(db, target)
  assert.ok(JSON.parse(read(target, '.mcp.json')).mcpServers.codexonly, 'retargeted server not deployed')

  console.log('all canonical artifact smoke tests passed')
} finally {
  ;(os as any).homedir = realHomedir
  await db.destroy()
}

// 8. A store written before artifacts were canonical migrates without losing anything.
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-legacy-'))
const legacyPath = path.join(legacyDir, 'legacy.sqlite')
{
  const raw = new SQLite(legacyPath)
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL, name TEXT NOT NULL, rel_path TEXT NOT NULL, harness TEXT NOT NULL,
      current_version_id TEXT, pinned_version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, type, name, rel_path)
    );
    CREATE TABLE versions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE, hash TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE project_artifacts (project_id TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (project_id, artifact_id));
    INSERT INTO projects VALUES ('p1', 'repo', '/tmp/repo', '2024-01-01', '2024-01-01');
    -- The same instructions under two harness filenames: two rows before, one object after.
    INSERT INTO artifacts VALUES ('a-claude', 'p1', 'agent_md', 'CLAUDE.md', 'CLAUDE.md', 'claude', 'v-claude', NULL, '2024-01-01', '2024-01-01');
    INSERT INTO artifacts VALUES ('a-agents', 'p1', 'agent_md', 'AGENTS.md', 'AGENTS.md', 'generic', 'v-agents', NULL, '2024-01-02', '2024-01-03');
    -- A Codex global server, which used to be rendered into .mcp.json for want of anywhere else.
    INSERT INTO artifacts VALUES ('a-srv', NULL, 'mcp_server', 'srv', '~/.codex/config.toml', 'codex', 'v-srv', NULL, '2024-01-01', '2024-01-01');
    INSERT INTO versions VALUES ('v-claude', 'a-claude', 'h1', 'claude rules', 'add', '2024-01-01');
    INSERT INTO versions VALUES ('v-agents', 'a-agents', 'h2', 'agents rules', 'add', '2024-01-03');
    INSERT INTO versions VALUES ('v-srv', 'a-srv', 'h3', '{"command":"x"}', 'add', '2024-01-01');
    INSERT INTO project_artifacts VALUES ('p1', 'a-srv', '2024-01-01');
  `)
  raw.close()
}

const migrated = openDb(legacyPath)
try {
  const rows = await migrated.selectFrom('artifacts').selectAll().where('type', '=', 'agent_md').execute()
  assert.strictEqual(rows.length, 1, 'the two instruction rows should have merged into one artifact')
  assert.strictEqual(rows[0].name, 'instructions')
  assert.strictEqual(rows[0].id, 'a-claude', 'the oldest row should survive a merge')
  assert.strictEqual(rows[0].origin_harness, 'claude')
  assert.strictEqual(rows[0].origin_path, 'CLAUDE.md')
  assert.strictEqual(rows[0].current_version_id, 'v-agents', 'the most recently updated row should win')
  // Nothing is discarded: the merged-away revision stays in the survivor's history.
  const history = await migrated.selectFrom('versions').select('id').where('artifact_id', '=', 'a-claude').execute()
  assert.deepStrictEqual(history.map((v) => v.id).sort(), ['v-agents', 'v-claude'])
  assert.deepStrictEqual(await targetsOf(migrated, 'a-claude'), ['claude', 'generic'], 'targets not seeded from both rows')
  // The Codex server kept the Claude target it was actually being written to, so sync is a no-op.
  assert.deepStrictEqual(await targetsOf(migrated, 'a-srv'), ['claude', 'codex'])

  console.log('all migration smoke tests passed')
} finally {
  await migrated.destroy()
  fs.rmSync(legacyDir, { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
}
