/**
 * Database-backed session stores (goose sessions.db, hermes state.db): discovery via a
 * fake $HOME, import, unchanged-skip, and re-import after the store advances.
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SQLite from 'better-sqlite3'
import { openDb } from '../src/db/index.js'
import { importDbSessions } from '../src/core/sessions.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-smoke-dbsessions-'))
const home = path.join(tmp, 'home')

// goose ≥1.10: ~/.local/share/goose/sessions/sessions.db
const gooseDir = path.join(home, '.local', 'share', 'goose', 'sessions')
fs.mkdirSync(gooseDir, { recursive: true })
const goose = new SQLite(path.join(gooseDir, 'sessions.db'))
goose.exec(`
  CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT DEFAULT '', description TEXT DEFAULT '',
    working_dir TEXT NOT NULL, created_at TIMESTAMP, updated_at TIMESTAMP,
    total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    provider_name TEXT, model_config_json TEXT);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL);
`)
goose
  .prepare("INSERT INTO sessions VALUES ('g1', 'Greeting', '', '/tmp/repo', '2026-05-06 18:02:43', '2026-05-06 18:03:03', 130, 100, 30, 'anthropic', '{\"model_name\":\"claude-opus-4-6\"}')")
  .run()
const gmsg = goose.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?,?,?,?)')
gmsg.run('g1', 'user', JSON.stringify([{ type: 'text', text: 'hoi' }]), 1745571153)
gmsg.run(
  'g1',
  'assistant',
  JSON.stringify([
    { type: 'text', text: 'hello' },
    { type: 'toolRequest', id: 't1', toolCall: { status: 'success', value: { name: 'shell', arguments: { cmd: 'ls' } } } },
  ]),
  1745571154,
)
gmsg.run('g1', 'user', JSON.stringify([{ type: 'toolResponse', id: 't1', toolResult: { status: 'success', value: [{ type: 'text', text: 'ok' }] } }]), 1745571155)

// hermes: ~/.hermes/state.db
fs.mkdirSync(path.join(home, '.hermes'), { recursive: true })
const hermes = new SQLite(path.join(home, '.hermes', 'state.db'))
hermes.exec(`
  CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL,
    ended_at REAL, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, cwd TEXT, title TEXT, display_name TEXT);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
    reasoning TEXT, reasoning_content TEXT, active INTEGER NOT NULL DEFAULT 1);
`)
hermes
  .prepare("INSERT INTO sessions VALUES ('h1', 'cli', 'hermes-4', 1756700000, 1756700100, 1200, 340, 800, 0, '/tmp/repo', 'Test', NULL)")
  .run()
const hmsg = hermes.prepare('INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning_content, active) VALUES (?,?,?,?,?,?,?,?,?)')
hmsg.run('h1', 'user', 'hello', null, null, null, 1756700001, null, 1)
hmsg.run('h1', 'assistant', 'hi', null, JSON.stringify([{ id: 'c1', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }]), null, 1756700002, 'pondering', 1)
hmsg.run('h1', 'tool', 'ok', 'c1', null, 'bash', 1756700003, null, 1)
hmsg.run('h1', 'assistant', 'compacted away', null, null, null, 1756700004, null, 0)

const db = openDb(path.join(tmp, 'daiko.sqlite'))
try {
  // 1. First import picks up both stores.
  let s = await importDbSessions(db, {}, home)
  assert.deepStrictEqual(s, { imported: 2, updated: 0, skipped: 0, failed: 0 }, 'first import')

  const rows = await db.selectFrom('sessions').selectAll().orderBy('harness').execute()
  const byHarness = Object.fromEntries(rows.map((r) => [r.harness, r]))
  assert.equal(byHarness.goose.external_id, 'g1')
  assert.equal(byHarness.goose.project_path, '/tmp/repo')
  assert.equal(byHarness.goose.model, 'claude-opus-4-6')
  assert.equal(byHarness.goose.input_tokens, 100)
  // 4 = user text + assistant text + tool_use + tool_result.
  assert.equal(byHarness.goose.message_count, 4)
  assert.equal(byHarness.hermes.title, 'Test')
  assert.equal(byHarness.hermes.model, 'hermes-4')
  assert.equal(byHarness.hermes.cache_read_tokens, 800)
  // 5 = user + thinking + text + tool_use + tool_result; the inactive row is excluded.
  assert.equal(byHarness.hermes.message_count, 5)
  const kinds = await db
    .selectFrom('messages')
    .select('kind')
    .where('session_id', '=', byHarness.hermes.id)
    .orderBy('seq')
    .execute()
  assert.deepStrictEqual(kinds.map((k) => k.kind), ['text', 'thinking', 'text', 'tool_use', 'tool_result'])

  // 2. Nothing changed: everything skips.
  s = await importDbSessions(db, {}, home)
  assert.deepStrictEqual(s, { imported: 0, updated: 0, skipped: 2, failed: 0 }, 'unchanged skip')

  // 3. The goose session grows a message: only it re-imports.
  gmsg.run('g1', 'assistant', JSON.stringify([{ type: 'text', text: 'more' }]), 1745571160)
  goose.prepare("UPDATE sessions SET updated_at = '2026-05-06 18:05:00' WHERE id = 'g1'").run()
  s = await importDbSessions(db, {}, home)
  assert.deepStrictEqual(s, { imported: 0, updated: 1, skipped: 1, failed: 0 }, 'update after change')
  const updated = await db.selectFrom('sessions').select('message_count').where('harness', '=', 'goose').executeTakeFirstOrThrow()
  assert.equal(updated.message_count, 5)

  console.log('smoke-db-sessions: OK')
} finally {
  goose.close()
  hermes.close()
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
}
