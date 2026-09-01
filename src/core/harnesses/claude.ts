import os from 'node:os'
import path from 'node:path'
import type { HarnessAdapter, ParsedMessage, ParsedSession } from './types.js'
import { flattenContent, isDir, mcpServerArtifacts, readJson, readJsonl, removeMcpServerFromJsonFile, safeReaddir } from './util.js'

/**
 * Parse a Claude Code transcript (~/.claude/projects/<slug>/<session>.jsonl).
 * Entry types: user (text or tool_result), assistant (thinking/text/tool_use blocks),
 * system, plus metadata rows (mode, attachment, file-history-snapshot, ai-title, summary).
 */
export function parseClaudeTranscript(file: string): ParsedSession | null {
  const entries = readJsonl(file)
  if (entries.length === 0) return null

  let cwd: string | null = null
  let title: string | null = null
  let startedAt: string | null = null
  let endedAt: string | null = null
  const messages: ParsedMessage[] = []
  const push = (msg: ParsedMessage) => messages.push(msg)
  // One API response spans multiple JSONL lines (one per content block), each
  // repeating the same message.usage — attach it only once per response id.
  const countedRequests = new Set<string>()

  for (const entry of entries) {
    cwd ??= typeof entry.cwd === 'string' ? entry.cwd : null
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : null
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts
      if (!endedAt || ts > endedAt) endedAt = ts
    }

    if (entry.type === 'ai-title' && typeof entry.title === 'string') title = entry.title
    if (entry.type === 'summary' && typeof entry.summary === 'string') title ??= entry.summary

    if (entry.type === 'user' && entry.message) {
      const content = entry.message.content
      if (typeof content === 'string') {
        push({ role: 'user', kind: 'text', content, toolName: null, toolUseId: null, timestamp: ts })
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            push({
              role: 'tool',
              kind: 'tool_result',
              content: flattenContent(block.content),
              toolName: null,
              toolUseId: block.tool_use_id ?? null,
              timestamp: ts,
            })
          } else if (block?.type === 'text' || typeof block === 'string') {
            push({ role: 'user', kind: 'text', content: flattenContent([block]), toolName: null, toolUseId: null, timestamp: ts })
          }
        }
      }
    } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const rawModel = typeof entry.message.model === 'string' ? entry.message.model : null
      const model = rawModel === '<synthetic>' ? null : rawModel
      const u = entry.message.usage
      const requestId = entry.message.id ?? entry.requestId ?? entry.uuid
      let usage: ParsedMessage['usage'] = null
      if (u && typeof requestId === 'string' && !countedRequests.has(requestId)) {
        countedRequests.add(requestId)
        usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        }
      }
      for (const block of entry.message.content) {
        if (block?.type === 'thinking') {
          push({ role: 'assistant', kind: 'thinking', content: block.thinking ?? '', toolName: null, toolUseId: null, timestamp: ts, model, usage })
        } else if (block?.type === 'text') {
          push({ role: 'assistant', kind: 'text', content: block.text ?? '', toolName: null, toolUseId: null, timestamp: ts, model, usage })
        } else if (block?.type === 'tool_use') {
          push({
            role: 'assistant',
            kind: 'tool_use',
            content: JSON.stringify(block.input ?? {}),
            toolName: block.name ?? null,
            toolUseId: block.id ?? null,
            timestamp: ts,
            model,
            usage,
          })
        } else {
          continue
        }
        usage = null // only the first stored block of a response carries its usage
      }
    } else if (entry.type === 'system') {
      push({
        role: 'system',
        kind: 'system',
        content: typeof entry.content === 'string' ? entry.content : entry.subtype ?? null,
        toolName: null,
        toolUseId: null,
        timestamp: ts,
      })
    }
  }

  if (messages.length === 0) return null
  // The filename is the canonical session id: resumed/forked sessions embed the
  // parent's sessionId in early entries, which would collide across files.
  return {
    harness: 'claude',
    externalId: path.basename(file, '.jsonl'),
    sourcePath: file,
    projectPath: cwd,
    title,
    startedAt,
    endedAt,
    messages,
  }
}

/** Whether one path equals or contains the other. */
function pathsRelated(a: string, b: string): boolean {
  const na = path.resolve(a)
  const nb = path.resolve(b)
  return na === nb || na.startsWith(nb + path.sep) || nb.startsWith(na + path.sep)
}

/** MCP servers registered at Claude Code's local scope (~/.claude.json) for this project. */
function claudeLocalServers(root: string): Record<string, unknown> {
  const config = readJson(path.join(os.homedir(), '.claude.json'))
  const projects = (config?.projects ?? {}) as Record<string, { mcpServers?: Record<string, unknown> }>
  const servers: Record<string, unknown> = {}
  for (const [projectPath, entry] of Object.entries(projects)) {
    if (!pathsRelated(projectPath, root)) continue
    Object.assign(servers, entry.mcpServers ?? {})
  }
  return servers
}

export const claude: HarnessAdapter = {
  id: 'claude',
  label: 'Claude Code',
  layout: { agentFile: 'CLAUDE.md', skillsDir: '.claude/skills', mcpConfig: '.mcp.json' },

  // ~/.claude/projects/<project-slug>/<session-uuid>.jsonl
  discoverSessionFiles(home) {
    const projects = path.join(home, '.claude', 'projects')
    const out: string[] = []
    for (const dir of safeReaddir(projects)) {
      const abs = path.join(projects, dir)
      if (!isDir(abs)) continue
      for (const file of safeReaddir(abs)) {
        if (file.endsWith('.jsonl')) out.push(path.join(abs, file))
      }
    }
    return out
  },

  parseSession: parseClaudeTranscript,

  // Claude Code "local" scope servers live in ~/.claude.json keyed by the directory the
  // session was launched from, which may be the repo root or an ancestor/descendant of it.
  // They are outside the declared layout, so they are scanned here; sync writes them to
  // whichever project MCP config the artifact targets, which promotes them to shareable scope.
  scanExtraProjectArtifacts(root) {
    return mcpServerArtifacts('claude', '~/.claude.json', claudeLocalServers(root))
  },

  scanGlobalArtifacts(home) {
    const config = readJson(path.join(home, '.claude.json'))
    if (!config) return []
    return mcpServerArtifacts('claude', '~/.claude.json', (config.mcpServers ?? {}) as Record<string, unknown>)
  },

  removeGlobalMcpServer(home, name) {
    return removeMcpServerFromJsonFile(path.join(home, '.claude.json'), name)
  },
}
