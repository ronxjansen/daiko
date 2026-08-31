import { Command } from 'commander'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db/index.js'
import { daikoHome, dbPath, ensureHome, readConfig, writeConfig, DEFAULT_PORT } from '../core/paths.js'
import { addGlobalMcpServers, addProject, attachArtifact, deleteArtifact, detachArtifact, syncProject } from '../core/store.js'
import { sessionHarnesses } from '../core/harnesses/index.js'
import { importAllSessions, importSessionFile } from '../core/sessions.js'
import { installHook } from './hook.js'
import { startServer } from '../server/index.js'

/**
 * transcript_path is not guaranteed on every hook event (notably SessionEnd);
 * fall back to Claude Code's project-dir convention:
 * ~/.claude/projects/<cwd with non-alphanumerics mangled to "-">/<session_id>.jsonl
 */
function resolveTranscriptPath(payload: { transcript_path?: string; session_id?: string; cwd?: string }): string | null {
  if (payload.transcript_path && fs.existsSync(payload.transcript_path)) return payload.transcript_path
  if (!payload.session_id || !payload.cwd) return null
  const slug = payload.cwd.replace(/[^a-zA-Z0-9-]/g, '-')
  const derived = path.join(os.homedir(), '.claude', 'projects', slug, `${payload.session_id}.jsonl`)
  return fs.existsSync(derived) ? derived : null
}

const program = new Command()

program.name('dai').description('Daiko: sync MCP servers, skills, and agent files across agents and projects').version('0.1.0')

program
  .command('init')
  .description('Initialize the global Daiko store (~/.daiko)')
  .option('-p, --port <port>', 'web UI port', String(DEFAULT_PORT))
  .action(async (opts: { port: string }) => {
    ensureHome()
    writeConfig({ port: Number(opts.port) || DEFAULT_PORT })
    const db = openDb(dbPath())
    await db.destroy()
    console.log(`Initialized Daiko store at ${daikoHome()}`)
  })

program
  .command('add [path]')
  .description('Scan a repo and upload its skills, MCP servers, and agent files to Daiko')
  .action(async (target = '.') => {
    const db = openDb(dbPath())
    try {
      const summary = await addProject(db, target)
      console.log(
        `Project "${summary.project}": ${summary.added} added, ${summary.updated} updated, ${summary.unchanged} unchanged`,
      )
      const globals = await addGlobalMcpServers(db)
      console.log(
        `Global MCP servers: ${globals.added} added, ${globals.updated} updated, ${globals.unchanged} unchanged`,
      )
    } finally {
      await db.destroy()
    }
  })

program
  .command('sync [path]')
  .description('Write stored skills, MCP servers, and agent files back into the repo')
  .option('-q, --quiet', 'suppress output when nothing changed')
  .action(async (target = '.', opts: { quiet?: boolean }) => {
    const db = openDb(dbPath())
    try {
      const summary = await syncProject(db, target)
      if (summary.missingProject) {
        if (!opts.quiet) console.error(`Project not registered. Run: dai add ${target}`)
        process.exitCode = opts.quiet ? 0 : 1
        return
      }
      if (summary.written.length === 0) {
        if (!opts.quiet) console.log('Already up to date.')
      } else {
        for (const file of summary.written) console.log(`synced ${file}`)
      }
    } finally {
      await db.destroy()
    }
  })

program
  .command('hook [path]')
  .description('Install Claude Code hooks: auto "dai sync" on SessionStart, full-transcript capture on Stop/SessionEnd')
  .option('-g, --global', 'install hooks in ~/.claude/settings.json (sync + capture for all projects)')
  .action((target = '.', opts: { global?: boolean }) => {
    const settingsPath = installHook(path.resolve(target), { global: opts.global })
    console.log(`Installed sync hook (SessionStart) and transcript capture hooks (Stop, SessionEnd) in ${settingsPath}`)
    if (opts.global) {
      console.log('Every new session in a registered repo now syncs its skills, MCP servers, and agent files on start.')
    }
  })

type CliDb = ReturnType<typeof openDb>

/** Find artifacts by exact name, falling back to substring match. */
async function findArtifacts(db: CliDb, name: string, type?: string) {
  const base = () => {
    let q = db
      .selectFrom('artifacts')
      .leftJoin('projects', 'projects.id', 'artifacts.project_id')
      .selectAll('artifacts')
      .select('projects.name as project_name')
    if (type) q = q.where('artifacts.type', '=', type as 'skill')
    return q
  }
  const exact = await base().where('artifacts.name', '=', name).execute()
  if (exact.length > 0) return exact
  return base().where('artifacts.name', 'like', `%${name}%`).execute()
}

const describeArtifact = (a: { type: string; name: string; project_name: string | null; harness: string }) =>
  `${a.type.padEnd(11)} ${a.name}  (${a.project_name ?? `global/${a.harness}`})`

/** Project row for a repo path, registering it (scan + upload) when unknown. */
async function projectFor(db: CliDb, target: string) {
  const abs = path.resolve(target)
  let project = await db.selectFrom('projects').selectAll().where('root_path', '=', abs).executeTakeFirst()
  if (!project) {
    const summary = await addProject(db, abs)
    console.log(`Registered project "${summary.project}" (${summary.added} artifacts uploaded)`)
    project = await db.selectFrom('projects').selectAll().where('root_path', '=', abs).executeTakeFirstOrThrow()
  }
  return project
}

program
  .command('search <query>')
  .description('Search stored skills, MCP servers, and agent files by name')
  .option('-t, --type <type>', 'filter: skill | mcp_server | agent_md')
  .action(async (query: string, opts: { type?: string }) => {
    const db = openDb(dbPath())
    try {
      const rows = await findArtifacts(db, query, opts.type)
      if (rows.length === 0) {
        console.log(`No artifacts matching "${query}".`)
        return
      }
      for (const a of rows) console.log(describeArtifact(a))
    } finally {
      await db.destroy()
    }
  })

program
  .command('attach <name> [path]')
  .description('Share a stored skill or MCP server into a repo and write it to disk')
  .option('-t, --type <type>', 'disambiguate: skill | mcp_server | agent_md')
  .action(async (name: string, target = '.', opts: { type?: string }) => {
    const db = openDb(dbPath())
    try {
      const matches = await findArtifacts(db, name, opts.type)
      if (matches.length === 0) {
        console.error(`No artifact matching "${name}". Try: dai search ${name}`)
        process.exitCode = 1
        return
      }
      if (matches.length > 1) {
        console.error(`"${name}" is ambiguous; use the exact name (and --type):`)
        for (const a of matches) console.error(`  ${describeArtifact(a)}`)
        process.exitCode = 1
        return
      }
      const project = await projectFor(db, target)
      const summary = await attachArtifact(db, project.id, matches[0].id)
      console.log(`Attached ${matches[0].type} "${matches[0].name}" to ${project.name}`)
      for (const file of summary.written) console.log(`synced ${file}`)
    } finally {
      await db.destroy()
    }
  })

program
  .command('detach <name> [path]')
  .description('Remove a shared skill or MCP server from a repo (unlink + delete from disk)')
  .option('-t, --type <type>', 'disambiguate: skill | mcp_server | agent_md')
  .action(async (name: string, target = '.', opts: { type?: string }) => {
    const db = openDb(dbPath())
    try {
      const abs = path.resolve(target)
      const project = await db.selectFrom('projects').selectAll().where('root_path', '=', abs).executeTakeFirst()
      if (!project) {
        console.error(`Project not registered: ${abs}`)
        process.exitCode = 1
        return
      }
      // Only consider artifacts actually shared into this project.
      const linked = await db
        .selectFrom('project_artifacts')
        .innerJoin('artifacts', 'artifacts.id', 'project_artifacts.artifact_id')
        .leftJoin('projects', 'projects.id', 'artifacts.project_id')
        .selectAll('artifacts')
        .select('projects.name as project_name')
        .where('project_artifacts.project_id', '=', project.id)
        .execute()
      const matches = linked.filter(
        (a) => (a.name === name || a.name.includes(name)) && (!opts.type || a.type === opts.type),
      )
      if (matches.length === 0) {
        console.error(`No shared artifact matching "${name}" in ${project.name}.`)
        process.exitCode = 1
        return
      }
      if (matches.length > 1) {
        console.error(`"${name}" is ambiguous; use the exact name (and --type):`)
        for (const a of matches) console.error(`  ${describeArtifact(a)}`)
        process.exitCode = 1
        return
      }
      const result = await detachArtifact(db, project.id, matches[0].id)
      console.log(`Detached ${matches[0].type} "${matches[0].name}" from ${project.name}`)
      for (const file of result.removed) console.log(`removed ${file}`)
    } finally {
      await db.destroy()
    }
  })

program
  .command('delete <name>')
  .description('Delete a stored artifact everywhere: harness global config, attached repos, and the store')
  .option('-t, --type <type>', 'disambiguate: skill | mcp_server | agent_md')
  .action(async (name: string, opts: { type?: string }) => {
    const db = openDb(dbPath())
    try {
      const matches = await findArtifacts(db, name, opts.type)
      if (matches.length === 0) {
        console.error(`No artifact matching "${name}". Try: dai search ${name}`)
        process.exitCode = 1
        return
      }
      if (matches.length > 1) {
        console.error(`"${name}" is ambiguous; use the exact name (and --type):`)
        for (const a of matches) console.error(`  ${describeArtifact(a)}`)
        process.exitCode = 1
        return
      }
      const summary = await deleteArtifact(db, matches[0].id)
      console.log(`Deleted ${summary.deleted.type} "${summary.deleted.name}"`)
      if (summary.global?.status === 'removed') console.log(`removed from ${summary.global.file}`)
      for (const d of summary.detached) {
        for (const file of d.removed) console.log(`removed ${file} (${d.project})`)
      }
    } finally {
      await db.destroy()
    }
  })

program
  .command('capture')
  .description('Capture a session transcript (invoked by Claude Code hooks; reads the hook payload from stdin)')
  .option('-q, --quiet', 'suppress output')
  .action(async (opts: { quiet?: boolean }) => {
    // Runs inside a live session: fail open, never non-zero, never break the session.
    try {
      let input = ''
      for await (const chunk of process.stdin) input += chunk
      const payload: { transcript_path?: string; session_id?: string; cwd?: string } = JSON.parse(input)
      const file = resolveTranscriptPath(payload)
      if (!file) {
        if (!opts.quiet) console.error('capture: could not locate a transcript for this session')
        return
      }
      const db = openDb(dbPath())
      try {
        const result = await importSessionFile(db, { harness: 'claude', file })
        if (!opts.quiet) console.log(`capture: ${result} ${file}`)
      } finally {
        await db.destroy()
      }
    } catch (err) {
      if (!opts.quiet) console.error(`capture: ${err instanceof Error ? err.message : err}`)
    }
  })

const importableHarnesses = sessionHarnesses()

program
  .command('import')
  .description(`Import locally stored sessions from ${importableHarnesses.map((h) => h.label).join(', ')}`)
  .option('--harness <harness>', `only import one harness: ${importableHarnesses.map((h) => h.id).join(' | ')}`)
  .option('-f, --force', 'reimport even when session files are unchanged')
  .action(async (opts: { harness?: string; force?: boolean }) => {
    if (opts.harness && !importableHarnesses.some((h) => h.id === opts.harness)) {
      console.error(`Unknown harness "${opts.harness}". Use ${importableHarnesses.map((h) => h.id).join(', ')}.`)
      process.exitCode = 1
      return
    }
    const db = openDb(dbPath())
    try {
      const s = await importAllSessions(db, opts)
      console.log(`Sessions: ${s.imported} imported, ${s.updated} updated, ${s.skipped} unchanged, ${s.failed} failed`)
    } finally {
      await db.destroy()
    }
  })

program
  .command('sessions')
  .description('List captured sessions')
  .option('-n, --limit <n>', 'max sessions to show', '20')
  .action(async (opts: { limit: string }) => {
    const db = openDb(dbPath())
    try {
      const rows = await db
        .selectFrom('sessions')
        .selectAll()
        .orderBy('started_at', 'desc')
        .limit(Number(opts.limit) || 20)
        .execute()
      if (rows.length === 0) {
        console.log('No sessions yet. Run: dai import  (or dai hook to capture live sessions)')
        return
      }
      for (const s of rows) {
        const when = (s.started_at ?? '').slice(0, 16).replace('T', ' ')
        const where = s.project_path ?? '-'
        const label = s.title ?? s.external_id
        console.log(`${when}  ${s.harness.padEnd(7)} ${String(s.message_count).padStart(5)} msgs  ${where}  ${label}`)
      }
    } finally {
      await db.destroy()
    }
  })

program
  .command('list')
  .description('List registered projects and their artifacts')
  .action(async () => {
    const db = openDb(dbPath())
    try {
      const globals = await db
        .selectFrom('artifacts')
        .selectAll()
        .where('project_id', 'is', null)
        .orderBy('harness')
        .orderBy('name')
        .execute()
      if (globals.length > 0) {
        console.log('global  (all projects)')
        for (const a of globals) {
          const pin = a.pinned_version_id ? ' [pinned]' : ''
          console.log(`  ${a.type.padEnd(11)} ${a.name}${pin}  (${a.harness})`)
        }
      }
      const projects = await db.selectFrom('projects').selectAll().orderBy('name').execute()
      if (projects.length === 0 && globals.length === 0) {
        console.log('No projects yet. Run: dai add .')
        return
      }
      for (const project of projects) {
        console.log(`${project.name}  (${project.root_path})`)
        const artifacts = await db
          .selectFrom('artifacts')
          .selectAll()
          .where('project_id', '=', project.id)
          .orderBy('type')
          .orderBy('name')
          .execute()
        for (const a of artifacts) {
          const pin = a.pinned_version_id ? ' [pinned]' : ''
          console.log(`  ${a.type.padEnd(11)} ${a.name}${pin}`)
        }
      }
    } finally {
      await db.destroy()
    }
  })

program
  .command('webui')
  .alias('serve')
  .description('Start the Daiko web UI')
  .option('-p, --port <port>', 'port to listen on')
  .option('--no-open', 'do not open the browser')
  .action(async (opts: { port?: string; open: boolean }) => {
    const config = readConfig()
    const port = opts.port ? Number(opts.port) : config.port
    const db = openDb(dbPath())
    const actual = await startServer(db, port)
    const url = `http://localhost:${actual}`
    console.log(`Daiko web UI running at ${url}`)
    if (opts.open && process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    }
  })

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
