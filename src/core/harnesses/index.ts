import type { HarnessAdapter } from './types.js'
import { claude } from './claude.js'
import { codex } from './codex.js'
import { cursor } from './cursor.js'
import { gemini } from './gemini.js'
import { generic } from './generic.js'

export type { HarnessAdapter, ParsedMessage, ParsedSession, ScannedArtifact } from './types.js'

/**
 * All supported harnesses. To add one: create an adapter file next to this one
 * implementing HarnessAdapter and list it here — core scan/import/sync, the CLI,
 * the API, and the web UI all derive their behavior from this registry.
 */
export const HARNESSES: HarnessAdapter[] = [claude, codex, gemini, cursor, generic]

const byId = new Map(HARNESSES.map((h) => [h.id, h]))

export function harnessById(id: string): HarnessAdapter | undefined {
  return byId.get(id)
}

/** Harnesses whose sessions can be discovered and imported. */
export function sessionHarnesses(): HarnessAdapter[] {
  return HARNESSES.filter((h) => h.discoverSessionFiles && h.parseSession)
}
