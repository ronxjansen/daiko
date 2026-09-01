import fs from 'node:fs'
import path from 'node:path'
import type { HarnessAdapter, ParsedMessage, ParsedSession } from './types.js'
import { flattenContent, isDir, safeReaddir } from './util.js'

/**
 * Parse a Gemini CLI chat file (~/.gemini/tmp/<hash>/chats/session-*.json).
 * One JSON document: {sessionId, startTime, lastUpdated, messages: [{type: user|gemini|info,
 * content, thoughts: [{subject, description}], toolCalls: [{id, name, args, result}]}]}.
 */
export function parseGeminiSession(file: string): ParsedSession | null {
  let doc: Record<string, any>
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(doc.messages) || doc.messages.length === 0) return null

  const messages: ParsedMessage[] = []
  for (const m of doc.messages) {
    const ts = typeof m.timestamp === 'string' ? m.timestamp : null

    if (m.type === 'user') {
      messages.push({ role: 'user', kind: 'text', content: flattenContent(m.content), toolName: null, toolUseId: null, timestamp: ts })
      continue
    }
    if (m.type !== 'gemini') {
      messages.push({ role: 'system', kind: 'system', content: flattenContent(m.content), toolName: null, toolUseId: null, timestamp: ts })
      continue
    }

    // Newer Gemini CLI records per-response model + tokens ({input, output, cached,
    // thoughts, tool, total}); input includes cached, thoughts/tool are billed as
    // output/input respectively. Attach to the first message of this response.
    const model = typeof m.model === 'string' ? m.model : null
    let usage: ParsedMessage['usage'] = m.tokens
      ? {
          input: Math.max(0, (m.tokens.input ?? 0) - (m.tokens.cached ?? 0)) + (m.tokens.tool ?? 0),
          output: (m.tokens.output ?? 0) + (m.tokens.thoughts ?? 0),
          cacheRead: m.tokens.cached ?? 0,
          cacheWrite: 0,
        }
      : null
    const pushAssistant = (msg: ParsedMessage) => {
      messages.push({ ...msg, model, usage })
      usage = null
    }

    for (const t of Array.isArray(m.thoughts) ? m.thoughts : []) {
      const text = [t?.subject, t?.description].filter(Boolean).join(': ')
      pushAssistant({ role: 'assistant', kind: 'thinking', content: text, toolName: null, toolUseId: null, timestamp: ts })
    }
    for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      pushAssistant({
        role: 'assistant',
        kind: 'tool_use',
        content: JSON.stringify(call?.args ?? {}),
        toolName: call?.name ?? null,
        toolUseId: call?.id ?? null,
        timestamp: ts,
      })
      if (call?.result !== undefined) {
        messages.push({
          role: 'tool',
          kind: 'tool_result',
          content: typeof call.result === 'string' ? call.result : JSON.stringify(call.result),
          toolName: call?.name ?? null,
          toolUseId: call?.id ?? null,
          timestamp: ts,
        })
      }
    }
    const text = flattenContent(m.content)
    if (text) {
      pushAssistant({ role: 'assistant', kind: 'text', content: text, toolName: null, toolUseId: null, timestamp: ts })
    }
  }

  if (messages.length === 0) return null
  return {
    harness: 'gemini',
    externalId: doc.sessionId ?? path.basename(file, '.json'),
    sourcePath: file,
    projectPath: null,
    title: null,
    startedAt: doc.startTime ?? null,
    endedAt: doc.lastUpdated ?? null,
    messages,
  }
}

export const gemini: HarnessAdapter = {
  id: 'gemini',
  label: 'Gemini',
  // No discoverProjects: ~/.gemini/tmp keys projects by an unreversible hash, and chat
  // files record no cwd, so Gemini contributes installation evidence only.
  globalConfigDir: '.gemini',
  // Gemini CLI keeps MCP servers in .gemini/settings.json alongside unrelated settings
  // (including Daiko's own hooks), so it is not offered as an MCP target yet.
  layout: { agentFile: 'GEMINI.md' },

  // ~/.gemini/tmp/<project-hash>/chats/session-*.json
  discoverSessionFiles(home) {
    const tmp = path.join(home, '.gemini', 'tmp')
    const out: string[] = []
    for (const dir of safeReaddir(tmp)) {
      const chats = path.join(tmp, dir, 'chats')
      if (!isDir(chats)) continue
      for (const file of safeReaddir(chats)) {
        if (file.endsWith('.json')) out.push(path.join(chats, file))
      }
    }
    return out
  },

  parseSession: parseGeminiSession,
}
