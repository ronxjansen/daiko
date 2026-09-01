import fs from 'node:fs'
import path from 'node:path'
import type { GlobalRemoveResult, HarnessLayout, ScannedArtifact, SkillFile } from './types.js'
import { INSTRUCTIONS_NAME } from './types.js'

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

/**
 * Read a plain agent instruction file (CLAUDE.md, AGENTS.md, .cursorrules, ...) if present.
 * Every one of them is the same canonical object — a project's instructions — so they all
 * scan under INSTRUCTIONS_NAME and differ only in the path they were read from.
 */
export function scanAgentFile(root: string, relPath: string, harness: string): ScannedArtifact | null {
  const p = path.join(root, relPath)
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null
  return { type: 'agent_md', name: INSTRUCTIONS_NAME, harness, originPath: relPath, content: fs.readFileSync(p, 'utf8') }
}

/** One mcp_server artifact per entry of a {mcpServers: {...}} map. */
export function mcpServerArtifacts(harness: string, originPath: string, servers: Record<string, unknown>): ScannedArtifact[] {
  return Object.entries(servers).map(([name, config]) => ({
    type: 'mcp_server' as const,
    name,
    harness,
    originPath,
    content: JSON.stringify(config, null, 2),
  }))
}

/** MCP servers from a JSON config file with a top-level mcpServers key. */
export function scanMcpJson(file: string, originPath: string, harness: string): ScannedArtifact[] {
  const parsed = readJson(file)
  if (!parsed) return []
  return mcpServerArtifacts(harness, originPath, (parsed.mcpServers ?? {}) as Record<string, unknown>)
}

/** Write via a temp file + rename so a crash mid-write can never truncate a config file. */
export function writeFileAtomic(file: string, content: string | Buffer): void {
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

/** Directories/files never worth storing inside a skill bundle. */
const SKILL_IGNORE = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.DS_Store', '.pytest_cache'])

/**
 * Per-file cap for bundled skill files. Skills are configuration, not an asset store;
 * anything larger is left on disk rather than pushed through SQLite and the web UI.
 */
export const MAX_SKILL_FILE_BYTES = 1024 * 1024

/** A buffer that does not round-trip through UTF-8 (or holds NULs) must be stored base64. */
function isBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true
  return !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
}

/**
 * Every file under a skill directory except SKILL.md itself: scripts, references, assets,
 * at any depth. Symlinks are skipped (they cannot be reproduced on another machine and
 * could loop), as are ignored dirs and files over MAX_SKILL_FILE_BYTES. Sorted by path so
 * a bundle hashes identically across machines.
 */
export function collectSkillFiles(skillDir: string): SkillFile[] {
  const out: SkillFile[] = []

  const visit = (dir: string, prefix: string): void => {
    for (const entry of safeReaddir(dir).sort()) {
      if (SKILL_IGNORE.has(entry)) continue
      const abs = path.join(dir, entry)
      const rel = prefix ? `${prefix}/${entry}` : entry
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(abs)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        visit(abs, rel)
        continue
      }
      if (!stat.isFile() || rel === 'SKILL.md' || stat.size > MAX_SKILL_FILE_BYTES) continue
      let buf: Buffer
      try {
        buf = fs.readFileSync(abs)
      } catch {
        continue
      }
      const binary = isBinary(buf)
      const file: SkillFile = {
        path: rel,
        encoding: binary ? 'base64' : 'utf8',
        content: binary ? buf.toString('base64') : buf.toString('utf8'),
      }
      if ((stat.mode & 0o111) !== 0) file.exec = true
      out.push(file)
    }
  }

  visit(skillDir, '')
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Skills found under a harness's skills directory (.claude/skills, .codex/skills, ...).
 * One artifact per <skills-dir>/<name>/SKILL.md, carrying the whole skill directory:
 * SKILL.md as the artifact content, everything else as bundled files. The directory name
 * is the canonical identity, so the same skill vendored into two harnesses scans as one
 * artifact with two targets rather than two unrelated copies.
 */
export function scanSkillsDir(root: string, relDir: string, harness: string): ScannedArtifact[] {
  const skillsDir = path.join(root, ...relDir.split('/'))
  const out: ScannedArtifact[] = []
  for (const name of safeReaddir(skillsDir).sort()) {
    const dir = path.join(skillsDir, name)
    if (!isDir(dir)) continue
    const skillMd = path.join(dir, 'SKILL.md')
    if (!fs.existsSync(skillMd)) continue
    out.push({
      type: 'skill',
      name,
      harness,
      originPath: path.posix.join(relDir, name, 'SKILL.md'),
      content: fs.readFileSync(skillMd, 'utf8'),
      files: collectSkillFiles(dir),
    })
  }
  return out
}

/**
 * Everything a harness's declared layout holds in a project tree. The same declaration is
 * read here and written by src/core/render.ts, so scan and sync can never disagree about
 * where a harness keeps its files.
 */
export function scanLayout(root: string, harness: string, layout: HarnessLayout): ScannedArtifact[] {
  const out: ScannedArtifact[] = []
  for (const file of [layout.agentFile, ...(layout.agentFileAliases ?? [])]) {
    if (!file) continue
    const found = scanAgentFile(root, file, harness)
    if (found) out.push(found)
  }
  if (layout.skillsDir) out.push(...scanSkillsDir(root, layout.skillsDir, harness))
  if (layout.mcpConfig) {
    out.push(...scanMcpJson(path.join(root, ...layout.mcpConfig.split('/')), layout.mcpConfig, harness))
  }
  return out
}
