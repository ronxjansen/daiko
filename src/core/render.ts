import path from 'node:path'
import type { ArtifactType } from '../db/schema.js'
import { HARNESSES, harnessById } from './harnesses/index.js'

/** A canonical artifact projected into one harness's layout. */
export interface RenderedPath {
  /** Target harness this path belongs to. */
  harness: string
  /** Project-relative POSIX path. */
  relPath: string
}

/** Identity of a canonical artifact — everything rendering needs to know about it. */
export type Renderable = { type: ArtifactType; name: string }

/**
 * Where one harness expects an artifact of this type and name inside a project tree, or
 * null when that harness has no location for it (Codex has no project MCP config, Gemini
 * ships no skills directory). Returning null is the honest answer: sync reports the
 * artifact as undeployable for that target instead of writing some other harness's file.
 */
export function renderPath(harness: string, artifact: Renderable): string | null {
  const layout = harnessById(harness)?.layout
  if (!layout) return null
  switch (artifact.type) {
    case 'skill':
      return layout.skillsDir ? path.posix.join(layout.skillsDir, artifact.name, 'SKILL.md') : null
    case 'agent_md':
      return layout.agentFile ?? null
    case 'mcp_server':
      return layout.mcpConfig ?? null
    default:
      return null
  }
}

/**
 * Every file a canonical artifact materializes to, one entry per target harness that can
 * host it. Paths are deduplicated — Codex and Generic both read AGENTS.md, and one file
 * serves both — with the first target in registry order keeping the attribution.
 */
export function renderPaths(artifact: Renderable, targets: Iterable<string>): RenderedPath[] {
  const wanted = new Set(targets)
  const seen = new Set<string>()
  const out: RenderedPath[] = []
  for (const h of HARNESSES) {
    if (!wanted.has(h.id)) continue
    const relPath = renderPath(h.id, artifact)
    if (!relPath || seen.has(relPath)) continue
    seen.add(relPath)
    out.push({ harness: h.id, relPath })
  }
  return out
}

/** Harnesses that can host a given artifact type at all: the support matrix, derived from the registry. */
export function harnessesSupporting(type: ArtifactType): string[] {
  return HARNESSES.filter((h) => renderPath(h.id, { type, name: 'x' }) !== null).map((h) => h.id)
}

/** The support matrix for every type, as served to the CLI and web UI. */
export function supportMatrix(): Record<ArtifactType, string[]> {
  return {
    skill: harnessesSupporting('skill'),
    agent_md: harnessesSupporting('agent_md'),
    mcp_server: harnessesSupporting('mcp_server'),
  }
}
