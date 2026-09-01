import { createHash } from 'node:crypto'
import type { SkillFile } from './harnesses/types.js'

export const hashOf = (content: string) => createHash('sha256').update(content).digest('hex')

export const hashBytes = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

/** Raw bytes of a bundled skill file, whichever way it was encoded. */
export const skillFileBytes = (f: SkillFile) => Buffer.from(f.content, f.encoding)

/** Bundled skill files as stored in versions.files: JSON array, or null when a skill is just SKILL.md. */
export const serializeSkillFiles = (files?: SkillFile[] | null): string | null =>
  files && files.length > 0 ? JSON.stringify(files) : null

export function parseSkillFiles(json: string | null): SkillFile[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as SkillFile[]) : []
  } catch {
    return []
  }
}

/**
 * Identity of one artifact revision: its own file plus its bundle. Two scans that produce
 * the same content key are the same revision no matter which harness they came from —
 * this is what lets a skill found in .claude/skills and .codex/skills collapse into one
 * canonical artifact instead of two harness-bound copies.
 */
export const contentKey = (content: string, files?: SkillFile[] | null): string =>
  `${hashOf(content)}|${serializeSkillFiles(files) ?? ''}`
