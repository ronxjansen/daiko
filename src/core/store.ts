import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Kysely } from 'kysely'
import type { ArtifactsTable, DB } from '../db/schema.js'
import { harnessById } from './harnesses/index.js'
import { writeFileAtomic } from './harnesses/util.js'
import { scanGlobalMcpServers, scanProject, type ScannedArtifact } from './scan.js'

const now = () => new Date().toISOString()
export const hashOf = (content: string) => createHash('sha256').update(content).digest('hex')

export interface AddSummary {
  project: string
  added: number
  updated: number
  unchanged: number
}

type UpsertResult = 'added' | 'updated' | 'unchanged'

/** Append a new version if the content differs from the current (or pinned) version. */
async function versionArtifact(
  db: Kysely<DB>,
  artifact: Pick<ArtifactsTable, 'id' | 'current_version_id' | 'pinned_version_id'>,
  content: string,
  source: string,
): Promise<Exclude<UpsertResult, 'added'>> {
  const hash = hashOf(content)
  const knownIds = [artifact.current_version_id, artifact.pinned_version_id].filter((v): v is string => v !== null)
  if (knownIds.length > 0) {
    const known = await db.selectFrom('versions').select('hash').where('id', 'in', knownIds).execute()
    if (known.some((v) => v.hash === hash)) return 'unchanged'
  }
  const versionId = randomUUID()
  await db
    .insertInto('versions')
    .values({ id: versionId, artifact_id: artifact.id, hash, content, source, created_at: now() })
    .execute()
  await db.updateTable('artifacts').set({ current_version_id: versionId, updated_at: now() }).where('id', '=', artifact.id).execute()
  return 'updated'
}

/** Insert or version an artifact. projectId null = global artifact shared by all projects. */
async function upsertArtifact(db: Kysely<DB>, projectId: string | null, s: ScannedArtifact): Promise<UpsertResult> {
  const hash = hashOf(s.content)
  let query = db
    .selectFrom('artifacts')
    .selectAll()
    .where('type', '=', s.type)
    .where('name', '=', s.name)
    .where('rel_path', '=', s.relPath)
  query = projectId ? query.where('project_id', '=', projectId) : query.where('project_id', 'is', null)
  const existing = await query.executeTakeFirst()

  if (!existing) {
    const artifactId = randomUUID()
    const versionId = randomUUID()
    await db
      .insertInto('artifacts')
      .values({
        id: artifactId,
        project_id: projectId,
        type: s.type,
        name: s.name,
        rel_path: s.relPath,
        harness: s.harness,
        current_version_id: versionId,
        pinned_version_id: null,
        created_at: now(),
        updated_at: now(),
      })
      .execute()
    await db
      .insertInto('versions')
      .values({ id: versionId, artifact_id: artifactId, hash, content: s.content, source: 'add', created_at: now() })
      .execute()
    return 'added'
  }

  return versionArtifact(db, existing, s.content, 'add')
}

/** Artifacts shared into a project from elsewhere (via project_artifacts links). */
async function linkedArtifacts(db: Kysely<DB>, projectId: string): Promise<ArtifactsTable[]> {
  return db
    .selectFrom('project_artifacts')
    .innerJoin('artifacts', 'artifacts.id', 'project_artifacts.artifact_id')
    .selectAll('artifacts')
    .where('project_artifacts.project_id', '=', projectId)
    .execute()
}

/** Scan a repo and upsert its artifacts into the central store, creating new versions on change. */
export async function addProject(db: Kysely<DB>, root: string): Promise<AddSummary> {
  const abs = path.resolve(root)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`)
  }
  let project = await db.selectFrom('projects').selectAll().where('root_path', '=', abs).executeTakeFirst()
  if (!project) {
    project = { id: randomUUID(), name: path.basename(abs), root_path: abs, created_at: now(), updated_at: now() }
    await db.insertInto('projects').values(project).execute()
  }

  const summary: AddSummary = { project: project.name, added: 0, updated: 0, unchanged: 0 }
  // Files that came in through a share link belong to the shared artifact's lineage:
  // scanning them versions the shared artifact instead of forking a project-owned copy.
  const linked = new Map((await linkedArtifacts(db, project.id)).map((a) => [`${a.type}:${a.name}`, a]))
  for (const s of scanProject(abs)) {
    const shared = linked.get(`${s.type}:${s.name}`)
    summary[shared ? await versionArtifact(db, shared, s.content, 'add') : await upsertArtifact(db, project.id, s)]++
  }

  await db.updateTable('projects').set({ updated_at: now() }).where('id', '=', project.id).execute()
  return summary
}

export interface GlobalAddSummary {
  added: number
  updated: number
  unchanged: number
}

/** Scan every registered harness's global config (~/.claude.json, ~/.codex/config.toml, ...) and upsert global MCP servers. */
export async function addGlobalMcpServers(db: Kysely<DB>): Promise<GlobalAddSummary> {
  const summary: GlobalAddSummary = { added: 0, updated: 0, unchanged: 0 }
  for (const s of scanGlobalMcpServers()) {
    summary[await upsertArtifact(db, null, s)]++
  }
  return summary
}

export interface SyncSummary {
  written: string[]
  missingProject?: boolean
}

/**
 * Where an artifact lands inside a project tree. Shared MCP servers whose origin is a
 * harness-global config (~/...) are written to the project-level config file instead.
 */
export function projectRelPath(artifact: Pick<ArtifactsTable, 'type' | 'rel_path' | 'harness'>): string {
  if (artifact.type === 'mcp_server' && artifact.rel_path.startsWith('~')) {
    return harnessById(artifact.harness)?.projectMcpConfigPath ?? '.mcp.json'
  }
  return artifact.rel_path
}

/** Write stored artifacts (pinned version wins over current) back into the project working tree. */
export async function syncProject(db: Kysely<DB>, root: string): Promise<SyncSummary> {
  const abs = path.resolve(root)
  const project = await db.selectFrom('projects').selectAll().where('root_path', '=', abs).executeTakeFirst()
  if (!project) return { written: [], missingProject: true }

  const owned = await db.selectFrom('artifacts').selectAll().where('project_id', '=', project.id).execute()
  const artifacts = [...owned, ...(await linkedArtifacts(db, project.id))]
  const written: string[] = []
  const mcpByFile = new Map<string, Record<string, unknown>>()

  for (const artifact of artifacts) {
    const versionId = artifact.pinned_version_id ?? artifact.current_version_id
    if (!versionId) continue
    const version = await db.selectFrom('versions').selectAll().where('id', '=', versionId).executeTakeFirst()
    if (!version) continue
    const relPath = projectRelPath(artifact)

    if (artifact.type === 'mcp_server') {
      const entry = mcpByFile.get(relPath) ?? {}
      try {
        entry[artifact.name] = JSON.parse(version.content)
      } catch {
        continue
      }
      mcpByFile.set(relPath, entry)
    } else {
      const target = path.join(abs, relPath)
      const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
      if (prev === version.content) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, version.content)
      written.push(relPath)
    }
  }

  // MCP servers are merged per config file, preserving unrelated keys and unmanaged servers.
  for (const [relPath, servers] of mcpByFile) {
    const target = path.join(abs, relPath)
    let existing: Record<string, unknown> = {}
    if (fs.existsSync(target)) {
      try {
        existing = JSON.parse(fs.readFileSync(target, 'utf8'))
      } catch {
        existing = {}
      }
    }
    const existingServers = (existing.mcpServers ?? {}) as Record<string, unknown>
    const merged = { ...existing, mcpServers: { ...existingServers, ...servers } }
    const out = JSON.stringify(merged, null, 2) + '\n'
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== out) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, out)
      written.push(relPath)
    }
  }

  return { written }
}

/**
 * Share an artifact into a project and write it to disk. No-op when the artifact already
 * belongs to (or is linked to) the project.
 */
export async function attachArtifact(db: Kysely<DB>, projectId: string, artifactId: string): Promise<SyncSummary> {
  const project = await db.selectFrom('projects').selectAll().where('id', '=', projectId).executeTakeFirstOrThrow(() => new Error('project not found'))
  const artifact = await db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirstOrThrow(() => new Error('artifact not found'))
  if (artifact.project_id !== project.id) {
    await db
      .insertInto('project_artifacts')
      .values({ project_id: project.id, artifact_id: artifact.id, created_at: now() })
      .onConflict((oc) => oc.doNothing())
      .execute()
  }
  if (!fs.existsSync(project.root_path)) return { written: [] }
  return syncProject(db, project.root_path)
}

/** Remove a shared artifact from a project: drop the link and delete it from the working tree. */
export async function detachArtifact(db: Kysely<DB>, projectId: string, artifactId: string): Promise<{ removed: string[] }> {
  const project = await db.selectFrom('projects').selectAll().where('id', '=', projectId).executeTakeFirstOrThrow(() => new Error('project not found'))
  const artifact = await db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirstOrThrow(() => new Error('artifact not found'))
  if (artifact.project_id === project.id) {
    // The origin copy is not a share; a later sync would just write it back.
    throw new Error('artifact originates from this project; delete the artifact instead')
  }

  await db
    .deleteFrom('project_artifacts')
    .where('project_id', '=', project.id)
    .where('artifact_id', '=', artifact.id)
    .execute()

  if (!fs.existsSync(project.root_path)) return { removed: [] }
  return { removed: removeFromProjectTree(project.root_path, artifact) }
}

/** Delete an artifact's synced copy from a project working tree. Returns removed rel paths. */
function removeFromProjectTree(root: string, artifact: Pick<ArtifactsTable, 'type' | 'name' | 'rel_path' | 'harness'>): string[] {
  const removed: string[] = []
  const relPath = projectRelPath(artifact)

  if (artifact.type === 'skill') {
    // Remove the whole skill directory, not just SKILL.md.
    const dir = path.join(root, path.dirname(relPath))
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(path.dirname(relPath))
    }
  } else if (artifact.type === 'mcp_server') {
    const target = path.join(root, relPath)
    if (fs.existsSync(target)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
        const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>
        if (artifact.name in servers) {
          delete servers[artifact.name]
          writeFileAtomic(target, JSON.stringify({ ...parsed, mcpServers: servers }, null, 2) + '\n')
          removed.push(relPath)
        }
      } catch {
        // invalid JSON: leave the file alone
      }
    }
  } else {
    const target = path.join(root, relPath)
    if (fs.existsSync(target)) {
      fs.rmSync(target)
      removed.push(relPath)
    }
  }

  return removed
}

export interface DeleteSummary {
  deleted: { type: string; name: string }
  /** Set when the artifact was a global MCP server and its harness config was edited. */
  global: { file: string; status: 'removed' | 'absent' } | null
  detached: Array<{ project: string; removed: string[] }>
}

/**
 * Delete an artifact everywhere it is materialized: the entry in its harness's global
 * config (so the next scan cannot resurrect it), the synced copies in attached project
 * trees, and finally the DB row (versions and project links cascade). A failed global
 * config edit aborts the whole delete — the store must never report an artifact gone
 * while the harness still loads it.
 */
export async function deleteArtifact(db: Kysely<DB>, artifactId: string, home = os.homedir()): Promise<DeleteSummary> {
  const artifact = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('id', '=', artifactId)
    .executeTakeFirstOrThrow(() => new Error('artifact not found'))

  let global: DeleteSummary['global'] = null
  if (artifact.project_id === null && artifact.type === 'mcp_server' && artifact.rel_path.startsWith('~')) {
    const harness = harnessById(artifact.harness)
    if (harness?.removeGlobalMcpServer) {
      const result = harness.removeGlobalMcpServer(home, artifact.name)
      if (result.status === 'failed') {
        throw new Error(
          `not deleted: could not remove "${artifact.name}" from ${result.file} (${result.reason}); fix that file or remove the entry manually, then retry`,
        )
      }
      global = { file: result.file, status: result.status }
    }
  }

  const attached = await db
    .selectFrom('project_artifacts')
    .innerJoin('projects', 'projects.id', 'project_artifacts.project_id')
    .select(['projects.name', 'projects.root_path'])
    .where('project_artifacts.artifact_id', '=', artifact.id)
    .execute()
  const detached: DeleteSummary['detached'] = []
  for (const p of attached) {
    if (!fs.existsSync(p.root_path)) continue
    const removed = removeFromProjectTree(p.root_path, artifact)
    if (removed.length > 0) detached.push({ project: p.name, removed })
  }

  await db.deleteFrom('artifacts').where('id', '=', artifact.id).execute()
  return { deleted: { type: artifact.type, name: artifact.name }, global, detached }
}
