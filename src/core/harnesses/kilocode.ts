import type { HarnessAdapter } from './types.js'

/**
 * Kilo Code (kilo.ai; VS Code extension + CLI). The .kilocode project layout is the one
 * both generations honor: the 2026 OpenCode-based rewrite still reads it alongside its
 * new .kilo/kilo.jsonc files. Sessions live in VS Code's globalStorage task dirs (legacy)
 * or ~/.local/share/kilo/kilo.db (current) — neither maps to a project without reading
 * VS Code's state.vscdb, so Kilo contributes no sessions or project discovery yet.
 */
export const kilocode: HarnessAdapter = {
  id: 'kilocode',
  label: 'Kilo Code',
  globalConfigDir: '.kilocode',
  // Reads AGENTS.md natively; .kilocode/rules/ is a directory of loose rule files rather
  // than a single instruction document, so it is left alone. mcp.json uses the standard
  // mcpServers map and skills follow the Agent Skills standard.
  layout: { agentFile: 'AGENTS.md', skillsDir: '.kilocode/skills', mcpConfig: '.kilocode/mcp.json' },
}
