// Database-backed session stores (goose sessions.db, hermes state.db): discovery via a fake
// $HOME, import, unchanged-skip, and re-import after the store advances. Ported from
// scripts/smoke-db-sessions.mts; steps build on each other, so they run in order.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SQLite from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from '../src/db/schema.js'
import { openDb } from '../src/db/index.js'
import { importDbSessions } from '../src/core/sessions.js'

let tmp: string
let home: string
let db: Kysely<DB>
let goose: SQLite.Database
let hermes: SQLite.Database
let gmsg: SQLite.Statement

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-dbsessions-'))
  home = path.join(tmp, 'home')

  // goose ≥1.10: ~/.local/share/goose/sessions/sessions.db
  const gooseDir = path.join(home, '.local', 'share', 'goose', 'sessions')
  fs.mkdirSync(gooseDir, { recursive: true })
  goose = new SQLite(path.join(gooseDir, 'sessions.db'))
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
  gmsg = goose.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?,?,?,?)')
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
  hermes = new SQLite(path.join(home, '.hermes', 'state.db'))
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

  db = openDb(path.join(tmp, 'daiko.sqlite'))
})
afterAll(async () => {
  goose.close()
  hermes.close()
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('database-backed session import', () => {
  it('imports goose and hermes sessions with normalized messages and usage', async () => {
    expect(await importDbSessions(db, {}, home)).toEqual({ imported: 2, updated: 0, skipped: 0, failed: 0 })

    const rows = await db.selectFrom('sessions').selectAll().orderBy('harness').execute()
    const byHarness = Object.fromEntries(rows.map((r) => [r.harness, r]))
    expect(byHarness.goose.external_id).toBe('g1')
    expect(byHarness.goose.project_path).toBe('/tmp/repo')
    expect(byHarness.goose.model).toBe('claude-opus-4-6')
    expect(byHarness.goose.input_tokens).toBe(100)
    // 4 = user text + assistant text + tool_use + tool_result.
    expect(byHarness.goose.message_count).toBe(4)
    expect(byHarness.hermes.title).toBe('Test')
    expect(byHarness.hermes.model).toBe('hermes-4')
    expect(byHarness.hermes.cache_read_tokens).toBe(800)
    // 5 = user + thinking + text + tool_use + tool_result; the inactive row is excluded.
    expect(byHarness.hermes.message_count).toBe(5)
    const kinds = await db
      .selectFrom('messages')
      .select('kind')
      .where('session_id', '=', byHarness.hermes.id)
      .orderBy('seq')
      .execute()
    expect(kinds.map((k) => k.kind)).toEqual(['text', 'thinking', 'text', 'tool_use', 'tool_result'])
  })

  it('skips everything when nothing changed', async () => {
    expect(await importDbSessions(db, {}, home)).toEqual({ imported: 0, updated: 0, skipped: 2, failed: 0 })
  })

  it('re-imports only the session whose store advanced', async () => {
    gmsg.run('g1', 'assistant', JSON.stringify([{ type: 'text', text: 'more' }]), 1745571160)
    goose.prepare("UPDATE sessions SET updated_at = '2026-05-06 18:05:00' WHERE id = 'g1'").run()
    expect(await importDbSessions(db, {}, home)).toEqual({ imported: 0, updated: 1, skipped: 1, failed: 0 })
    const updated = await db.selectFrom('sessions').select('message_count').where('harness', '=', 'goose').executeTakeFirstOrThrow()
    expect(updated.message_count).toBe(5)
  })
})
