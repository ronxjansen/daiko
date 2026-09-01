import path from 'node:path'
import type { HarnessAdapter } from './types.js'
import { readSqlite } from './util.js'

/**
 * opencode (opencode.ai). Project MCP servers live in opencode.json under a top-level
 * "mcp" key with an opencode-specific shape ({type: local|remote, command: [...]}), not
 * an mcpServers map, so opencode is not offered as an MCP source or target. Sessions sit
 * in ~/.local/share/opencode/opencode.db (with two older JSON layouts still on disk for
 * 2025 installs); Daiko has no parser for them yet.
 */
export const opencode: HarnessAdapter = {
  id: 'opencode',
  label: 'opencode',
  globalConfigDir: '.config/opencode',
  // Reads AGENTS.md (or CLAUDE.md) up the tree and writes AGENTS.md itself on /init.
  // Skills follow the Agent Skills standard in .opencode/skills (plus the shared
  // .claude/skills and .agents/skills, which their own harnesses cover here).
  layout: { agentFile: 'AGENTS.md', skillsDir: '.opencode/skills' },

  // Every project opencode has opened is a row in opencode.db; sessions record the
  // directory they ran in, which catches worktrees under a project too.
  discoverProjects(home) {
    const db = path.join(home, '.local', 'share', 'opencode', 'opencode.db')
    return readSqlite(db, [] as string[], (sql) => {
      const worktrees = sql.prepare('SELECT DISTINCT worktree FROM project WHERE worktree IS NOT NULL').all() as Array<{ worktree: string }>
      const dirs = sql.prepare('SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL').all() as Array<{ directory: string }>
      return [...worktrees.map((r) => r.worktree), ...dirs.map((r) => r.directory)]
    }).filter((p) => p !== '/')
  },
}
