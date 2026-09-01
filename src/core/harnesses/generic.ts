import type { HarnessAdapter } from './types.js'

/**
 * Cross-harness conventions (AGENTS.md / AGENT.md, .agents/skills) not owned by any single
 * tool. Targeting `generic` is how you deploy an artifact in the vendor-neutral layout that
 * every harness with AGENTS.md support can read.
 */
export const generic: HarnessAdapter = {
  id: 'generic',
  label: 'Generic',
  // AGENT.md is the older singular spelling: still read, never written back.
  layout: { agentFile: 'AGENTS.md', agentFileAliases: ['AGENT.md'], skillsDir: '.agents/skills' },
}
