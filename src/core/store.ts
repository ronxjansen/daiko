import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Kysely } from 'kysely'
import type { ArtifactsTable, ArtifactType, DB } from '../db/schema.js'
import type { SkillFile } from './harnesses/types.js'
import { HARNESSES } from './harnesses/index.js'
import { collectSkillFiles, writeFileAtomic } from './harnesses/util.js'
import { contentKey, hashBytes, hashOf, parseSkillFiles, serializeSkillFiles, skillFileBytes } from './content.js'
import { renderPaths } from './render.js'
import { groupScanned, scanGlobalMcpServers, scanProject, type ScanGroup, type ScanVariant } from './scan.js'

export { hashOf, parseSkillFiles, serializeSkillFiles } from './content.js'

const now = () => new Date().toISOString()

/** Identity of a canonical artifact for rendering purposes. */
type ArtifactRow = Pick<ArtifactsTable, 'id' | 'type' | 'name'>

/**
 * A bundled file path is written under the skill's own directory and nowhere else:
 * a stored bundle is untrusted input once it has round-tripped through the DB or an edit.
 */
const isSafeBundlePath = (p: string) =>
  p.length > 0 && !path.posix.isAbsolute(p) && !path.isAbsolute(p) && !p.split(/[/\\]/).includes('..')

/** Registry order, so targets read the same everywhere they are shown. */
const orderTargets = (harnesses: Iterable<string>) => {
  const wanted = new Set(harnesses)
  const known = HARNESSES.filter((h) => wanted.has(h.id)).map((h) => h.id)
  return [...known, ...[...wanted].filter((h) => !known.includes(h)).sort()]
}

/** Harnesses an artifact is deployed to, by artifact id. */
export async function targetsFor(db: Kysely<DB>, artifactIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (artifactIds.length === 0) return out
  const rows = await db.selectFrom('artifact_targets').select(['artifact_id', 'harness']).where('artifact_id', 'in', artifactIds).execute()
  for (const row of rows) out.set(row.artifact_id, [...(out.get(row.artifact_id) ?? []), row.harness])
  for (const [id, harnesses] of out) out.set(id, orderTargets(harnesses))
  return out
}

export async function targetsOf(db: Kysely<DB>, artifactId: string): Promise<string[]> {
  return (await targetsFor(db, [artifactId])).get(artifactId) ?? []
}

/**
 * Targets an artifact renders into. Falling back to the origin harness keeps an artifact
 * deployable if its target rows ever go missing — it can never end up writing nowhere by
 * accident, only by an explicit choice.
 */
const effectiveTargets = (artifact: Pick<ArtifactsTable, 'id' | 'origin_harness'>, targets: Map<string, string[]>): string[] => {
  const rows = targets.get(artifact.id)
  return rows && rows.length > 0 ? rows : [artifact.origin_harness]
}

/** Add harnesses to an artifact's target set. Existing targets are never removed by scanning. */
export async function addTargets(db: Kysely<DB>, artifactId: string, harnesses: string[]): Promise<void> {
  if (harnesses.length === 0) return
  await db
    .insertInto('artifact_targets')
    .values(harnesses.map((harness) => ({ artifact_id: artifactId, harness, created_at: now() })))
    .onConflict((oc) => oc.doNothing())
    .execute()
}

/** Replace an artifact's target set outright — the explicit "deploy this here, not there" action. */
export async function setTargets(db: Kysely<DB>, artifactId: string, harnesses: string[]): Promise<string[]> {
  const wanted = orderTargets(harnesses)
  await db.deleteFrom('artifact_targets').where('artifact_id', '=', artifactId).execute()
  await addTargets(db, artifactId, wanted)
  await db.updateTable('artifacts').set({ updated_at: now() }).where('id', '=', artifactId).execute()
  return wanted
}

/** Copies of one artifact that disagree, reported rather than silently resolved. */
export interface AddConflict {
  type: ArtifactType
  name: string
  /** One entry per distinct content, naming the harnesses that hold it. */
  variants: Array<{ harnesses: string[] }>
}

export interface AddSummary {
  project: string
  added: number
  updated: number
  unchanged: number
  /** Artifacts whose harness copies have drifted apart; the store kept what it had. */
  conflicts: AddConflict[]
}

type UpsertResult = 'added' | 'updated' | 'unchanged'

/**
 * Append a new version if the content differs from the current (or pinned) version.
 * `hash` stays the hash of the artifact's own file (SKILL.md for a skill) so sync can
 * recognize on-disk content by hash; bundled files are compared separately.
 */
async function versionArtifact(
  db: Kysely<DB>,
  artifact: Pick<ArtifactsTable, 'id' | 'current_version_id' | 'pinned_version_id'>,
  content: string,
  source: string,
  files?: SkillFile[] | null,
): Promise<Exclude<UpsertResult, 'added'>> {
  const hash = hashOf(content)
  const serialized = serializeSkillFiles(files)
  const knownIds = [artifact.current_version_id, artifact.pinned_version_id].filter((v): v is string => v !== null)
  if (knownIds.length > 0) {
    const known = await db.selectFrom('versions').select(['hash', 'files']).where('id', 'in', knownIds).execute()
    if (known.some((v) => v.hash === hash && v.files === serialized)) return 'unchanged'
  }
  const versionId = randomUUID()
  await db
    .insertInto('versions')
    .values({ id: versionId, artifact_id: artifact.id, hash, content, files: serialized, source, created_at: now() })
    .execute()
  await db.updateTable('artifacts').set({ current_version_id: versionId, updated_at: now() }).where('id', '=', artifact.id).execute()
  return 'updated'
}

/** Content the store already holds for an artifact, as content keys. */
async function storedKeys(db: Kysely<DB>, artifact: Pick<ArtifactsTable, 'current_version_id' | 'pinned_version_id'>): Promise<Set<string>> {
  const ids = [artifact.current_version_id, artifact.pinned_version_id].filter((v): v is string => v !== null)
  if (ids.length === 0) return new Set()
  const rows = await db.selectFrom('versions').select(['content', 'files']).where('id', 'in', ids).execute()
  return new Set(rows.map((r) => contentKey(r.content, parseSkillFiles(r.files))))
}

/**
 * Decide which harness's copy of a canonical artifact is the truth when they disagree.
 * If exactly one copy differs from what the store already holds, that copy is the edit and
 * wins — the others are stale renderings of the previous version. If several have moved in
 * different directions there is no honest winner, so the store keeps its own version and
 * reports the conflict instead of letting the harnesses overwrite each other on every scan.
 */
async function resolveVariant(
  db: Kysely<DB>,
  group: ScanGroup,
  existing: Pick<ArtifactsTable, 'current_version_id' | 'pinned_version_id'> | null,
): Promise<ScanVariant | null> {
  if (group.variants.length === 1) return group.variants[0]
  if (!existing) return null
  const stored = await storedKeys(db, existing)
  const changed = group.variants.filter((v) => !stored.has(contentKey(v.content, v.files)))
  // Nothing moved (a pinned artifact whose targets hold different recorded versions, say):
  // any stored copy answers, and versioning it is a no-op.
  if (changed.length === 0) return group.variants.find((v) => stored.has(contentKey(v.content, v.files))) ?? null
  return changed.length === 1 ? changed[0] : null
}

const conflictOf = (group: ScanGroup): AddConflict => ({
  type: group.type,
  name: group.name,
  variants: group.variants.map((v) => ({ harnesses: orderTargets(v.harnesses) })),
})

type UpsertOutcome = { result: UpsertResult; conflict: AddConflict | null }

/**
 * Insert or version one canonical artifact, and record every harness it was found in as a
 * deployment target. projectId null = global artifact shared by all projects.
 */
async function upsertArtifact(db: Kysely<DB>, projectId: string | null, group: ScanGroup): Promise<UpsertOutcome> {
  let query = db.selectFrom('artifacts').selectAll().where('type', '=', group.type).where('name', '=', group.name)
  query = projectId ? query.where('project_id', '=', projectId) : query.where('project_id', 'is', null)
  const existing = await query.executeTakeFirst()

  // Copies that disagreed but resolved cleanly are not worth reporting: one of them was
  // simply the edit. Only an unresolvable disagreement is a conflict.
  const variant = await resolveVariant(db, group, existing ?? null)
  const conflict = variant === null ? conflictOf(group) : null

  if (existing) {
    await addTargets(db, existing.id, group.targets)
    // Unresolvable conflict: keep the stored version rather than pick a copy at random.
    if (!variant) return { result: 'unchanged', conflict }
    return { result: await versionArtifact(db, existing, variant.content, 'add', variant.files), conflict }
  }

  // Nothing stored yet, so there is no baseline to resolve against: take the first copy in
  // registry order and let the conflict report say the others disagreed.
  const chosen = variant ?? group.variants[0]
  const artifactId = randomUUID()
  const versionId = randomUUID()
  await db
    .insertInto('artifacts')
    .values({
      id: artifactId,
      project_id: projectId,
      type: group.type,
      name: group.name,
      origin_harness: chosen.harnesses[0],
      origin_path: chosen.originPath,
      current_version_id: versionId,
      pinned_version_id: null,
      created_at: now(),
      updated_at: now(),
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: versionId,
      artifact_id: artifactId,
      hash: hashOf(chosen.content),
      content: chosen.content,
      files: serializeSkillFiles(chosen.files),
      source: 'add',
      created_at: now(),
    })
    .execute()
  await addTargets(db, artifactId, group.targets)
  return { result: 'added', conflict }
}

/** Artifacts shared into a project from elsewhere (via project_artifacts links), with the owner project's name. */
export async function linkedArtifacts(db: Kysely<DB>, projectId: string) {
  return db
    .selectFrom('project_artifacts')
    .innerJoin('artifacts', 'artifacts.id', 'project_artifacts.artifact_id')
    .leftJoin('projects', 'projects.id', 'artifacts.project_id')
    .selectAll('artifacts')
    .select('projects.name as project_name')
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

  const summary: AddSummary = { project: project.name, added: 0, updated: 0, unchanged: 0, conflicts: [] }
  // Files that came in through a share link belong to the shared artifact's lineage:
  // scanning them versions the shared artifact instead of forking a project-owned copy.
  const linked = new Map((await linkedArtifacts(db, project.id)).map((a) => [`${a.type}:${a.name}`, a]))
  for (const group of groupScanned(scanProject(abs))) {
    const shared = linked.get(`${group.type}:${group.name}`)
    if (shared) {
      await addTargets(db, shared.id, group.targets)
      const variant = await resolveVariant(db, group, shared)
      if (!variant) {
        summary.unchanged++
        summary.conflicts.push(conflictOf(group))
        continue
      }
      summary[await versionArtifact(db, shared, variant.content, 'add', variant.files)]++
      continue
    }
    const { result, conflict } = await upsertArtifact(db, project.id, group)
    summary[result]++
    if (conflict) summary.conflicts.push(conflict)
  }

  await db.updateTable('projects').set({ updated_at: now() }).where('id', '=', project.id).execute()
  return summary
}

export interface GlobalAddSummary {
  added: number
  updated: number
  unchanged: number
  conflicts: AddConflict[]
}

/** Scan every registered harness's global config (~/.claude.json, ~/.codex/config.toml, ...) and upsert global MCP servers. */
export async function addGlobalMcpServers(db: Kysely<DB>): Promise<GlobalAddSummary> {
  const summary: GlobalAddSummary = { added: 0, updated: 0, unchanged: 0, conflicts: [] }
  for (const group of groupScanned(scanGlobalMcpServers())) {
    const { result, conflict } = await upsertArtifact(db, null, group)
    summary[result]++
    if (conflict) summary.conflicts.push(conflict)
  }
  return summary
}

/** A path sync refused to touch, or an artifact it had nowhere to put. */
export interface SyncSkip {
  /** Path involved; null when the artifact has no renderable target at all. */
  relPath: string | null
  /** Artifact name, or null when the whole file was skipped (e.g. unparseable JSON). */
  artifact: string | null
  reason: 'local-edit' | 'unreadable' | 'no-target'
  /** For 'no-target': the harnesses asked for, none of which can host this artifact type. */
  targets?: string[]
}

export interface SyncSummary {
  written: string[]
  /** Bundled skill files deleted upstream and pruned from the working tree. */
  removed: string[]
  /** Unuploaded local edits sync left alone. Re-run with force to discard them. */
  skipped: SyncSkip[]
  missingProject?: boolean
}

export interface SyncOptions {
  /** Overwrite local edits instead of skipping them. */
  force?: boolean
}

/** Every content hash the store has recorded for an artifact — i.e. everything already uploaded. */
async function knownHashes(db: Kysely<DB>, artifactId: string): Promise<Set<string>> {
  const rows = await db.selectFrom('versions').select('hash').where('artifact_id', '=', artifactId).execute()
  return new Set(rows.map((r) => r.hash))
}

/**
 * Every content hash the store has recorded for each bundled file of a skill, keyed by the
 * file's path inside the skill directory. Lets sync tell a file it wrote earlier (safe to
 * overwrite or prune) from one the user created or edited locally (leave alone).
 */
async function knownSkillFileHashes(db: Kysely<DB>, artifactId: string): Promise<Map<string, Set<string>>> {
  const rows = await db.selectFrom('versions').select('files').where('artifact_id', '=', artifactId).execute()
  const known = new Map<string, Set<string>>()
  for (const row of rows) {
    for (const f of parseSkillFiles(row.files)) {
      const hashes = known.get(f.path) ?? new Set<string>()
      hashes.add(hashBytes(skillFileBytes(f)))
      known.set(f.path, hashes)
    }
  }
  return known
}

/** Write one bundled file, restoring its executable bit. */
function writeSkillFile(target: string, file: SkillFile): void {
  writeFileAtomic(target, skillFileBytes(file))
  fs.chmodSync(target, file.exec ? 0o755 : 0o644)
}

/** Drop directories left empty after pruning, up to (but never including) the skill root. */
function pruneEmptyDirs(skillDir: string, fileRel: string): void {
  let dir = path.dirname(path.join(skillDir, ...fileRel.split('/')))
  while (dir.startsWith(skillDir + path.sep)) {
    if (fs.readdirSync(dir).length > 0) return
    fs.rmdirSync(dir)
    dir = path.dirname(dir)
  }
}

/**
 * Materialize a whole skill directory: SKILL.md plus every bundled script, reference and
 * asset. Files the store wrote before but that are gone from this version are pruned, so a
 * script deleted upstream stops shipping; anything the store has never recorded is a local
 * addition or edit and is reported as skipped instead of overwritten (unless forced).
 */
async function syncSkillBundle(
  db: Kysely<DB>,
  root: string,
  artifact: ArtifactRow,
  relPath: string,
  version: { content: string; files: string | null },
  isLocalEdit: (artifactId: string, diskContent: string) => Promise<boolean>,
  force: boolean,
): Promise<{ written: string[]; removed: string[]; skipped: SyncSkip[] }> {
  const written: string[] = []
  const removed: string[] = []
  const skipped: SyncSkip[] = []
  const dirRel = path.posix.dirname(relPath)
  const skillDir = path.join(root, ...dirRel.split('/'))
  const at = (rel: string) => path.posix.join(dirRel, rel)

  // SKILL.md itself follows the same local-edit rule as any single-file artifact.
  const skillMd = path.join(skillDir, 'SKILL.md')
  const prev = fs.existsSync(skillMd) ? fs.readFileSync(skillMd, 'utf8') : null
  if (prev !== version.content) {
    if (prev !== null && (await isLocalEdit(artifact.id, prev))) {
      skipped.push({ relPath, artifact: artifact.name, reason: 'local-edit' })
    } else {
      writeFileAtomic(skillMd, version.content)
      written.push(relPath)
    }
  }

  const files = parseSkillFiles(version.files)
  const onDisk = new Map(collectSkillFiles(skillDir).map((f) => [f.path, f]))
  const known = await knownSkillFileHashes(db, artifact.id)

  for (const file of files) {
    if (!isSafeBundlePath(file.path)) continue
    const target = path.join(skillDir, ...file.path.split('/'))
    const disk = onDisk.get(file.path)
    if (disk) {
      if (disk.encoding === file.encoding && disk.content === file.content) {
        if (Boolean(disk.exec) !== Boolean(file.exec)) fs.chmodSync(target, file.exec ? 0o755 : 0o644)
        continue
      }
      if (!force && !(known.get(file.path)?.has(hashBytes(skillFileBytes(disk))) ?? false)) {
        skipped.push({ relPath: at(file.path), artifact: artifact.name, reason: 'local-edit' })
        continue
      }
    } else if (fs.existsSync(target)) {
      // Present but not readable as a bundled file (symlink, oversized): never clobber it.
      skipped.push({ relPath: at(file.path), artifact: artifact.name, reason: 'unreadable' })
      continue
    }
    writeSkillFile(target, file)
    written.push(at(file.path))
  }

  const managed = new Set(files.map((f) => f.path))
  for (const [diskPath, disk] of onDisk) {
    if (managed.has(diskPath)) continue
    const hashes = known.get(diskPath)
    if (!hashes) continue // never stored: a local addition, not ours to delete
    if (!force && !hashes.has(hashBytes(skillFileBytes(disk)))) {
      skipped.push({ relPath: at(diskPath), artifact: artifact.name, reason: 'local-edit' })
      continue
    }
    fs.rmSync(path.join(skillDir, ...diskPath.split('/')), { force: true })
    pruneEmptyDirs(skillDir, diskPath)
    removed.push(at(diskPath))
  }

  return { written, removed, skipped }
}

type PendingServer = { artifact: ArtifactRow; config: unknown; content: string }

/**
 * Write stored artifacts (pinned version wins over current) back into the project working tree,
 * rendering each one into every harness it targets — one canonical skill can land in
 * .claude/skills, .codex/skills and .agents/skills in the same pass.
 *
 * A file whose content the store has never seen is a local edit that was never added: sync reports
 * it as skipped and leaves it alone, so an automated sync (the SessionStart hook) can never
 * silently discard work. Pass force to overwrite anyway.
 */
export async function syncProject(db: Kysely<DB>, root: string, opts: SyncOptions = {}): Promise<SyncSummary> {
  const abs = path.resolve(root)
  const project = await db.selectFrom('projects').selectAll().where('root_path', '=', abs).executeTakeFirst()
  if (!project) return { written: [], removed: [], skipped: [], missingProject: true }

  const owned = await db.selectFrom('artifacts').selectAll().where('project_id', '=', project.id).execute()
  const artifacts = [...owned, ...(await linkedArtifacts(db, project.id))]
  const targets = await targetsFor(db, artifacts.map((a) => a.id))
  const written: string[] = []
  const removed: string[] = []
  const skipped: SyncSkip[] = []
  const mcpByFile = new Map<string, PendingServer[]>()

  /** Disk content the store has no version for is an edit made since the last add. */
  const isLocalEdit = async (artifactId: string, diskContent: string) =>
    !opts.force && !(await knownHashes(db, artifactId)).has(hashOf(diskContent))

  for (const artifact of artifacts) {
    const versionId = artifact.pinned_version_id ?? artifact.current_version_id
    if (!versionId) continue
    const version = await db.selectFrom('versions').selectAll().where('id', '=', versionId).executeTakeFirst()
    if (!version) continue

    const wanted = effectiveTargets(artifact, targets)
    const paths = renderPaths(artifact, wanted)
    if (paths.length === 0) {
      // Every target harness lacks a location for this type (a Codex-only MCP server, say).
      // Say so instead of quietly writing some other harness's config file.
      skipped.push({ relPath: null, artifact: artifact.name, reason: 'no-target', targets: wanted })
      continue
    }

    for (const { relPath } of paths) {
      if (artifact.type === 'mcp_server') {
        let config: unknown
        try {
          config = JSON.parse(version.content)
        } catch {
          continue
        }
        mcpByFile.set(relPath, [...(mcpByFile.get(relPath) ?? []), { artifact, config, content: version.content }])
      } else if (artifact.type === 'skill') {
        // A skill is a directory: SKILL.md plus whatever scripts/references/assets it ships.
        const bundle = await syncSkillBundle(db, abs, artifact, relPath, version, isLocalEdit, Boolean(opts.force))
        written.push(...bundle.written)
        removed.push(...bundle.removed)
        skipped.push(...bundle.skipped)
      } else {
        const target = path.join(abs, relPath)
        const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null
        if (prev === version.content) continue
        if (prev !== null && (await isLocalEdit(artifact.id, prev))) {
          skipped.push({ relPath, artifact: artifact.name, reason: 'local-edit' })
          continue
        }
        writeFileAtomic(target, version.content)
        written.push(relPath)
      }
    }
  }

  // MCP servers are merged per config file, preserving unrelated keys and unmanaged servers.
  for (const [relPath, pending] of mcpByFile) {
    const target = path.join(abs, relPath)
    const exists = fs.existsSync(target)
    let existing: Record<string, unknown> = {}
    if (exists) {
      try {
        existing = JSON.parse(fs.readFileSync(target, 'utf8'))
      } catch {
        // Rewriting an unparseable config would drop everything the user keeps in it.
        skipped.push({ relPath, artifact: null, reason: 'unreadable' })
        continue
      }
    }
    const existingServers = (existing.mcpServers ?? {}) as Record<string, unknown>
    const servers: Record<string, unknown> = {}
    for (const { artifact, config, content } of pending) {
      const onDisk = existingServers[artifact.name]
      // Entries are stored exactly as the scanner serializes them, so re-serializing disk compares like for like.
      const diskContent = onDisk === undefined ? null : JSON.stringify(onDisk, null, 2)
      if (diskContent !== null && diskContent !== content && (await isLocalEdit(artifact.id, diskContent))) {
        skipped.push({ relPath, artifact: artifact.name, reason: 'local-edit' })
        continue
      }
      servers[artifact.name] = config
    }
    // Nothing left to apply: don't reformat a file we just declined to change.
    if (Object.keys(servers).length === 0 && exists) continue
    const merged = { ...existing, mcpServers: { ...existingServers, ...servers } }
    const out = JSON.stringify(merged, null, 2) + '\n'
    if (!exists || fs.readFileSync(target, 'utf8') !== out) {
      writeFileAtomic(target, out)
      written.push(relPath)
    }
  }

  return { written, removed, skipped }
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
  if (!fs.existsSync(project.root_path)) return { written: [], removed: [], skipped: [] }
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
  const targets = effectiveTargets(artifact, await targetsFor(db, [artifact.id]))
  return { removed: removeFromProjectTree(project.root_path, artifact, targets) }
}

/**
 * Delete an artifact's synced copies from a project working tree — every path it renders to,
 * not just the one it was scanned from. Returns removed rel paths.
 */
function removeFromProjectTree(root: string, artifact: Pick<ArtifactsTable, 'type' | 'name'>, targets: string[]): string[] {
  const removed: string[] = []

  for (const { relPath } of renderPaths(artifact, targets)) {
    if (artifact.type === 'skill') {
      // Remove the whole skill directory, not just SKILL.md.
      const dir = path.join(root, path.dirname(relPath))
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed.push(path.dirname(relPath))
      }
    } else if (artifact.type === 'mcp_server') {
      const target = path.join(root, relPath)
      if (!fs.existsSync(target)) continue
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
    } else {
      const target = path.join(root, relPath)
      if (fs.existsSync(target)) {
        fs.rmSync(target)
        removed.push(relPath)
      }
    }
  }

  return removed
}

export interface DeleteSummary {
  deleted: { type: string; name: string }
  /** Global config files checked when the artifact was a global MCP server. */
  globals: Array<{ file: string; status: 'removed' | 'absent' }>
  detached: Array<{ project: string; removed: string[] }>
}

/**
 * Remove a global MCP server from every harness that registers one under that name. Scanning
 * reads all harness-global configs and merges same-named servers into one canonical artifact,
 * so deleting has to clear all of them — leaving one behind would let the next scan resurrect
 * the artifact, and would leave a harness still loading a server the store says is gone.
 *
 * A config that cannot be edited safely aborts the delete. Files already cleaned stay cleaned;
 * they simply report 'absent' on the retry, so the operation is safe to run again.
 */
function removeGlobalServer(name: string, home: string): Array<{ file: string; status: 'removed' | 'absent' }> {
  const results: Array<{ file: string; status: 'removed' | 'absent' }> = []
  const failures: string[] = []
  for (const harness of HARNESSES) {
    if (!harness.removeGlobalMcpServer) continue
    const result = harness.removeGlobalMcpServer(home, name)
    if (result.status === 'failed') failures.push(`${result.file} (${result.reason})`)
    else results.push({ file: result.file, status: result.status })
  }
  if (failures.length > 0) {
    const cleaned = results.filter((r) => r.status === 'removed').map((r) => r.file)
    throw new Error(
      `not deleted: could not remove "${name}" from ${failures.join(', ')}; fix ${
        failures.length > 1 ? 'those files' : 'that file'
      } or remove the entry manually, then retry${cleaned.length > 0 ? ` (already removed from ${cleaned.join(', ')})` : ''}`,
    )
  }
  return results
}

/**
 * Delete an artifact everywhere it is materialized: the entry in the global config it came
 * from (so the next scan cannot resurrect it), the synced copies in attached project trees,
 * and finally the DB row (versions, targets and project links cascade). A failed global
 * config edit aborts the whole delete — the store must never report an artifact gone
 * while the harness still loads it.
 */
export async function deleteArtifact(db: Kysely<DB>, artifactId: string, home = os.homedir()): Promise<DeleteSummary> {
  const artifact = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('id', '=', artifactId)
    .executeTakeFirstOrThrow(() => new Error('artifact not found'))

  const globals =
    artifact.project_id === null && artifact.type === 'mcp_server' && artifact.origin_path.startsWith('~')
      ? removeGlobalServer(artifact.name, home)
      : []

  const targets = effectiveTargets(artifact, await targetsFor(db, [artifact.id]))
  const attached = await db
    .selectFrom('project_artifacts')
    .innerJoin('projects', 'projects.id', 'project_artifacts.project_id')
    .select(['projects.name', 'projects.root_path'])
    .where('project_artifacts.artifact_id', '=', artifact.id)
    .execute()
  const detached: DeleteSummary['detached'] = []
  for (const p of attached) {
    if (!fs.existsSync(p.root_path)) continue
    const removed = removeFromProjectTree(p.root_path, artifact, targets)
    if (removed.length > 0) detached.push({ project: p.name, removed })
  }

  await db.deleteFrom('artifacts').where('id', '=', artifact.id).execute()
  return { deleted: { type: artifact.type, name: artifact.name }, globals, detached }
}
