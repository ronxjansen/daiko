// Token/model extraction for the codex and gemini parsers, the usage-column migration, and
// the /api/sessions/usage endpoint. Ported from scripts/smoke-usage.mts (the claude parser
// and rollup are covered in claude-parser.test.ts and sessions.test.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SQLite from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from '../src/db/schema.js'
import { openDb } from '../src/db/index.js'
import { importSessionFile } from '../src/core/sessions.js'

let tmp: string
let db: Kysely<DB>
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-usage-'))
  db = openDb(path.join(tmp, 'daiko.sqlite'))
})
afterEach(async () => {
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const writeJsonl = (name: string, entries: unknown[]): string => {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'))
  return file
}

const usageOf = (s: { input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null }) =>
  [s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_write_tokens]

describe('codex sessions', () => {
  it('uses the last cumulative token snapshot, with the cached share subtracted from input', async () => {
    const file = writeJsonl('codex-rollout.jsonl', [
      { timestamp: '2026-09-01T11:00:00Z', type: 'session_meta', payload: { id: 'codex-1', cwd: '/repo' } },
      { timestamp: '2026-09-01T11:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      {
        timestamp: '2026-09-01T11:00:02Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      },
      {
        timestamp: '2026-09-01T11:00:03Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 40, total_tokens: 540 } } },
      },
      { timestamp: '2026-09-01T11:00:04Z', type: 'event_msg', payload: { type: 'token_count', info: null } },
      {
        timestamp: '2026-09-01T11:00:05Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, total_tokens: 1100 } } },
      },
    ])

    expect(await importSessionFile(db, { harness: 'codex', file })).toBe('imported')
    const session = await db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow()
    expect(session.model).toBe('gpt-5.6-sol')
    expect(usageOf(session)).toEqual([400, 100, 600, 0])
  })
})

describe('gemini sessions', () => {
  it('excludes cached tokens from input and bills thoughts as output', async () => {
    const file = path.join(tmp, 'gemini-session.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        sessionId: 'gem-1',
        startTime: '2026-09-01T12:00:00Z',
        lastUpdated: '2026-09-01T12:05:00Z',
        messages: [
          { type: 'user', timestamp: '2026-09-01T12:00:00Z', content: 'hi' },
          {
            type: 'gemini',
            timestamp: '2026-09-01T12:00:10Z',
            content: 'hello',
            model: 'gemini-3-pro-preview',
            tokens: { input: 7505, output: 10, cached: 2995, thoughts: 153, tool: 0, total: 7668 },
          },
        ],
      }),
    )

    expect(await importSessionFile(db, { harness: 'gemini', file })).toBe('imported')
    const session = await db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow()
    expect(session.model).toBe('gemini-3-pro-preview')
    expect(usageOf(session)).toEqual([4510, 163, 2995, 0])
  })
})

describe('usage-column migration', () => {
  it('restores the model/token columns on a DB created before usage tracking', async () => {
    const file = writeJsonl('claude.jsonl', [
      { type: 'user', cwd: '/repo', timestamp: '2026-09-01T10:00:00Z', message: { content: 'hi' } },
      {
        type: 'assistant',
        timestamp: '2026-09-01T10:00:05Z',
        message: { id: 'm1', model: 'claude-fable-5', usage: { input_tokens: 5, output_tokens: 50 }, content: [{ type: 'text', text: 'hello' }] },
      },
    ])
    await importSessionFile(db, { harness: 'claude', file })
    await db.destroy()

    const dbFile = path.join(tmp, 'daiko.sqlite')
    const raw = new SQLite(dbFile)
    for (const table of ['sessions', 'messages']) {
      for (const col of ['model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
        raw.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`)
      }
    }
    raw.close()

    db = openDb(dbFile) // afterEach destroys this reopened handle
    const row = await db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow()
    expect(row.model).toBeNull() // columns exist again and default to null
  })
})

describe('/api/sessions/usage', () => {
  it('buckets tokens per hour per harness, using session totals when messages carry none', async () => {
    const { createApp } = await import('../src/server/index.js')
    const nowIso = new Date().toISOString() // now-based so the 30-day window never ages it out
    const claudeFile = writeJsonl('claude-now.jsonl', [
      { type: 'user', cwd: '/repo', timestamp: nowIso, message: { content: 'hi' } },
      {
        type: 'assistant',
        timestamp: nowIso,
        message: {
          id: 'msg_1',
          model: 'claude-fable-5',
          usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 50 },
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    ])
    const codexFile = writeJsonl('codex-now.jsonl', [
      { timestamp: nowIso, type: 'session_meta', payload: { id: 'codex-now', cwd: '/repo' } },
      {
        timestamp: nowIso,
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100 } } },
      },
      {
        timestamp: nowIso,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      },
    ])
    expect(await importSessionFile(db, { harness: 'claude', file: claudeFile })).toBe('imported')
    expect(await importSessionFile(db, { harness: 'codex', file: codexFile })).toBe('imported')

    const res = await createApp(db).request('/api/sessions/usage')
    expect(res.status).toBe(200)
    const buckets = (await res.json()) as Array<{ t: number; harness: string; tokens: number }>
    const hour = Math.floor(Date.parse(nowIso) / 3_600_000) * 3_600_000
    const byHarness = new Map(buckets.map((b) => [b.harness, b]))
    expect(byHarness.get('claude')).toEqual({ t: hour, harness: 'claude', tokens: 355 })
    expect(byHarness.get('codex')).toEqual({ t: hour, harness: 'codex', tokens: 1100 })
  })
})
