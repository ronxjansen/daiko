import { serve } from '@hono/node-server'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import type { Kysely } from 'kysely'
import type { DB } from '../db/schema.js'
import { HARNESSES } from '../core/harnesses/index.js'
import { estimateCostUsd } from '../core/pricing.js'
import { attachArtifact, deleteArtifact, detachArtifact, hashOf, syncProject } from '../core/store.js'

const now = () => new Date().toISOString()

/** Derived usage fields for a session row: grand total + estimated USD cost (null when untracked). */
function usageFields(s: {
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
}): { total_tokens: number | null; estimated_cost_usd: number | null } {
  if (s.input_tokens === null) return { total_tokens: null, estimated_cost_usd: null }
  const usage = {
    input: s.input_tokens,
    output: s.output_tokens ?? 0,
    cacheRead: s.cache_read_tokens ?? 0,
    cacheWrite: s.cache_write_tokens ?? 0,
  }
  return {
    total_tokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    estimated_cost_usd: estimateCostUsd(s.model, usage),
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function webDistDir(): string {
  // dist/server/index.js -> package root -> web/dist
  const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))
  return path.join(pkgRoot, 'web', 'dist')
}

export function createApp(db: Kysely<DB>): Hono {
  const app = new Hono()

  app.get('/api/harnesses', (c) =>
    c.json(HARNESSES.map((h) => ({ id: h.id, label: h.label, sessions: Boolean(h.parseSession) }))),
  )

  app.get('/api/stats', async (c) => {
    const [projects, artifacts, versions, sessions] = await Promise.all([
      db.selectFrom('projects').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
      db.selectFrom('artifacts').select(['type', db.fn.countAll<number>().as('n')]).groupBy('type').execute(),
      db.selectFrom('versions').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
      db.selectFrom('sessions').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ])
    const byType = Object.fromEntries(artifacts.map((r) => [r.type, r.n]))
    return c.json({
      projects: projects.n,
      skills: byType.skill ?? 0,
      mcp_servers: byType.mcp_server ?? 0,
      agent_files: byType.agent_md ?? 0,
      versions: versions.n,
      sessions: sessions.n,
    })
  })

  app.get('/api/activity', async (c) => {
    const rows = await db
      .selectFrom('versions')
      .innerJoin('artifacts', 'artifacts.id', 'versions.artifact_id')
      .leftJoin('projects', 'projects.id', 'artifacts.project_id')
      .select([
        'versions.id as id',
        'versions.source as source',
        'versions.created_at as created_at',
        'artifacts.id as artifact_id',
        'artifacts.name as artifact_name',
        'artifacts.type as type',
        'projects.name as project_name',
      ])
      .orderBy('versions.created_at', 'desc')
      .limit(20)
      .execute()
    return c.json(rows)
  })

  app.get('/api/projects', async (c) => {
    const projects = await db.selectFrom('projects').selectAll().orderBy('updated_at', 'desc').execute()
    const counts = await db
      .selectFrom('artifacts')
      .select(['project_id', db.fn.countAll<number>().as('n')])
      .groupBy('project_id')
      .execute()
    const countMap = new Map(counts.map((r) => [r.project_id, r.n]))
    return c.json(projects.map((p) => ({ ...p, artifact_count: countMap.get(p.id) ?? 0 })))
  })

  app.get('/api/projects/:id', async (c) => {
    const project = await db.selectFrom('projects').selectAll().where('id', '=', c.req.param('id')).executeTakeFirst()
    if (!project) return c.json({ error: 'not found' }, 404)
    const artifacts = await db
      .selectFrom('artifacts')
      .selectAll()
      .where('project_id', '=', project.id)
      .orderBy('type')
      .orderBy('name')
      .execute()
    // Artifacts shared into this project from other projects (or from the global pool).
    const linkedArtifacts = await db
      .selectFrom('project_artifacts')
      .innerJoin('artifacts', 'artifacts.id', 'project_artifacts.artifact_id')
      .leftJoin('projects as owner', 'owner.id', 'artifacts.project_id')
      .selectAll('artifacts')
      .select('owner.name as project_name')
      .where('project_artifacts.project_id', '=', project.id)
      .orderBy('artifacts.type')
      .orderBy('artifacts.name')
      .execute()
    // Global artifacts (project_id null) are available to every project.
    const globalArtifacts = await db
      .selectFrom('artifacts')
      .selectAll()
      .where('project_id', 'is', null)
      .orderBy('harness')
      .orderBy('name')
      .execute()
    return c.json({ ...project, artifacts, linked_artifacts: linkedArtifacts, global_artifacts: globalArtifacts })
  })

  app.post('/api/projects/:id/artifacts', async (c) => {
    const body = await c.req.json<{ artifact_id?: string }>()
    if (!body.artifact_id) return c.json({ error: 'artifact_id required' }, 400)
    try {
      const summary = await attachArtifact(db, c.req.param('id'), body.artifact_id)
      return c.json({ ok: true, ...summary })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.delete('/api/projects/:id/artifacts/:artifactId', async (c) => {
    try {
      const result = await detachArtifact(db, c.req.param('id'), c.req.param('artifactId'))
      return c.json({ ok: true, ...result })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post('/api/projects/:id/sync', async (c) => {
    const project = await db.selectFrom('projects').selectAll().where('id', '=', c.req.param('id')).executeTakeFirst()
    if (!project) return c.json({ error: 'not found' }, 404)
    if (!fs.existsSync(project.root_path)) return c.json({ error: `path missing: ${project.root_path}` }, 400)
    const summary = await syncProject(db, project.root_path)
    return c.json(summary)
  })

  app.delete('/api/projects/:id', async (c) => {
    await db.deleteFrom('projects').where('id', '=', c.req.param('id')).execute()
    return c.json({ ok: true })
  })

  app.get('/api/artifacts', async (c) => {
    const type = c.req.query('type')
    const q = c.req.query('q')?.trim()
    let query = db
      .selectFrom('artifacts')
      .leftJoin('projects', 'projects.id', 'artifacts.project_id')
      .selectAll('artifacts')
      .select('projects.name as project_name')
      .orderBy('artifacts.updated_at', 'desc')
    if (type) query = query.where('artifacts.type', '=', type as 'skill')
    if (q) {
      const like = `%${q}%`
      query = query.where((eb) =>
        eb.or([eb('artifacts.name', 'like', like), eb('projects.name', 'like', like)]),
      )
    }
    const artifacts = await query.execute()
    const counts = await db
      .selectFrom('versions')
      .select(['artifact_id', db.fn.countAll<number>().as('n')])
      .groupBy('artifact_id')
      .execute()
    const countMap = new Map(counts.map((r) => [r.artifact_id, r.n]))
    return c.json(artifacts.map((a) => ({ ...a, version_count: countMap.get(a.id) ?? 0 })))
  })

  app.get('/api/artifacts/:id', async (c) => {
    const artifact = await db
      .selectFrom('artifacts')
      .leftJoin('projects', 'projects.id', 'artifacts.project_id')
      .selectAll('artifacts')
      .select('projects.name as project_name')
      .where('artifacts.id', '=', c.req.param('id'))
      .executeTakeFirst()
    if (!artifact) return c.json({ error: 'not found' }, 404)
    const versions = await db
      .selectFrom('versions')
      .select(['id', 'artifact_id', 'hash', 'source', 'created_at'])
      .where('artifact_id', '=', artifact.id)
      .orderBy('created_at', 'desc')
      .execute()
    const currentId = artifact.pinned_version_id ?? artifact.current_version_id
    const current = currentId
      ? await db.selectFrom('versions').selectAll().where('id', '=', currentId).executeTakeFirst()
      : undefined
    const attachedProjects = await db
      .selectFrom('project_artifacts')
      .innerJoin('projects', 'projects.id', 'project_artifacts.project_id')
      .select(['projects.id', 'projects.name', 'projects.root_path'])
      .where('project_artifacts.artifact_id', '=', artifact.id)
      .orderBy('projects.name')
      .execute()
    return c.json({ ...artifact, versions, content: current?.content ?? '', attached_projects: attachedProjects })
  })

  app.get('/api/artifacts/:id/versions/:versionId', async (c) => {
    const version = await db
      .selectFrom('versions')
      .selectAll()
      .where('id', '=', c.req.param('versionId'))
      .where('artifact_id', '=', c.req.param('id'))
      .executeTakeFirst()
    if (!version) return c.json({ error: 'not found' }, 404)
    return c.json(version)
  })

  app.put('/api/artifacts/:id', async (c) => {
    const artifact = await db.selectFrom('artifacts').selectAll().where('id', '=', c.req.param('id')).executeTakeFirst()
    if (!artifact) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ content?: string }>()
    if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400)
    const hash = hashOf(body.content)
    const current = artifact.current_version_id
      ? await db.selectFrom('versions').selectAll().where('id', '=', artifact.current_version_id).executeTakeFirst()
      : undefined
    if (current && current.hash === hash) return c.json({ ok: true, unchanged: true })
    const versionId = randomUUID()
    await db
      .insertInto('versions')
      .values({ id: versionId, artifact_id: artifact.id, hash, content: body.content, source: 'webui', created_at: now() })
      .execute()
    await db.updateTable('artifacts').set({ current_version_id: versionId, updated_at: now() }).where('id', '=', artifact.id).execute()
    return c.json({ ok: true, version_id: versionId })
  })

  app.post('/api/artifacts/:id/pin', async (c) => {
    const artifact = await db.selectFrom('artifacts').selectAll().where('id', '=', c.req.param('id')).executeTakeFirst()
    if (!artifact) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ version_id: string | null }>()
    if (body.version_id) {
      const version = await db
        .selectFrom('versions')
        .select('id')
        .where('id', '=', body.version_id)
        .where('artifact_id', '=', artifact.id)
        .executeTakeFirst()
      if (!version) return c.json({ error: 'version not found' }, 404)
    }
    await db
      .updateTable('artifacts')
      .set({ pinned_version_id: body.version_id ?? null, updated_at: now() })
      .where('id', '=', artifact.id)
      .execute()
    return c.json({ ok: true })
  })

  app.post('/api/artifacts/:id/restore', async (c) => {
    const artifact = await db.selectFrom('artifacts').selectAll().where('id', '=', c.req.param('id')).executeTakeFirst()
    if (!artifact) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ version_id: string }>()
    const version = await db
      .selectFrom('versions')
      .selectAll()
      .where('id', '=', body.version_id)
      .where('artifact_id', '=', artifact.id)
      .executeTakeFirst()
    if (!version) return c.json({ error: 'version not found' }, 404)
    const versionId = randomUUID()
    await db
      .insertInto('versions')
      .values({ id: versionId, artifact_id: artifact.id, hash: version.hash, content: version.content, source: 'restore', created_at: now() })
      .execute()
    await db.updateTable('artifacts').set({ current_version_id: versionId, updated_at: now() }).where('id', '=', artifact.id).execute()
    return c.json({ ok: true, version_id: versionId })
  })

  app.delete('/api/artifacts/:id', async (c) => {
    try {
      const summary = await deleteArtifact(db, c.req.param('id'))
      return c.json({ ok: true, ...summary })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, message === 'artifact not found' ? 404 : 409)
    }
  })

  app.get('/api/sessions', async (c) => {
    const harness = c.req.query('harness')
    const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
    const offset = Number(c.req.query('offset')) || 0

    let query = db
      .selectFrom('sessions')
      .selectAll('sessions')
      // First real user message as a preview; skip injected context blocks like <system-reminder>.
      .select((eb) =>
        eb
          .selectFrom('messages')
          .select('messages.content')
          .whereRef('messages.session_id', '=', 'sessions.id')
          .where('messages.role', '=', 'user')
          .where('messages.kind', '=', 'text')
          .where('messages.content', 'not like', '<%')
          .orderBy('messages.seq')
          .limit(1)
          .as('preview'),
      )
      .orderBy('started_at', 'desc')
      .limit(limit)
      .offset(offset)
    let countQuery = db.selectFrom('sessions').select(db.fn.countAll<number>().as('n'))
    if (harness) {
      query = query.where('harness', '=', harness)
      countQuery = countQuery.where('harness', '=', harness)
    }
    const [rows, total] = await Promise.all([query.execute(), countQuery.executeTakeFirstOrThrow()])
    return c.json({
      sessions: rows.map((s) => ({ ...s, ...usageFields(s), preview: s.preview ? s.preview.slice(0, 200) : null })),
      total: total.n,
    })
  })

  app.get('/api/sessions/:id', async (c) => {
    const session = await db.selectFrom('sessions').selectAll().where('id', '=', c.req.param('id')).executeTakeFirst()
    if (!session) return c.json({ error: 'not found' }, 404)
    const limit = Math.min(Number(c.req.query('limit')) || 500, 2000)
    const offset = Number(c.req.query('offset')) || 0
    const messages = await db
      .selectFrom('messages')
      .select(['id', 'seq', 'role', 'kind', 'content', 'tool_name', 'tool_use_id', 'timestamp', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'])
      .where('session_id', '=', session.id)
      .orderBy('seq')
      .limit(limit)
      .offset(offset)
      .execute()
    // Per-request cost alongside the raw counts, so pricing knowledge stays server-side.
    const withCost = messages.map((m) => ({
      ...m,
      estimated_cost_usd:
        m.input_tokens === null
          ? null
          : estimateCostUsd(m.model ?? session.model, {
              input: m.input_tokens,
              output: m.output_tokens ?? 0,
              cacheRead: m.cache_read_tokens ?? 0,
              cacheWrite: m.cache_write_tokens ?? 0,
            }),
    }))
    return c.json({ ...session, ...usageFields(session), messages: withCost, message_offset: offset, message_limit: limit })
  })

  app.delete('/api/sessions/:id', async (c) => {
    await db.deleteFrom('sessions').where('id', '=', c.req.param('id')).execute()
    return c.json({ ok: true })
  })

  // Static web UI with SPA fallback.
  const dist = webDistDir()
  app.get('*', (c) => {
    if (!fs.existsSync(dist)) {
      return c.text('Web UI not built. Run: npm run build:web', 404)
    }
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname)
    const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
    let file = path.join(dist, safe)
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(dist, 'index.html')
    }
    const ext = path.extname(file)
    return c.body(fs.readFileSync(file), 200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
  })

  return app
}

export function startServer(db: Kysely<DB>, port: number): Promise<number> {
  const app = createApp(db)
  return new Promise((resolve) => {
    serve({ fetch: app.fetch, port }, (info) => resolve(info.port))
  })
}
