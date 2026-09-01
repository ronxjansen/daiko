import path from 'node:path'
import type { DbSession, HarnessAdapter, ParsedMessage } from './types.js'
import { flattenContent, readSqlite } from './util.js'

const stateDb = (home: string) => path.join(home, '.hermes', 'state.db')

const epochToIso = (seconds: unknown): string | null =>
  typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : null

/**
 * Hermes (Nous Research's hermes-agent). Sessions and messages live in the SQLite store
 * ~/.hermes/state.db; messages are OpenAI-shaped rows (role, content, tool_calls JSON,
 * tool_call_id) with reasoning kept in separate columns.
 */
export const hermes: HarnessAdapter = {
  id: 'hermes',
  label: 'Hermes',
  globalConfigDir: '.hermes',
  // Hermes prefers its own HERMES.md / .hermes.md over AGENTS.md, so those scan as
  // instruction files but AGENTS.md stays the write target. Skills are global-only
  // (~/.hermes/skills) and MCP servers live in ~/.hermes/config.yaml among unrelated
  // settings in a hermes-specific YAML shape, so neither has a project-level location.
  layout: { agentFile: 'AGENTS.md', agentFileAliases: ['HERMES.md', '.hermes.md'] },

  // Every session records the directory it ran in.
  discoverProjects(home) {
    return readSqlite(stateDb(home), [] as Array<{ cwd: string }>, (sql) =>
      sql.prepare('SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL').all() as Array<{ cwd: string }>,
    ).map((r) => r.cwd)
  },

  discoverDbSessions(home) {
    const file = stateDb(home)
    return readSqlite(file, [] as DbSession[], (sql) => {
      const sessions = sql.prepare('SELECT * FROM sessions').all() as Array<Record<string, any>>
      const messagesFor = sql.prepare(
        'SELECT role, content, tool_calls, tool_call_id, tool_name, timestamp, reasoning_content, reasoning FROM messages WHERE session_id = ? AND active = 1 ORDER BY id',
      )
      const out: DbSession[] = []
      for (const s of sessions) {
        const messages: ParsedMessage[] = []
        for (const m of messagesFor.all(s.id) as Array<Record<string, any>>) {
          const ts = epochToIso(m.timestamp)
          const reasoning = m.reasoning_content ?? m.reasoning
          if (m.role === 'assistant' && typeof reasoning === 'string' && reasoning) {
            messages.push({ role: 'assistant', kind: 'thinking', content: reasoning, toolName: null, toolUseId: null, timestamp: ts })
          }
          if (m.role === 'tool') {
            messages.push({
              role: 'tool',
              kind: 'tool_result',
              content: flattenContent(m.content ?? ''),
              toolName: m.tool_name ?? null,
              toolUseId: m.tool_call_id ?? null,
              timestamp: ts,
            })
            continue
          }
          if (m.content != null && m.content !== '') {
            const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : 'system'
            messages.push({
              role,
              kind: role === 'system' ? 'system' : 'text',
              content: flattenContent(m.content),
              toolName: null,
              toolUseId: null,
              timestamp: ts,
            })
          }
          if (m.role === 'assistant' && m.tool_calls) {
            let calls: any[] = []
            try {
              calls = JSON.parse(m.tool_calls)
            } catch {
              // unreadable tool_calls: keep the text part of the message
            }
            for (const call of Array.isArray(calls) ? calls : []) {
              messages.push({
                role: 'assistant',
                kind: 'tool_use',
                content: typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? {}),
                toolName: call?.function?.name ?? null,
                toolUseId: call?.id ?? null,
                timestamp: ts,
              })
            }
          }
        }
        if (messages.length === 0) continue
        const usage =
          s.input_tokens || s.output_tokens
            ? {
                input: s.input_tokens ?? 0,
                output: s.output_tokens ?? 0,
                cacheRead: s.cache_read_tokens ?? 0,
                cacheWrite: s.cache_write_tokens ?? 0,
              }
            : null
        out.push({
          harness: 'hermes',
          externalId: s.id,
          sourcePath: `${file}#${s.id}`,
          projectPath: s.cwd ?? null,
          title: s.title ?? s.display_name ?? null,
          startedAt: epochToIso(s.started_at),
          endedAt: epochToIso(s.ended_at),
          messages,
          model: s.model ?? null,
          usage,
          mtimeMs: (s.ended_at ?? s.started_at ?? 0) * 1000,
          size: messages.length,
        })
      }
      return out
    })
  },
}
