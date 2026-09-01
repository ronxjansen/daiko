// Smoke test for token/model extraction across harness parsers + import. Run: npm test
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import SQLite from 'better-sqlite3'
import { openDb } from '../src/db/index.js'
import { importSessionFile } from '../src/core/sessions.js'
import { estimateCostUsd } from '../src/core/pricing.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-usage-'))
const dbFile = path.join(tmp, 'daiko.sqlite')

// -- fixtures ----------------------------------------------------------------

// Claude Code: one API response split over two JSONL lines (same message.id),
// each repeating the same usage — it must be counted once.
const claudeFile = path.join(tmp, 'claude-session.jsonl')
const claudeUsage = { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 50 }
fs.writeFileSync(
  claudeFile,
  [
    JSON.stringify({ type: 'user', cwd: '/repo', timestamp: '2026-09-01T10:00:00Z', message: { content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-01T10:00:05Z',
      message: { id: 'msg_1', model: 'claude-fable-5', usage: claudeUsage, content: [{ type: 'thinking', thinking: 'hmm' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-01T10:00:06Z',
      message: { id: 'msg_1', model: 'claude-fable-5', usage: claudeUsage, content: [{ type: 'text', text: 'hello' }] },
    }),
  ].join('\n'),
)

// Codex: usage arrives as cumulative token_count events (the last snapshot wins;
// input_tokens includes the cached share) and the model in turn_context.
const codexFile = path.join(tmp, 'codex-rollout.jsonl')
fs.writeFileSync(
  codexFile,
  [
    JSON.stringify({ timestamp: '2026-09-01T11:00:00Z', type: 'session_meta', payload: { id: 'codex-1', cwd: '/repo' } }),
    JSON.stringify({ timestamp: '2026-09-01T11:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    JSON.stringify({
      timestamp: '2026-09-01T11:00:02Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    }),
    JSON.stringify({
      timestamp: '2026-09-01T11:00:03Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 40, total_tokens: 540 } } },
    }),
    JSON.stringify({ timestamp: '2026-09-01T11:00:04Z', type: 'event_msg', payload: { type: 'token_count', info: null } }),
    JSON.stringify({
      timestamp: '2026-09-01T11:00:05Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, total_tokens: 1100 } } },
    }),
  ].join('\n'),
)

// Gemini: per-response tokens ({input includes cached, thoughts billed as output}) + model.
const geminiFile = path.join(tmp, 'gemini-session.json')
fs.writeFileSync(
  geminiFile,
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

// -- import + assertions -----------------------------------------------------

const db = openDb(dbFile)

assert.equal(await importSessionFile(db, { harness: 'claude', file: claudeFile }), 'imported')
assert.equal(await importSessionFile(db, { harness: 'codex', file: codexFile }), 'imported')
assert.equal(await importSessionFile(db, { harness: 'gemini', file: geminiFile }), 'imported')

const claude = await db.selectFrom('sessions').selectAll().where('source_path', '=', claudeFile).executeTakeFirstOrThrow()
assert.equal(claude.model, 'claude-fable-5')
assert.deepEqual(
  [claude.input_tokens, claude.output_tokens, claude.cache_read_tokens, claude.cache_write_tokens],
  [5, 50, 200, 100],
  'claude usage counted once per API response',
)
const claudeMsgs = await db.selectFrom('messages').selectAll().where('session_id', '=', claude.id).orderBy('seq').execute()
assert.equal(claudeMsgs.filter((m) => m.input_tokens !== null).length, 1)
assert.ok(claudeMsgs.filter((m) => m.role === 'assistant').every((m) => m.model === 'claude-fable-5'))

const codex = await db.selectFrom('sessions').selectAll().where('source_path', '=', codexFile).executeTakeFirstOrThrow()
assert.equal(codex.model, 'gpt-5.6-sol')
assert.deepEqual(
  [codex.input_tokens, codex.output_tokens, codex.cache_read_tokens, codex.cache_write_tokens],
  [400, 100, 600, 0],
  'codex uses the last cumulative snapshot, input minus cached',
)

const gemini = await db.selectFrom('sessions').selectAll().where('source_path', '=', geminiFile).executeTakeFirstOrThrow()
assert.equal(gemini.model, 'gemini-3-pro-preview')
assert.deepEqual(
  [gemini.input_tokens, gemini.output_tokens, gemini.cache_read_tokens, gemini.cache_write_tokens],
  [4510, 163, 2995, 0],
  'gemini input excludes cached; thoughts count as output',
)

// Cost estimation: prefix-matched pricing, null for unknown models, null usage passthrough.
const claudeCost = estimateCostUsd('claude-fable-5', { input: 5, output: 50, cacheRead: 200, cacheWrite: 100 })
assert.ok(claudeCost !== null && Math.abs(claudeCost - 0.004) < 1e-9, `claude cost ${claudeCost}`)
assert.ok(estimateCostUsd('gpt-5.6-sol', { input: 400, output: 100, cacheRead: 600, cacheWrite: 0 })! > 0)
assert.equal(estimateCostUsd('some-unknown-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null)
assert.equal(estimateCostUsd('claude-fable-5', null), null)

// Hook path re-captures the same file after growth: usage must stay consistent, not double.
fs.appendFileSync(
  claudeFile,
  '\n' +
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-01T10:01:00Z',
      message: { id: 'msg_2', model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: 'text', text: 'more' }] },
    }),
)
assert.equal(await importSessionFile(db, { harness: 'claude', file: claudeFile }), 'updated')
const claude2 = await db.selectFrom('sessions').selectAll().where('source_path', '=', claudeFile).executeTakeFirstOrThrow()
assert.deepEqual([claude2.input_tokens, claude2.output_tokens], [6, 52])

await db.destroy()

// Migration: dropping the usage columns simulates a pre-usage DB; reopening restores them.
const raw = new SQLite(dbFile)
for (const table of ['sessions', 'messages']) {
  for (const col of ['model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    raw.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`)
  }
}
raw.close()
const migrated = openDb(dbFile)
const row = await migrated.selectFrom('sessions').selectAll().executeTakeFirstOrThrow()
assert.equal(row.model, null, 'migrated columns exist and default to null')
await migrated.destroy()

fs.rmSync(tmp, { recursive: true, force: true })
console.log('smoke-usage: all assertions passed')
