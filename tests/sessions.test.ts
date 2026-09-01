import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from '../src/db/schema.js'
import { openDb } from '../src/db/index.js'
import { importSessionFile } from '../src/core/sessions.js'

let tmp: string
let db: Kysely<DB>
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-sessions-'))
  db = openDb(path.join(tmp, 'daiko.sqlite'))
})
afterEach(async () => {
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const line = (entry: unknown) => JSON.stringify(entry) + '\n'
const assistant = (id: string, text: string, usage: Record<string, number>) =>
  line({ type: 'assistant', message: { id, model: 'claude-opus-5', usage, content: [{ type: 'text', text }] } })

const writeSession = (entries: string[]): string => {
  const file = path.join(tmp, 'session.jsonl')
  fs.writeFileSync(file, entries.join(''))
  return file
}

describe('importSessionFile', () => {
  it('imports, rolls up per-message usage, and skips unchanged files on re-import', async () => {
    const file = writeSession([
      line({ type: 'user', cwd: '/p', message: { content: 'hi' } }),
      assistant('m1', 'a', { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 }),
      assistant('m2', 'b', { input_tokens: 50, output_tokens: 7 }),
    ])
    const source = { harness: 'claude', file }

    expect(await importSessionFile(db, source)).toBe('imported')
    const session = await db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow()
    expect(session.model).toBe('claude-opus-5')
    expect(session.input_tokens).toBe(150)
    expect(session.output_tokens).toBe(12)
    expect(session.cache_read_tokens).toBe(20)
    expect(session.cache_write_tokens).toBe(10)
    expect(session.message_count).toBe(3)
    expect(session.project_path).toBe('/p')

    // Unchanged file: skipped without touching the DB.
    expect(await importSessionFile(db, source)).toBe('skipped')

    // Appended transcript: updated in place, messages replaced (not duplicated).
    fs.appendFileSync(file, assistant('m3', 'c', { input_tokens: 1, output_tokens: 1 }))
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(await importSessionFile(db, source)).toBe('updated')
    const sessions = await db.selectFrom('sessions').selectAll().execute()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].message_count).toBe(4)
    expect(sessions[0].input_tokens).toBe(151)
    const messages = await db.selectFrom('messages').select('id').execute()
    expect(messages).toHaveLength(4)
  })

  it('re-imports on force even when the stat is unchanged', async () => {
    const file = writeSession([line({ type: 'user', message: { content: 'hi' } })])
    const source = { harness: 'claude', file }
    expect(await importSessionFile(db, source)).toBe('imported')
    expect(await importSessionFile(db, source, { force: true })).toBe('updated')
  })

  it('reports failed for a missing file and skipped for a metadata-only transcript', async () => {
    expect(await importSessionFile(db, { harness: 'claude', file: path.join(tmp, 'nope.jsonl') })).toBe('failed')
    const file = writeSession([line({ type: 'file-history-snapshot' })])
    expect(await importSessionFile(db, { harness: 'claude', file })).toBe('skipped')
  })
})
