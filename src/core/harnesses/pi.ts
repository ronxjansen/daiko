import path from 'node:path'
import type { HarnessAdapter, ParsedMessage, ParsedSession } from './types.js'
import { flattenContent, isDir, readJson, readJsonl, safeReaddir } from './util.js'

/**
 * Parse a pi coding agent session (~/.pi/agent/sessions/--<escaped-cwd>--/<ts>_<uuid>.jsonl).
 * Version-3 format: a {type:'session', id, timestamp, cwd} header, then tree-structured
 * entries (id/parentId allow in-place branching). Like the Claude parser, entries are read
 * in file order — branches interleave rather than replay, which matches the append order.
 * Transcript content lives in {type:'message'} entries whose message.role is user
 * (text/image blocks), assistant (text/thinking/toolCall blocks + model/usage), or
 * toolResult; model_change, compaction, label, ... are metadata and are skipped.
 */
export function parsePiSession(file: string): ParsedSession | null {
  const entries = readJsonl(file)
  if (entries.length === 0) return null

  let sessionId: string | null = null
  let cwd: string | null = null
  let startedAt: string | null = null
  let endedAt: string | null = null
  const messages: ParsedMessage[] = []

  for (const entry of entries) {
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!endedAt || ts > endedAt) endedAt = ts
    }
    if (entry.type === 'session') {
      sessionId = typeof entry.id === 'string' ? entry.id : null
      cwd = typeof entry.cwd === 'string' ? entry.cwd : null
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue
    const m = entry.message

    if (m.role === 'user') {
      messages.push({ role: 'user', kind: 'text', content: flattenContent(m.content), toolName: null, toolUseId: null, timestamp: ts })
      continue
    }
    if (m.role === 'toolResult') {
      messages.push({
        role: 'tool',
        kind: 'tool_result',
        content: flattenContent(m.content),
        toolName: m.toolName ?? null,
        toolUseId: m.toolCallId ?? null,
        timestamp: ts,
      })
      continue
    }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue

    // Per-response model + usage ({input, output, cacheRead, cacheWrite}; input is
    // already the non-cached share). Attach to the first stored block of the response.
    const model = typeof m.model === 'string' ? m.model : null
    let usage: ParsedMessage['usage'] = m.usage
      ? {
          input: m.usage.input ?? 0,
          output: m.usage.output ?? 0,
          cacheRead: m.usage.cacheRead ?? 0,
          cacheWrite: m.usage.cacheWrite ?? 0,
        }
      : null
    const pushAssistant = (msg: ParsedMessage) => {
      messages.push({ ...msg, model, usage })
      usage = null
    }

    for (const block of m.content) {
      if (block?.type === 'thinking') {
        pushAssistant({ role: 'assistant', kind: 'thinking', content: block.thinking ?? '', toolName: null, toolUseId: null, timestamp: ts })
      } else if (block?.type === 'text') {
        pushAssistant({ role: 'assistant', kind: 'text', content: block.text ?? '', toolName: null, toolUseId: null, timestamp: ts })
      } else if (block?.type === 'toolCall') {
        pushAssistant({
          role: 'assistant',
          kind: 'tool_use',
          content: JSON.stringify(block.arguments ?? {}),
          toolName: block.name ?? null,
          toolUseId: block.id ?? null,
          timestamp: ts,
        })
      }
    }
  }

  if (messages.length === 0) return null
  return {
    harness: 'pi',
    externalId: sessionId ?? path.basename(file, '.jsonl'),
    sourcePath: file,
    projectPath: cwd,
    title: null,
    startedAt,
    endedAt,
    messages,
  }
}

export const pi: HarnessAdapter = {
  id: 'pi',
  label: 'Pi',
  globalConfigDir: '.pi',
  // Pi reads AGENTS.md (walking up from cwd) and implements the Agent Skills standard in
  // .pi/skills as well as the shared .agents/skills (which the generic harness owns here).
  // No MCP by design: pi's docs say to use CLI tools + skills or an extension instead.
  layout: { agentFile: 'AGENTS.md', skillsDir: '.pi/skills' },

  // ~/.pi/agent/trust.json records a trust decision per project folder pi has run in.
  discoverProjects(home) {
    const doc = readJson(path.join(home, '.pi', 'agent', 'trust.json'))
    return Object.entries(doc ?? {})
      .filter(([, trusted]) => Boolean(trusted))
      .map(([dir]) => dir)
  },

  // ~/.pi/agent/sessions/--<escaped-cwd>--/<timestamp>_<uuid>.jsonl
  discoverSessionFiles(home) {
    const sessions = path.join(home, '.pi', 'agent', 'sessions')
    const out: string[] = []
    for (const dir of safeReaddir(sessions)) {
      const abs = path.join(sessions, dir)
      if (!isDir(abs)) continue
      for (const file of safeReaddir(abs)) {
        if (file.endsWith('.jsonl')) out.push(path.join(abs, file))
      }
    }
    return out
  },

  parseSession: parsePiSession,
}
