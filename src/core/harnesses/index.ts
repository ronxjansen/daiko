import type { HarnessAdapter } from './types.js'
import { claude } from './claude.js'
import { codex } from './codex.js'
import { cursor } from './cursor.js'
import { gemini } from './gemini.js'
import { generic } from './generic.js'
import { goose } from './goose.js'
import { hermes } from './hermes.js'
import { kilocode } from './kilocode.js'
import { opencode } from './opencode.js'
import { pi } from './pi.js'

export type { HarnessAdapter, ParsedMessage, ParsedSession, ScannedArtifact } from './types.js'

/**
 * All supported harnesses. To add one: create an adapter file next to this one
 * implementing HarnessAdapter and list it here — core scan/import/sync, the CLI,
 * the API, and the web UI all derive their behavior from this registry. Order matters
 * only for shared render paths (AGENTS.md, .agents/skills): the first listed target
 * keeps the attribution.
 */
export const HARNESSES: HarnessAdapter[] = [claude, codex, gemini, cursor, goose, kilocode, opencode, pi, hermes, generic]

const byId = new Map(HARNESSES.map((h) => [h.id, h]))

export function harnessById(id: string): HarnessAdapter | undefined {
  return byId.get(id)
}

/** Harnesses whose sessions can be discovered and imported. */
export function sessionHarnesses(): HarnessAdapter[] {
  return HARNESSES.filter((h) => (h.discoverSessionFiles && h.parseSession) || h.discoverDbSessions)
}
