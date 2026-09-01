import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { HARNESSES } from './harnesses/index.js'
import type { HarnessAdapter } from './harnesses/types.js'

/** Harnesses installed on this machine, judged by their global config dir (~/.claude, ~/.codex, ...). */
export function installedHarnesses(home = os.homedir()): HarnessAdapter[] {
  return HARNESSES.filter((h) => h.globalConfigDir && fs.existsSync(path.join(home, h.globalConfigDir)))
}

export interface DiscoveredProject {
  path: string
  /** Harness ids with evidence of use in this project, sorted. */
  harnesses: string[]
  git: boolean
  /** Already registered in the Daiko store. */
  registered: boolean
}

/** Nearest ancestor (or the dir itself) containing .git; null when outside any repo. */
export function gitRoot(dir: string): string | null {
  let current = path.resolve(dir)
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Every project the installed harnesses have been used in — deterministically, without
 * walking the disk. Two sources: each adapter reads its own global state (config project
 * maps, workspace storage), and previously imported sessions contribute their recorded
 * project paths (so run the session import first for full coverage). Paths are collapsed
 * to their git root when inside a repo (session cwds are often subdirectories), deduped,
 * and dropped when the directory no longer exists. $HOME and its ancestors are excluded:
 * sessions do start there, but "add your home directory as a project" is never the answer.
 */
export async function discoverProjects(db: Kysely<DB>, home = os.homedir()): Promise<DiscoveredProject[]> {
  const homeAbs = path.resolve(home)
  const byPath = new Map<string, Set<string>>()
  const record = (harness: string, dir: string): void => {
    let abs = path.resolve(dir)
    try {
      if (!fs.statSync(abs).isDirectory()) return
    } catch {
      return
    }
    abs = gitRoot(abs) ?? abs
    if (abs === homeAbs || homeAbs.startsWith(abs + path.sep)) return
    const set = byPath.get(abs) ?? new Set<string>()
    set.add(harness)
    byPath.set(abs, set)
  }

  for (const h of installedHarnesses(home)) {
    for (const dir of h.discoverProjects?.(home) ?? []) record(h.id, dir)
  }
  const sessionPaths = await db
    .selectFrom('sessions')
    .select(['harness', 'project_path'])
    .distinct()
    .where('project_path', 'is not', null)
    .execute()
  for (const row of sessionPaths) record(row.harness, row.project_path!)

  const registered = new Set(
    (await db.selectFrom('projects').select('root_path').execute()).map((p) => path.resolve(p.root_path)),
  )
  return [...byPath.entries()]
    .map(([p, harnesses]) => ({
      path: p,
      harnesses: [...harnesses].sort(),
      git: fs.existsSync(path.join(p, '.git')),
      registered: registered.has(p),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}
