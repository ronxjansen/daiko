import path from 'node:path'
import type { HarnessAdapter } from './types.js'
import { removeMcpServerFromJsonFile, scanMcpJson } from './util.js'

export const cursor: HarnessAdapter = {
  id: 'cursor',
  label: 'Cursor',
  layout: { agentFile: '.cursorrules', skillsDir: '.cursor/skills', mcpConfig: '.cursor/mcp.json' },

  scanGlobalArtifacts(home) {
    return scanMcpJson(path.join(home, '.cursor', 'mcp.json'), '~/.cursor/mcp.json', 'cursor')
  },

  removeGlobalMcpServer(home, name) {
    return removeMcpServerFromJsonFile(path.join(home, '.cursor', 'mcp.json'), name)
  },
}
