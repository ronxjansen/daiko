import path from 'node:path'
import type { DbSession, HarnessAdapter, ParsedMessage, ParsedSession, TokenUsage } from './types.js'
import { readJson, readJsonl, readSqlite, safeReaddir } from './util.js'

const dataDir = (home: string) => path.join(home, '.local', 'share', 'goose')

/**
 * Map one goose content block list (shared by legacy JSONL lines and sessions.db
 * content_json) onto normalized messages. Blocks are camelCase-tagged: text, thinking,
 * toolRequest ({id, toolCall: {value: {name, arguments}}} — sits inside an assistant
 * message), toolResponse ({id, toolResult: {value: blocks}} — inside a user message).
 */
function gooseMessages(role: unknown, content: unknown, ts: string | null): ParsedMessage[] {
  const out: ParsedMessage[] = []
  const base = role === 'assistant' ? ('assistant' as const) : ('user' as const)
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      out.push({ role: base, kind: 'text', content: block.text, toolName: null, toolUseId: null, timestamp: ts })
    } else if (block?.type === 'thinking') {
      out.push({ role: 'assistant', kind: 'thinking', content: block.thinking ?? '', toolName: null, toolUseId: null, timestamp: ts })
    } else if (block?.type === 'toolRequest') {
      const call = block.toolCall?.value ?? {}
      out.push({
        role: 'assistant',
        kind: 'tool_use',
        content: JSON.stringify(call.arguments ?? {}),
        toolName: call.name ?? null,
        toolUseId: block.id ?? null,
        timestamp: ts,
      })
    } else if (block?.type === 'toolResponse') {
      const value = block.toolResult?.value
      out.push({
        role: 'tool',
        kind: 'tool_result',
        content: Array.isArray(value)
          ? value.map((v: any) => (typeof v?.text === 'string' ? v.text : JSON.stringify(v))).join('\n')
          : JSON.stringify(value ?? null),
        toolName: null,
        toolUseId: block.id ?? null,
        timestamp: ts,
      })
    }
  }
  return out
}

const unixToIso = (seconds: unknown): string | null =>
  typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : null

/** Session-wide totals; accumulated_* spans compactions, so it wins over the flat figures. */
function gooseUsage(meta: Record<string, any>): TokenUsage | null {
  const input = meta.accumulated_input_tokens ?? meta.input_tokens
  const output = meta.accumulated_output_tokens ?? meta.output_tokens
  if (typeof input !== 'number' && typeof output !== 'number') return null
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: meta.accumulated_cache_read_tokens ?? meta.cache_read_tokens ?? 0,
    cacheWrite: meta.accumulated_cache_write_tokens ?? meta.cache_write_tokens ?? 0,
  }
}

/**
 * Parse a legacy goose session (~/.local/share/goose/sessions/<id>.jsonl, pre-1.10).
 * First line is metadata ({working_dir, description, token totals}), the rest are
 * messages ({role, created (unix s), content: [blocks]}).
 */
export function parseGooseSession(file: string): ParsedSession | null {
  const lines = readJsonl(file)
  if (lines.length === 0) return null
  // A message line has a role; anything else leading the file is the metadata header.
  const hasMeta = typeof lines[0].role !== 'string'
  const meta = hasMeta ? lines[0] : {}
  const rest = hasMeta ? lines.slice(1) : lines

  const messages: ParsedMessage[] = []
  let startedAt: string | null = null
  let endedAt: string | null = null
  for (const m of rest) {
    const ts = unixToIso(m.created)
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!endedAt || ts > endedAt) endedAt = ts
    }
    messages.push(...gooseMessages(m.role, m.content, ts))
  }
  if (messages.length === 0) return null

  return {
    harness: 'goose',
    externalId: meta.id ?? path.basename(file, '.jsonl'),
    sourcePath: file,
    projectPath: typeof meta.working_dir === 'string' ? meta.working_dir : null,
    title: typeof meta.description === 'string' && meta.description ? meta.description : null,
    startedAt,
    endedAt,
    messages,
    usage: gooseUsage(meta),
  }
}

/** 'YYYY-MM-DD HH:MM:SS' SQLite UTC timestamps → ISO / epoch ms. */
const sqlToIso = (v: unknown): string | null => (typeof v === 'string' && v ? v.replace(' ', 'T') + 'Z' : null)

export const goose: HarnessAdapter = {
  id: 'goose',
  label: 'Goose',
  globalConfigDir: '.config/goose',
  // Goose reads AGENTS.md natively, falling back to .goosehints; it implements the Agent
  // Skills standard in the shared .agents/skills location (which Generic owns here, so
  // rendering dedupes to one directory). MCP "extensions" live only in the global
  // ~/.config/goose/config.yaml, entangled with unrelated settings and secrets in a
  // goose-specific YAML shape, so goose is not offered as an MCP source or target.
  layout: { agentFile: 'AGENTS.md', agentFileAliases: ['.goosehints'], skillsDir: '.agents/skills' },

  // Older goose kept ~/.local/share/goose/projects.json (the retired `goose project`
  // command); every modern session records its working_dir in sessions.db.
  discoverProjects(home) {
    const legacy = readJson(path.join(dataDir(home), 'projects.json'))
    const out = Object.keys((legacy?.projects ?? {}) as Record<string, unknown>)
    const db = path.join(dataDir(home), 'sessions', 'sessions.db')
    const fromDb = readSqlite(db, [] as Array<{ working_dir: string }>, (sql) =>
      sql.prepare('SELECT DISTINCT working_dir FROM sessions WHERE working_dir IS NOT NULL').all() as Array<{ working_dir: string }>,
    )
    return [...out, ...fromDb.map((r) => r.working_dir)]
  },

  // Legacy per-session files, kept in place (unmanaged) after the SQLite migration.
  discoverSessionFiles(home) {
    const sessions = path.join(dataDir(home), 'sessions')
    return safeReaddir(sessions)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(sessions, f))
  },

  parseSession: parseGooseSession,

  // goose ≥1.10 stores sessions in ~/.local/share/goose/sessions/sessions.db.
  discoverDbSessions(home) {
    const file = path.join(dataDir(home), 'sessions', 'sessions.db')
    return readSqlite(file, [] as DbSession[], (sql) => {
      const sessions = sql.prepare('SELECT * FROM sessions').all() as Array<Record<string, any>>
      const messagesFor = sql.prepare('SELECT role, content_json, created_timestamp FROM messages WHERE session_id = ? ORDER BY id')
      const out: DbSession[] = []
      for (const s of sessions) {
        const messages: ParsedMessage[] = []
        for (const m of messagesFor.all(s.id) as Array<Record<string, any>>) {
          let content: unknown
          try {
            content = JSON.parse(m.content_json)
          } catch {
            continue
          }
          messages.push(...gooseMessages(m.role, content, unixToIso(m.created_timestamp)))
        }
        if (messages.length === 0) continue
        let model: string | null = null
        try {
          model = JSON.parse(s.model_config_json ?? 'null')?.model_name ?? null
        } catch {
          // unreadable model config: leave null
        }
        out.push({
          harness: 'goose',
          externalId: s.id,
          sourcePath: `${file}#${s.id}`,
          projectPath: s.working_dir ?? null,
          title: s.name || s.description || null,
          startedAt: sqlToIso(s.created_at),
          endedAt: sqlToIso(s.updated_at),
          messages,
          model,
          usage: gooseUsage(s),
          mtimeMs: Date.parse(sqlToIso(s.updated_at) ?? '') || 0,
          size: messages.length,
        })
      }
      return out
    })
  },
}
