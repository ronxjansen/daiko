import type { HarnessAdapter, ScannedArtifact } from './types.js'
import { scanAgentFile } from './util.js'

/** Cross-harness conventions (AGENTS.md / AGENT.md) not owned by any single tool. */
export const generic: HarnessAdapter = {
  id: 'generic',
  label: 'Generic',

  scanProjectArtifacts(root) {
    const out: ScannedArtifact[] = []
    for (const file of ['AGENTS.md', 'AGENT.md']) {
      const found = scanAgentFile(root, file, 'generic')
      if (found) out.push(found)
    }
    return out
  },
}
