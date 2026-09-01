import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { harnessById, sessionHarnesses } from './harnesses/index.js'
import type { ParsedSession } from './harnesses/types.js'

const now = () => new Date().toISOString()

export interface SessionSource {
  harness: string
  file: string
}

/** Well-known local session stores of every registered harness. */
export function discoverSessionFiles(home = os.homedir()): SessionSource[] {
  return sessionHarnesses().flatMap((h) =>
    h.discoverSessionFiles!(home).map((file) => ({ harness: h.id, file })),
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
 * Import one session file. Skips when the file is unchanged since the last import
 * (mtime + size), unless force is set. Messages are replaced wholesale on change —
 * transcripts are append-only, so a full rewrite keeps import idempotent.
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

  const existing = await db
    .selectFrom('sessions')
    .select(['id', 'source_mtime_ms', 'source_size'])
    .where('harness', '=', source.harness)
    .where('source_path', '=', source.file)
    .executeTakeFirst()

  if (existing && !opts.force && existing.source_mtime_ms === Math.floor(stat.mtimeMs) && existing.source_size === stat.size) {
    return 'skipped'
  }

  // No parsed session = metadata-only or empty transcript, not an error.
  const parsed = parseSessionFile(source)
  if (!parsed) return 'skipped'

  const sessionId = existing?.id ?? randomUUID()
  const sessionRow = {
    harness: parsed.harness,
    external_id: parsed.externalId,
    source_path: parsed.sourcePath,
    project_path: parsed.projectPath,
    title: parsed.title,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt,
    message_count: parsed.messages.length,
    source_size: stat.size,
    source_mtime_ms: Math.floor(stat.mtimeMs),
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
    }))
    for (let i = 0; i < rows.length; i += 50) {
      await trx.insertInto('messages').values(rows.slice(i, i + 50)).execute()
    }
  })

  return isNew ? 'imported' : 'updated'
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
  return summary
}
