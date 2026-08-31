import os from 'node:os'
import { HARNESSES } from './harnesses/index.js'
import type { ScannedArtifact } from './harnesses/types.js'

export type { ScannedArtifact }

/** Scan a project root for agent instruction files, skills, and MCP server configs. */
export function scanProject(root: string): ScannedArtifact[] {
  return HARNESSES.flatMap((h) => h.scanProjectArtifacts?.(root) ?? [])
}

/**
 * Scan harness-wide configs for globally registered MCP servers. These are stored with
 * project_id = null and are available to every project.
 */
export function scanGlobalMcpServers(home = os.homedir()): ScannedArtifact[] {
  return HARNESSES.flatMap((h) => h.scanGlobalArtifacts?.(home) ?? [])
}
