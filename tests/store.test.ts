import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from '../src/db/schema.js'
import { openDb } from '../src/db/index.js'
import {
  addProject,
  addTargets,
  attachArtifact,
  detachArtifact,
  setTargets,
  syncProject,
  targetsOf,
} from '../src/core/store.js'

let tmp: string
let db: Kysely<DB>
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-store-'))
  db = openDb(path.join(tmp, 'daiko.sqlite'))
})
afterEach(async () => {
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const makeRepo = (name: string, files: Record<string, string> = {}): string => {
  const root = path.join(tmp, name)
  fs.mkdirSync(root, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return root
}

const skillMd = (v: string) => `---\nname: demo\ndescription: ${v}\n---\n\n${v} body\n`
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')

const artifactByName = (name: string) =>
  db.selectFrom('artifacts').selectAll().where('name', '=', name).executeTakeFirstOrThrow()
const versionCount = async (artifactId: string) =>
  (await db.selectFrom('versions').select('id').where('artifact_id', '=', artifactId).execute()).length

describe('addProject', () => {
  it('collapses identical copies across harnesses into one canonical artifact targeting both', async () => {
    const repo = makeRepo('repo', {
      '.claude/skills/demo/SKILL.md': skillMd('v1'),
      '.codex/skills/demo/SKILL.md': skillMd('v1'),
    })
    const summary = await addProject(db, repo)
    expect(summary).toMatchObject({ added: 1, updated: 0, unchanged: 0, conflicts: [] })
    const artifact = await artifactByName('demo')
    expect(artifact.origin_harness).toBe('claude')
    expect(await targetsOf(db, artifact.id)).toEqual(['claude', 'codex'])
  })

  it('is idempotent, and versions only actual changes', async () => {
    const repo = makeRepo('repo', { '.claude/skills/demo/SKILL.md': skillMd('v1') })
    await addProject(db, repo)
    expect(await addProject(db, repo)).toMatchObject({ added: 0, updated: 0, unchanged: 1 })

    fs.writeFileSync(path.join(repo, '.claude/skills/demo/SKILL.md'), skillMd('v2'))
    expect(await addProject(db, repo)).toMatchObject({ added: 0, updated: 1, unchanged: 0 })
    expect(await versionCount((await artifactByName('demo')).id)).toBe(2)
  })

  it('resolves drift when exactly one harness copy was edited: that copy wins', async () => {
    const repo = makeRepo('repo', {
      '.claude/skills/demo/SKILL.md': skillMd('v1'),
      '.codex/skills/demo/SKILL.md': skillMd('v1'),
    })
    await addProject(db, repo)
    fs.writeFileSync(path.join(repo, '.codex/skills/demo/SKILL.md'), skillMd('v2'))

    const summary = await addProject(db, repo)
    expect(summary).toMatchObject({ updated: 1, conflicts: [] })

    // Sync propagates the winning edit back into the stale copy.
    const synced = await syncProject(db, repo)
    expect(synced.skipped).toEqual([])
    expect(read(repo, '.claude/skills/demo/SKILL.md')).toBe(skillMd('v2'))
  })

  it('stores CLAUDE.md and AGENTS.md as one instructions document targeting every harness that reads them', async () => {
    const repo = makeRepo('repo', { 'CLAUDE.md': '# House rules\n', 'AGENTS.md': '# House rules\n' })
    await addProject(db, repo)
    const docs = await db.selectFrom('artifacts').selectAll().where('type', '=', 'agent_md').execute()
    expect(docs).toHaveLength(1)
    expect(docs[0].name).toBe('instructions')
    const targets = await targetsOf(db, docs[0].id)
    expect(targets).toContain('claude')
    expect(targets).toContain('codex')
    expect(targets).toContain('generic')
  })

  it('reports an unresolvable conflict and keeps the stored version', async () => {
    const repo = makeRepo('repo', {
      '.claude/skills/demo/SKILL.md': skillMd('v1'),
      '.codex/skills/demo/SKILL.md': skillMd('v1'),
    })
    await addProject(db, repo)
    fs.writeFileSync(path.join(repo, '.claude/skills/demo/SKILL.md'), skillMd('claude-edit'))
    fs.writeFileSync(path.join(repo, '.codex/skills/demo/SKILL.md'), skillMd('codex-edit'))

    const summary = await addProject(db, repo)
    expect(summary).toMatchObject({ added: 0, updated: 0, unchanged: 1 })
    expect(summary.conflicts).toEqual([
      { type: 'skill', name: 'demo', variants: [{ harnesses: ['claude'] }, { harnesses: ['codex'] }] },
    ])
    // The store kept v1 — neither edit overwrote the other.
    const artifact = await artifactByName('demo')
    expect(await versionCount(artifact.id)).toBe(1)
  })
})

describe('syncProject', () => {
  it('renders one canonical skill into every target harness layout', async () => {
    const repo = makeRepo('repo', { '.claude/skills/demo/SKILL.md': skillMd('v1') })
    await addProject(db, repo)
    const artifact = await artifactByName('demo')

    // setTargets normalizes to registry order regardless of input order.
    expect(await setTargets(db, artifact.id, ['codex', 'claude'])).toEqual(['claude', 'codex'])

    const synced = await syncProject(db, repo)
    expect(synced.written).toContain(path.posix.join('.codex/skills/demo', 'SKILL.md'))
    expect(read(repo, '.codex/skills/demo/SKILL.md')).toBe(skillMd('v1'))
  })

  it('prunes bundled files deleted upstream but never touches local additions', async () => {
    const repo = makeRepo('repo', {
      '.claude/skills/demo/SKILL.md': skillMd('v1'),
      '.claude/skills/demo/scripts/run.sh': 'echo v1\n',
    })
    await addProject(db, repo)

    // Upstream deletes the script (new version without it) ...
    fs.rmSync(path.join(repo, '.claude/skills/demo/scripts'), { recursive: true })
    expect(await addProject(db, repo)).toMatchObject({ updated: 1 })

    // ... but a machine syncing later still has the old copy, plus a file of its own.
    fs.mkdirSync(path.join(repo, '.claude/skills/demo/scripts'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.claude/skills/demo/scripts/run.sh'), 'echo v1\n')
    fs.writeFileSync(path.join(repo, '.claude/skills/demo/local-notes.md'), 'mine')

    const synced = await syncProject(db, repo)
    expect(synced.removed).toEqual(['.claude/skills/demo/scripts/run.sh'])
    expect(fs.existsSync(path.join(repo, '.claude/skills/demo/scripts'))).toBe(false) // empty dir pruned too
    expect(read(repo, '.claude/skills/demo/local-notes.md')).toBe('mine')
    expect(synced.skipped).toEqual([])
  })

  it('merges MCP servers into the config file, preserving unmanaged servers and unrelated keys', async () => {
    const v1 = { command: 'demo', args: ['--v1'] }
    const v2 = { command: 'demo', args: ['--v2'] }
    const repo = makeRepo('repo', { '.mcp.json': JSON.stringify({ mcpServers: { demo: v1 } }, null, 2) + '\n' })
    await addProject(db, repo)

    // Store learns v2, then the disk rolls back to the known v1 and gains local extras.
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { demo: v2 } }, null, 2) + '\n')
    await addProject(db, repo)
    fs.writeFileSync(
      path.join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { demo: v1, extra: { command: 'mine' } }, otherKey: true }, null, 2) + '\n',
    )

    const synced = await syncProject(db, repo)
    expect(synced.written).toEqual(['.mcp.json'])
    expect(JSON.parse(read(repo, '.mcp.json'))).toEqual({
      mcpServers: { demo: v2, extra: { command: 'mine' } },
      otherKey: true,
    })
  })

  it('skips an MCP entry edited locally since the last add, unless forced', async () => {
    const repo = makeRepo('repo', {
      '.mcp.json': JSON.stringify({ mcpServers: { demo: { command: 'demo' } } }, null, 2) + '\n',
    })
    await addProject(db, repo)
    const local = { mcpServers: { demo: { command: 'demo', args: ['--local-edit'] } } }
    fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify(local, null, 2) + '\n')

    const synced = await syncProject(db, repo)
    expect(synced.skipped).toEqual([{ relPath: '.mcp.json', artifact: 'demo', reason: 'local-edit' }])
    expect(JSON.parse(read(repo, '.mcp.json'))).toEqual(local)

    const forced = await syncProject(db, repo, { force: true })
    expect(forced.skipped).toEqual([])
    expect(JSON.parse(read(repo, '.mcp.json')).mcpServers.demo).toEqual({ command: 'demo' })
  })

  it('protects an unrecorded SKILL.md edit, restores it under force, and accepts rollbacks to known versions', async () => {
    const skillPath = '.claude/skills/demo/SKILL.md'
    const repo = makeRepo('repo', { [skillPath]: skillMd('v1') })
    await addProject(db, repo)
    expect(await syncProject(db, repo)).toEqual({ written: [], removed: [], skipped: [] })

    const local = skillMd('local edit never added')
    fs.writeFileSync(path.join(repo, skillPath), local)
    const guarded = await syncProject(db, repo)
    expect(guarded.written).toEqual([])
    expect(guarded.skipped).toEqual([{ relPath: skillPath, artifact: 'demo', reason: 'local-edit' }])
    expect(read(repo, skillPath)).toBe(local)

    const forced = await syncProject(db, repo, { force: true })
    expect(forced.written).toEqual([skillPath])
    expect(read(repo, skillPath)).toBe(skillMd('v1'))

    // Rolling disk back to an older recorded version is not a local edit: the store has seen
    // that content, so sync restores the current version without reporting a conflict.
    fs.writeFileSync(path.join(repo, skillPath), local)
    await addProject(db, repo) // the local edit becomes v2
    fs.writeFileSync(path.join(repo, skillPath), skillMd('v1'))
    const rolled = await syncProject(db, repo)
    expect(rolled.skipped).toEqual([])
    expect(read(repo, skillPath)).toBe(local)
  })

  it('skips an unparseable MCP config instead of rewriting it', async () => {
    const repo = makeRepo('repo', {
      '.mcp.json': JSON.stringify({ mcpServers: { demo: { command: 'demo' } } }, null, 2) + '\n',
    })
    await addProject(db, repo)
    fs.writeFileSync(path.join(repo, '.mcp.json'), '{ not json at all')
    const broken = await syncProject(db, repo)
    expect(broken.skipped).toEqual([{ relPath: '.mcp.json', artifact: null, reason: 'unreadable' }])
    expect(read(repo, '.mcp.json')).toBe('{ not json at all')
  })

  it('reports a project that was never added', async () => {
    expect(await syncProject(db, makeRepo('unregistered'))).toMatchObject({ missingProject: true })
  })
})

describe('attach / detach', () => {
  it('shares an artifact into another project, syncs it to disk, and detach removes it again', async () => {
    const owner = makeRepo('owner', { '.claude/skills/demo/SKILL.md': skillMd('v1') })
    const other = makeRepo('other')
    await addProject(db, owner)
    await addProject(db, other)
    const artifact = await artifactByName('demo')
    const otherProject = await db.selectFrom('projects').selectAll().where('root_path', '=', other).executeTakeFirstOrThrow()

    const synced = await attachArtifact(db, otherProject.id, artifact.id)
    expect(synced.written).toContain('.claude/skills/demo/SKILL.md')
    expect(read(other, '.claude/skills/demo/SKILL.md')).toBe(skillMd('v1'))

    const detached = await detachArtifact(db, otherProject.id, artifact.id)
    expect(detached.removed).toEqual(['.claude/skills/demo'])
    expect(fs.existsSync(path.join(other, '.claude/skills/demo'))).toBe(false)
    expect(fs.existsSync(path.join(owner, '.claude/skills/demo/SKILL.md'))).toBe(true)
  })

  it('refuses to detach an artifact from its own project', async () => {
    const owner = makeRepo('owner', { '.claude/skills/demo/SKILL.md': skillMd('v1') })
    await addProject(db, owner)
    const artifact = await artifactByName('demo')
    const project = await db.selectFrom('projects').selectAll().where('root_path', '=', owner).executeTakeFirstOrThrow()
    await expect(detachArtifact(db, project.id, artifact.id)).rejects.toThrow(/originates from this project/)
  })
})

describe('targeting', () => {
  const insertGlobalServer = async (name: string, harness: string, originPath: string) => {
    const artifactId = randomUUID()
    const versionId = randomUUID()
    const at = new Date().toISOString()
    await db
      .insertInto('artifacts')
      .values({
        id: artifactId,
        project_id: null,
        type: 'mcp_server',
        name,
        origin_harness: harness,
        origin_path: originPath,
        current_version_id: versionId,
        pinned_version_id: null,
        created_at: at,
        updated_at: at,
      })
      .execute()
    await db
      .insertInto('versions')
      .values({ id: versionId, artifact_id: artifactId, hash: 'h', content: '{"command":"x"}', files: null, source: 'add', created_at: at })
      .execute()
    await addTargets(db, artifactId, [harness])
    return artifactId
  }

  it('reports an artifact none of whose targets can host it, and deploys it once retargeted', async () => {
    const repo = makeRepo('repo')
    await addProject(db, repo)
    const project = await db.selectFrom('projects').selectAll().where('root_path', '=', repo).executeTakeFirstOrThrow()
    // Codex has no project MCP config: attaching a codex-only server has nowhere to land.
    const serverId = await insertGlobalServer('codexonly', 'codex', '~/.codex/config.toml')

    const attached = await attachArtifact(db, project.id, serverId)
    expect(attached.skipped).toEqual([{ relPath: null, artifact: 'codexonly', reason: 'no-target', targets: ['codex'] }])
    expect(fs.existsSync(path.join(repo, '.mcp.json'))).toBe(false) // never written into another harness's file

    // Pointing it at a harness that can host it deploys it, with no rescan needed.
    await setTargets(db, serverId, ['claude'])
    await syncProject(db, repo)
    expect(JSON.parse(read(repo, '.mcp.json')).mcpServers.codexonly).toEqual({ command: 'x' })
  })
})
