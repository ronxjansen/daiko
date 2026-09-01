import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { harnessById, sessionHarnesses } from './harnesses/index.js'
import type { ParsedSession, TokenUsage } from './harnesses/types.js'

const now = () => new Date().toISOString()

/**
 * Session-level model + token totals. Prefers the parser's session-wide figures
 * (Codex reports only cumulative usage); otherwise sums per-message usage and
 * takes the last per-message model. Null (not zero) when nothing was reported.
 */
function sessionRollup(parsed: ParsedSession): { model: string | null; usage: TokenUsage | null } {
  let model = parsed.model ?? null
  let usage = parsed.usage ?? null
  if (!usage) {
    for (const m of parsed.messages) {
      if (!m.usage) continue
      usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      usage.input += m.usage.input
      usage.output += m.usage.output
      usage.cacheRead += m.usage.cacheRead
      usage.cacheWrite += m.usage.cacheWrite
    }
  }
  if (!model) {
    for (const m of parsed.messages) model = m.model ?? model
  }
  return { model, usage }
}

export interface SessionSource {
  harness: string
  file: string
}

/** Well-known local session stores of every registered harness. */
export function discoverSessionFiles(home = os.homedir()): SessionSource[] {
  return sessionHarnesses().flatMap((h) =>
    (h.discoverSessionFiles?.(home) ?? []).map((file) => ({ harness: h.id, file })),
  )
}

export function parseSessionFile(source: SessionSource): ParsedSession | null {
  return harnessById(source.harness)?.parseSession?.(source.file) ?? null
}

export interface ImportSummary {
  imported: number
  updated: number
  skipped: number
  failed: number
}

/**
 * Upsert one parsed session, replacing its messages wholesale — transcripts are
 * append-only, so a full rewrite keeps import idempotent. `size` and `mtimeMs` are the
 * change-detection pair recorded for the next skip check (a file stat for file-backed
 * sessions, an adapter-chosen stand-in for database-backed ones).
 */
async function upsertSession(
  db: Kysely<DB>,
  parsed: ParsedSession,
  existing: { id: string } | undefined,
  stamp: { size: number; mtimeMs: number },
): Promise<'imported' | 'updated'> {
  const sessionId = existing?.id ?? randomUUID()
  const rollup = sessionRollup(parsed)
  const sessionRow = {
    harness: parsed.harness,
    external_id: parsed.externalId,
    source_path: parsed.sourcePath,
    project_path: parsed.projectPath,
    title: parsed.title,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt,
    message_count: parsed.messages.length,
    source_size: stamp.size,
    source_mtime_ms: Math.floor(stamp.mtimeMs),
    model: rollup.model,
    input_tokens: rollup.usage?.input ?? null,
    output_tokens: rollup.usage?.output ?? null,
    cache_read_tokens: rollup.usage?.cacheRead ?? null,
    cache_write_tokens: rollup.usage?.cacheWrite ?? null,
    updated_at: now(),
  }

  const isNew = !existing
  await db.transaction().execute(async (trx) => {
    if (isNew) {
      await trx
        .insertInto('sessions')
        .values({ id: sessionId, ...sessionRow, created_at: now() })
        .execute()
    } else {
      await trx.updateTable('sessions').set(sessionRow).where('id', '=', sessionId).execute()
      await trx.deleteFrom('messages').where('session_id', '=', sessionId).execute()
    }

    const rows = parsed.messages.map((m, seq) => ({
      id: randomUUID(),
      session_id: sessionId,
      seq,
      role: m.role,
      kind: m.kind,
      content: m.content,
      tool_name: m.toolName,
      tool_use_id: m.toolUseId,
      timestamp: m.timestamp,
      model: m.model ?? null,
      input_tokens: m.usage?.input ?? null,
      output_tokens: m.usage?.output ?? null,
      cache_read_tokens: m.usage?.cacheRead ?? null,
      cache_write_tokens: m.usage?.cacheWrite ?? null,
    }))
    for (let i = 0; i < rows.length; i += 50) {
      await trx.insertInto('messages').values(rows.slice(i, i + 50)).execute()
    }
  })

  return isNew ? 'imported' : 'updated'
}

/** The stored change-detection stamp for a session, keyed by its unique source path. */
async function findExisting(db: Kysely<DB>, harness: string, sourcePath: string) {
  return db
    .selectFrom('sessions')
    .select(['id', 'source_mtime_ms', 'source_size'])
    .where('harness', '=', harness)
    .where('source_path', '=', sourcePath)
    .executeTakeFirst()
}

/**
 * Import one session file. Skips when the file is unchanged since the last import
 * (mtime + size), unless force is set.
 */
export async function importSessionFile(
  db: Kysely<DB>,
  source: SessionSource,
  opts: { force?: boolean } = {},
): Promise<'imported' | 'updated' | 'skipped' | 'failed'> {
  let stat: fs.Stats
  try {
    stat = fs.statSync(source.file)
  } catch {
    return 'failed'
  }

  const existing = await findExisting(db, source.harness, source.file)
  if (existing && !opts.force && existing.source_mtime_ms === Math.floor(stat.mtimeMs) && existing.source_size === stat.size) {
    return 'skipped'
  }

  // No parsed session = metadata-only or empty transcript, not an error.
  const parsed = parseSessionFile(source)
  if (!parsed) return 'skipped'

  return upsertSession(db, parsed, existing, stat)
}

/**
 * Import every session of the harnesses that keep a shared database store (goose,
 * Hermes) rather than one transcript file per session. The adapter already parsed each
 * session, so the unchanged check only saves the DB write, not the read.
 */
export async function importDbSessions(
  db: Kysely<DB>,
  opts: { harness?: string; force?: boolean } = {},
  home = os.homedir(),
): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, updated: 0, skipped: 0, failed: 0 }
  for (const h of sessionHarnesses()) {
    if (!h.discoverDbSessions) continue
    if (opts.harness && h.id !== opts.harness) continue
    for (const session of h.discoverDbSessions(home)) {
      const existing = await findExisting(db, session.harness, session.sourcePath)
      if (existing && !opts.force && existing.source_mtime_ms === Math.floor(session.mtimeMs) && existing.source_size === session.size) {
        summary.skipped++
        continue
      }
      summary[await upsertSession(db, session, existing, session)]++
    }
  }
  return summary
}

/** Import every session found in the default local stores of all registered harnesses. */
export async function importAllSessions(
  db: Kysely<DB>,
  opts: { harness?: string; force?: boolean } = {},
): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, updated: 0, skipped: 0, failed: 0 }
  for (const source of discoverSessionFiles()) {
    if (opts.harness && source.harness !== opts.harness) continue
    const result = await importSessionFile(db, source, opts)
    summary[result]++
  }
  const fromDb = await importDbSessions(db, opts)
  summary.imported += fromDb.imported
  summary.updated += fromDb.updated
  summary.skipped += fromDb.skipped
  summary.failed += fromDb.failed
  return summary
}
