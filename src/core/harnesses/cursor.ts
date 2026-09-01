import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessAdapter } from './types.js'
import { readJson, removeMcpServerFromJsonFile, safeReaddir, scanMcpJson } from './util.js'

/** Cursor's Electron user-data dir; the one harness whose global state is OS-specific. */
function cursorDataDir(home: string): string {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor')
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Cursor')
  }
  return path.join(home, '.config', 'Cursor')
}

export const cursor: HarnessAdapter = {
  id: 'cursor',
  label: 'Cursor',
  globalConfigDir: '.cursor',
  layout: { agentFile: '.cursorrules', skillsDir: '.cursor/skills', mcpConfig: '.cursor/mcp.json' },

  // Every folder ever opened gets a workspaceStorage/<hash>/workspace.json with a file:// URI.
  discoverProjects(home) {
    const storage = path.join(cursorDataDir(home), 'User', 'workspaceStorage')
    const out: string[] = []
    for (const dir of safeReaddir(storage)) {
      const doc = readJson(path.join(storage, dir, 'workspace.json'))
      const folder = typeof doc?.folder === 'string' ? doc.folder : null
      if (!folder?.startsWith('file://')) continue
      try {
        out.push(fileURLToPath(folder))
      } catch {
        // malformed URI: skip entry
      }
    }
    return out
  },

  scanGlobalArtifacts(home) {
    return scanMcpJson(path.join(home, '.cursor', 'mcp.json'), '~/.cursor/mcp.json', 'cursor')
  },

  removeGlobalMcpServer(home, name) {
    return removeMcpServerFromJsonFile(path.join(home, '.cursor', 'mcp.json'), name)
  },
}
