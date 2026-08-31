import fs from 'node:fs'
import path from 'node:path'
import type { GlobalRemoveResult, ScannedArtifact } from './types.js'

export function readJsonl(file: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip malformed lines
    }
  }
  return out
}

/** Flatten Anthropic-style block content (string, or array of {type:'text'} blocks) into plain text. */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          const b = block as Record<string, any>
          if (typeof b.text === 'string') return b.text
          return JSON.stringify(b)
        }
        return ''
      })
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

export function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function* walk(dir: string): Generator<string> {
  for (const entry of safeReaddir(dir)) {
    const abs = path.join(dir, entry)
    if (isDir(abs)) yield* walk(abs)
    else yield abs
  }
}

/** Read a plain agent instruction file (CLAUDE.md, AGENTS.md, .cursorrules, ...) if present. */
export function scanAgentFile(root: string, relPath: string, harness: string): ScannedArtifact | null {
  const p = path.join(root, relPath)
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null
  return { type: 'agent_md', name: relPath, relPath, harness, content: fs.readFileSync(p, 'utf8') }
}

/** One mcp_server artifact per entry of a {mcpServers: {...}} map. */
export function mcpServerArtifacts(harness: string, relPath: string, servers: Record<string, unknown>): ScannedArtifact[] {
  return Object.entries(servers).map(([name, config]) => ({
    type: 'mcp_server' as const,
    name,
    relPath,
    harness,
    content: JSON.stringify(config, null, 2),
  }))
}

/** MCP servers from a JSON config file with a top-level mcpServers key. */
export function scanMcpJson(file: string, relPath: string, harness: string): ScannedArtifact[] {
  const parsed = readJson(file)
  if (!parsed) return []
  return mcpServerArtifacts(harness, relPath, (parsed.mcpServers ?? {}) as Record<string, unknown>)
}

/** Write via a temp file + rename so a crash mid-write can never truncate a config file. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

/**
 * Remove one entry from a JSON config's top-level mcpServers map, preserving every other
 * key in the file. Refuses to touch a file that does not parse: these configs (notably
 * ~/.claude.json) hold unrelated harness state we must never clobber.
 */
export function removeMcpServerFromJsonFile(file: string, name: string): GlobalRemoveResult {
  if (!fs.existsSync(file)) return { status: 'absent', file }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { status: 'failed', file, reason: `invalid JSON: ${err instanceof Error ? err.message : err}` }
  }
  const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>
  if (!(name in servers)) return { status: 'absent', file }
  delete servers[name]
  writeFileAtomic(file, JSON.stringify({ ...parsed, mcpServers: servers }, null, 2) + '\n')
  return { status: 'removed', file }
}
