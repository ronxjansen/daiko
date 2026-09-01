import os from 'node:os'
import { contentKey } from './content.js'
import { HARNESSES } from './harnesses/index.js'
import type { ScannedArtifact, SkillFile } from './harnesses/types.js'
import { scanLayout } from './harnesses/util.js'
import type { ArtifactType } from '../db/schema.js'

export type { ScannedArtifact }

/**
 * Scan a project root for agent instruction files, skills, and MCP server configs, using
 * each harness's declared layout plus whatever it contributes outside it. A harness's
 * extras never shadow its own layout: Claude's local-scope MCP servers only apply to
 * servers the project's .mcp.json does not already define.
 */
export function scanProject(root: string): ScannedArtifact[] {
  const out: ScannedArtifact[] = []
  for (const h of HARNESSES) {
    const fromLayout = h.layout ? scanLayout(root, h.id, h.layout) : []
    out.push(...fromLayout)
    const claimed = new Set(fromLayout.map((a) => `${a.type}:${a.name}`))
    for (const extra of h.scanExtraProjectArtifacts?.(root) ?? []) {
      if (!claimed.has(`${extra.type}:${extra.name}`)) out.push(extra)
    }
  }
  return out
}

/**
 * Scan harness-wide configs for globally registered MCP servers. These are stored with
 * project_id = null and are available to every project.
 */
export function scanGlobalMcpServers(home = os.homedir()): ScannedArtifact[] {
  return HARNESSES.flatMap((h) => h.scanGlobalArtifacts?.(home) ?? [])
}

/** One distinct revision of a canonical artifact, and the harnesses it was read from. */
export interface ScanVariant {
  content: string
  files?: SkillFile[]
  /** Harnesses whose copy holds exactly this content. */
  harnesses: string[]
  /** Where the first of those copies was read from — used as the artifact's provenance. */
  originPath: string
}

/**
 * One canonical artifact assembled from every harness that carries it. `targets` is the
 * union of contributing harnesses, so a skill vendored into .claude/skills and
 * .codex/skills becomes a single artifact deployed to both. More than one variant means
 * the copies have drifted apart and the caller has to decide which one is the truth.
 */
export interface ScanGroup {
  type: ArtifactType
  name: string
  targets: string[]
  variants: ScanVariant[]
}

/**
 * Collapse harness-bound scan results into canonical artifacts keyed by type and name.
 * This is where "one skill in three harnesses" stops being three rows.
 */
export function groupScanned(scanned: ScannedArtifact[]): ScanGroup[] {
  const groups = new Map<string, ScanGroup>()
  for (const a of scanned) {
    const key = `${a.type}:${a.name}`
    const group = groups.get(key) ?? { type: a.type, name: a.name, targets: [], variants: [] }
    if (!group.targets.includes(a.harness)) group.targets.push(a.harness)
    const ck = contentKey(a.content, a.files)
    const variant = group.variants.find((v) => contentKey(v.content, v.files) === ck)
    if (variant) {
      if (!variant.harnesses.includes(a.harness)) variant.harnesses.push(a.harness)
    } else {
      group.variants.push({ content: a.content, files: a.files, harnesses: [a.harness], originPath: a.originPath })
    }
    groups.set(key, group)
  }
  return [...groups.values()]
}
