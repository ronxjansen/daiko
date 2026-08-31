import path from 'node:path'
import type { HarnessAdapter, ScannedArtifact } from './types.js'
import { removeMcpServerFromJsonFile, scanAgentFile, scanMcpJson } from './util.js'

export const cursor: HarnessAdapter = {
  id: 'cursor',
  label: 'Cursor',
  projectMcpConfigPath: '.cursor/mcp.json',

  scanProjectArtifacts(root) {
    const out: ScannedArtifact[] = []
    const rules = scanAgentFile(root, '.cursorrules', 'cursor')
    if (rules) out.push(rules)
    out.push(...scanMcpJson(path.join(root, '.cursor', 'mcp.json'), '.cursor/mcp.json', 'cursor'))
    return out
  },

  scanGlobalArtifacts(home) {
    return scanMcpJson(path.join(home, '.cursor', 'mcp.json'), '~/.cursor/mcp.json', 'cursor')
  },

  removeGlobalMcpServer(home, name) {
    return removeMcpServerFromJsonFile(path.join(home, '.cursor', 'mcp.json'), name)
  },
}
