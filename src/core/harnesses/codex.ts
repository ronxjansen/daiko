import fs from 'node:fs'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { MessageRole } from '../../db/schema.js'
import type { HarnessAdapter, ParsedMessage, ParsedSession } from './types.js'
import { flattenContent, mcpServerArtifacts, readJsonl, walk, writeFileAtomic } from './util.js'

/**
 * Parse a Codex CLI rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 * Lines are {timestamp, type, payload}; transcript content lives in response_item
 * payloads: message, reasoning, function_call(_output), custom_tool_call(_output), web_search_call.
 */
export function parseCodexTranscript(file: string): ParsedSession | null {
  const entries = readJsonl(file)
  if (entries.length === 0) return null

  let sessionId: string | null = null
  let cwd: string | null = null
  let startedAt: string | null = null
  let endedAt: string | null = null
  let model: string | null = null
  let totalUsage: ParsedSession['usage'] = null
  const messages: ParsedMessage[] = []

  for (const entry of entries) {
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!endedAt || ts > endedAt) endedAt = ts
    }

    if (entry.type === 'session_meta' && entry.payload) {
      sessionId = entry.payload.id ?? entry.payload.session_id ?? null
      cwd = entry.payload.cwd ?? null
      continue
    }
    if (entry.type === 'turn_context' && typeof entry.payload?.model === 'string') {
      model = entry.payload.model
      continue
    }
    // Codex only reports usage per turn, and token_count events repeat within a
    // turn (summing last_token_usage overcounts) — keep the cumulative snapshot,
    // whose input_tokens figure includes the cached share.
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      const t = entry.payload.info?.total_token_usage
      if (t) {
        totalUsage = {
          input: Math.max(0, (t.input_tokens ?? 0) - (t.cached_input_tokens ?? 0)),
          output: t.output_tokens ?? 0,
          cacheRead: t.cached_input_tokens ?? 0,
          cacheWrite: t.cache_write_input_tokens ?? 0,
        }
      }
      continue
    }
    if (entry.type !== 'response_item' || !entry.payload) continue
    const p = entry.payload

    if (p.type === 'message') {
      const role: MessageRole = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : 'system'
      messages.push({
        role,
        kind: 'text',
        content: flattenContent(p.content),
        toolName: null,
        toolUseId: null,
        timestamp: ts,
      })
    } else if (p.type === 'reasoning') {
      // Codex encrypts raw reasoning; the readable part is the summary blocks.
      const summary = Array.isArray(p.summary) ? p.summary.map((s: any) => s?.text ?? '').filter(Boolean).join('\n') : ''
      messages.push({ role: 'assistant', kind: 'thinking', content: summary, toolName: null, toolUseId: null, timestamp: ts })
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'web_search_call') {
      messages.push({
        role: 'assistant',
        kind: 'tool_use',
        content: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? p.input ?? p.action ?? {}),
        toolName: p.name ?? p.type,
        toolUseId: p.call_id ?? p.id ?? null,
        timestamp: ts,
      })
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        kind: 'tool_result',
        content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? null),
        toolName: null,
        toolUseId: p.call_id ?? null,
        timestamp: ts,
      })
    }
  }

  if (messages.length === 0) return null
  return {
    harness: 'codex',
    externalId: sessionId ?? path.basename(file, '.jsonl'),
    sourcePath: file,
    projectPath: cwd,
    title: null,
    startedAt,
    endedAt,
    messages,
    model,
    usage: totalUsage,
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Drop every line that defines mcp_servers.<name>: its [mcp_servers.<name>(.sub)] table
 * blocks and any `<name> = ...` key inside a bare [mcp_servers] table. Best-effort text
 * surgery to keep the user's comments and formatting; the caller validates the result by
 * re-parsing and falls back to a full re-serialize when it doesn't round-trip.
 */
function removeTomlServerLines(text: string, name: string): string {
  const key = `(?:${escapeRegExp(name)}|"${escapeRegExp(name)}"|'${escapeRegExp(name)}')`
  const serverHeader = new RegExp(`^\\s*\\[\\[?\\s*mcp_servers\\s*\\.\\s*${key}\\s*(?:\\]|\\.)`)
  const serversTableHeader = /^\s*\[\s*mcp_servers\s*\]/
  const anyHeader = /^\s*\[/
  const inlineKey = new RegExp(`^\\s*${key}\\s*[=.]`)

  const out: string[] = []
  let skippingBlock = false
  let inServersTable = false
  for (const line of text.split('\n')) {
    if (anyHeader.test(line)) {
      skippingBlock = serverHeader.test(line)
      inServersTable = serversTableHeader.test(line)
      if (skippingBlock) continue
    } else if (inServersTable && inlineKey.test(line)) {
      continue
    }
    if (!skippingBlock) out.push(line)
  }
  return out.join('\n')
}

export const codex: HarnessAdapter = {
  id: 'codex',
  label: 'Codex',
  // Codex reads AGENTS.md and has no project-level MCP config: its servers live in
  // ~/.codex/config.toml only, so it cannot host a project MCP target.
  layout: { agentFile: 'AGENTS.md', skillsDir: '.codex/skills' },

  // ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  discoverSessionFiles(home) {
    const sessions = path.join(home, '.codex', 'sessions')
    if (!fs.existsSync(sessions)) return []
    return [...walk(sessions)].filter((f) => f.endsWith('.jsonl'))
  },

  parseSession: parseCodexTranscript,

  scanGlobalArtifacts(home) {
    const configFile = path.join(home, '.codex', 'config.toml')
    if (!fs.existsSync(configFile)) return []
    try {
      const parsed = parseToml(fs.readFileSync(configFile, 'utf8'))
      return mcpServerArtifacts('codex', '~/.codex/config.toml', (parsed.mcp_servers ?? {}) as Record<string, unknown>)
    } catch {
      // invalid TOML: skip file
      return []
    }
  },

  removeGlobalMcpServer(home, name) {
    const file = path.join(home, '.codex', 'config.toml')
    if (!fs.existsSync(file)) return { status: 'absent', file }
    const text = fs.readFileSync(file, 'utf8')
    let parsed: Record<string, unknown>
    try {
      parsed = parseToml(text)
    } catch (err) {
      return { status: 'failed', file, reason: `invalid TOML: ${err instanceof Error ? err.message : err}` }
    }
    const servers = (parsed.mcp_servers ?? {}) as Record<string, unknown>
    if (!(name in servers)) return { status: 'absent', file }
    delete servers[name]
    if (Object.keys(servers).length === 0) delete parsed.mcp_servers

    // Targeted edit first (keeps comments/formatting), validated by re-parsing; if it
    // doesn't round-trip to the expected structure, re-serialize the whole document.
    const edited = removeTomlServerLines(text, name)
    try {
      if (JSON.stringify(parseToml(edited)) === JSON.stringify(parsed)) {
        writeFileAtomic(file, edited)
        return { status: 'removed', file }
      }
    } catch {
      // fall through to full re-serialize
    }
    writeFileAtomic(file, stringifyToml(parsed) + '\n')
    return { status: 'removed', file }
  },
}
