import { Command } from 'commander'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db/index.js'
import { daikoHome, dbPath, ensureHome, readConfig } from '../core/paths.js'
import {
  addGlobalMcpServers,
  addProject,
  attachArtifact,
  type AddConflict,
  deleteArtifact,
  detachArtifact,
  linkedArtifacts,
  setTargets,
  type SyncSkip,
  syncProject,
  targetsFor,
  targetsOf,
} from '../core/store.js'
import { estimateCostUsd, formatTokens } from '../core/pricing.js'
import { HARNESSES, harnessById, sessionHarnesses } from '../core/harnesses/index.js'
import { harnessesSupporting, renderPaths } from '../core/render.js'
import { importAllSessions, importSessionFile } from '../core/sessions.js'
import { detectHookHarnesses, hookHarnessIds, installHooks } from './hook.js'
import { runInit } from './init.js'
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

// Works from both src/cli (dev via tsx) and dist/cli (built): package.json is two levels up.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }

const program = new Command()

program.name('dai').description('Daiko: sync MCP servers, skills, and agent files across agents and projects').version(version)

program
  .command('init')
  .description('Onboard this machine: detect harnesses, import all sessions, discover + scan every repo they were used in, optionally install hooks')
  .option('-p, --port <port>', 'web UI port')
  .option('-y, --yes', 'accept the defaults for every step without prompting')
  .option('--harness <harnesses...>', `limit onboarding to these harnesses: ${HARNESSES.filter((h) => h.globalConfigDir).map((h) => h.id).join(' | ')}`)
  .option('--repos <paths...>', 'only onboard these repos instead of the discovered set')
  .option('--no-sessions', 'skip the transcript import')
  .option('--no-scan', 'skip scanning repos for skills, MCP servers, and agent files')
  .option('--hooks <mode>', 'install hooks without asking: global | repo | none')
  .action(runInit)

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
      reportConflicts(summary.conflicts)
      const globals = await addGlobalMcpServers(db)
      console.log(
        `Global MCP servers: ${globals.added} added, ${globals.updated} updated, ${globals.unchanged} unchanged`,
      )
      reportConflicts(globals.conflicts)
    } finally {
      await db.destroy()
    }
  })

/** How a user gets an unsynced file out of limbo: add the local edit, or force it away. */
function describeSkip(skip: SyncSkip, target: string): string {
  if (skip.reason === 'no-target') {
    const labels = (skip.targets ?? []).map((h) => harnessById(h)?.label ?? h).join(', ')
    return `${skip.artifact}: nothing written \u2014 none of its targets (${labels}) can hold it in a project; run "dai target ${skip.artifact}" to pick one that can`
  }
  return skip.reason === 'unreadable'
    ? `${skip.relPath}: not valid JSON \u2014 fix it, or run "dai sync ${target} --force" to replace it`
    : `${skip.relPath} (${skip.artifact}): local edit not in the store \u2014 run "dai add ${target}" to keep it, or "dai sync ${target} --force" to discard it`
}

/**
 * One artifact, several harness copies, no agreement on the content. The store keeps what
 * it has rather than letting the copies overwrite each other, so the user has to say which
 * one is right — by editing the others to match, or by deleting them.
 */
function reportConflicts(conflicts: AddConflict[]): void {
  for (const c of conflicts) {
    const groups = c.variants.map((v) => v.harnesses.map((h) => harnessById(h)?.label ?? h).join('+')).join(' vs ')
    console.error(`conflict ${c.type} "${c.name}": copies differ across harnesses (${groups}); kept the stored version`)
  }
}

/**
 * Sync as a harness hook: the project dir comes from the hook payload on stdin
 * (cwd for Claude/Codex/Gemini, workspace_roots for Cursor) since not every harness
 * spawns hooks in the session's directory. Runs inside a live session: fail open,
 * never non-zero, nothing on stdout (Codex and Gemini parse hook stdout as JSON).
 */
async function syncFromHookPayload(): Promise<void> {
  try {
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    let dir = process.cwd()
    try {
      const payload: { cwd?: string; workspace_roots?: string[] } = JSON.parse(input)
      dir = payload.cwd ?? payload.workspace_roots?.[0] ?? dir
    } catch {
      // no payload: sync the working directory
    }
    const db = openDb(dbPath())
    try {
      const summary = await syncProject(db, dir)
      // stderr only (stdout must stay clean), so a session start still surfaces what it refused to overwrite.
      for (const skip of summary.skipped) console.error(`dai sync: ${describeSkip(skip, dir)}`)
    } finally {
      await db.destroy()
    }
  } catch (err) {
    console.error(`sync: ${err instanceof Error ? err.message : err}`)
  }
}

program
  .command('sync [path]')
  .description('Write stored skills, MCP servers, and agent files back into the repo')
  .option('-q, --quiet', 'suppress output when nothing changed')
  .option('-f, --force', 'overwrite local edits that were never added to the store')
  .option('--hook', 'run as a harness hook: read the payload from stdin and sync its project dir')
  .action(async (target = '.', opts: { quiet?: boolean; force?: boolean; hook?: boolean }) => {
    if (opts.hook) {
      await syncFromHookPayload()
      return
    }
    const db = openDb(dbPath())
    try {
      const summary = await syncProject(db, target, { force: opts.force })
      if (summary.missingProject) {
        if (!opts.quiet) console.error(`Project not registered. Run: dai add ${target}`)
        process.exitCode = opts.quiet ? 0 : 1
        return
      }
      if (summary.written.length === 0 && summary.removed.length === 0) {
        if (!opts.quiet && summary.skipped.length === 0) console.log('Already up to date.')
      } else {
        for (const file of summary.written) console.log(`synced ${file}`)
        // Bundled skill files dropped upstream: removing them here keeps the skill faithful.
        for (const file of summary.removed) console.log(`removed ${file}`)
      }
      // Reported even with --quiet: a skip means stored and local content disagree.
      for (const skip of summary.skipped) console.error(`skipped ${describeSkip(skip, target)}`)
    } finally {
      await db.destroy()
    }
  })

program
  .command('hook [path]')
  .description('Install harness hooks (Claude Code, Codex, Cursor, Gemini): auto "dai sync" on session start, transcript capture as sessions progress')
  .option('-g, --global', 'install in the harness global configs (~/.claude, ~/.codex, ...): sync + capture for all projects')
  .option('--harness <harnesses...>', `harnesses to install hooks for: ${hookHarnessIds.join(' | ')} (default: all detected on this machine)`)
  .action((target = '.', opts: { global?: boolean; harness?: string[] }) => {
    const unknown = (opts.harness ?? []).filter((h) => !hookHarnessIds.includes(h))
    if (unknown.length > 0) {
      console.error(`Unknown harness "${unknown[0]}". Use ${hookHarnessIds.join(', ')}.`)
      process.exitCode = 1
      return
    }
    const harnesses = opts.harness ?? detectHookHarnesses()
    if (harnesses.length === 0) {
      console.error('No harnesses detected (looked for ~/.claude, ~/.codex, ~/.cursor, ~/.gemini). Use --harness to install anyway.')
      process.exitCode = 1
      return
    }
    const { installed, failed } = installHooks(path.resolve(target), { global: opts.global, harnesses })
    for (const r of installed) console.log(`${r.harness.padEnd(7)} ${r.note}  →  ${r.file}`)
    for (const f of failed) console.error(`${f.harness.padEnd(7)} FAILED: ${f.error}`)
    if (installed.length > 0 && opts.global) {
      console.log('Every new session in a registered repo now syncs its skills, MCP servers, and agent files on start.')
    }
    if (failed.length > 0) process.exitCode = 1
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

const describeArtifact = (a: { type: string; name: string; project_name: string | null }) =>
  `${a.type.padEnd(11)} ${a.name}  (${a.project_name ?? 'global'})`

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
      const artifact = await resolveOne(db, name, opts.type)
      if (!artifact) return
      const project = await projectFor(db, target)
      const summary = await attachArtifact(db, project.id, artifact.id)
      console.log(`Attached ${artifact.type} "${artifact.name}" to ${project.name}`)
      for (const file of summary.written) console.log(`synced ${file}`)
      for (const file of summary.removed) console.log(`removed ${file}`)
      for (const skip of summary.skipped) console.error(`skipped ${describeSkip(skip, target)}`)
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
      const linked = await linkedArtifacts(db, project.id)
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

/** Resolve a name to exactly one artifact, printing the ambiguity when there isn't one. */
async function resolveOne(db: CliDb, name: string, type?: string) {
  const matches = await findArtifacts(db, name, type)
  if (matches.length === 0) {
    console.error(`No artifact matching "${name}". Try: dai search ${name}`)
    process.exitCode = 1
    return null
  }
  if (matches.length > 1) {
    console.error(`"${name}" is ambiguous; use the exact name (and --type):`)
    for (const a of matches) console.error(`  ${describeArtifact(a)}`)
    process.exitCode = 1
    return null
  }
  return matches[0]
}

program
  .command('target <name> [harnesses...]')
  .description('Show or set which harnesses an artifact is deployed to (one artifact, many harness formats)')
  .option('-t, --type <type>', 'disambiguate: skill | mcp_server | agent_md')
  .option('-a, --all', 'target every harness that can host this artifact type')
  .action(async (name: string, harnesses: string[], opts: { type?: string; all?: boolean }) => {
    const db = openDb(dbPath())
    try {
      const artifact = await resolveOne(db, name, opts.type)
      if (!artifact) return
      const supported = harnessesSupporting(artifact.type)

      let wanted = opts.all ? supported : harnesses
      if (wanted.length > 0) {
        const unknown = wanted.filter((h) => !harnessById(h))
        if (unknown.length > 0) {
          console.error(`Unknown harness "${unknown[0]}". Use ${HARNESSES.map((h) => h.id).join(', ')}.`)
          process.exitCode = 1
          return
        }
        // Targeting a harness that cannot hold this type would silently write nothing.
        const unable = wanted.filter((h) => !supported.includes(h))
        if (unable.length > 0) {
          console.error(`${unable.join(', ')} cannot hold a ${artifact.type}. Supported: ${supported.join(', ') || 'none'}.`)
          process.exitCode = 1
          return
        }
        wanted = await setTargets(db, artifact.id, wanted)
        console.log(`${artifact.type} "${artifact.name}" now targets: ${wanted.join(', ')}`)
      } else {
        wanted = await targetsOf(db, artifact.id)
        if (wanted.length === 0) wanted = [artifact.origin_harness]
        console.log(`${artifact.type} "${artifact.name}" (${artifact.project_name ?? 'global'})`)
        console.log(`  targets:   ${wanted.join(', ')}`)
        console.log(`  available: ${supported.join(', ') || 'none'}`)
      }

      const paths = renderPaths(artifact, wanted)
      if (paths.length === 0) console.log('  writes:    nothing \u2014 no target can hold this in a project tree')
      else for (const p of paths) console.log(`  writes:    ${p.relPath}  (${p.harness})`)
      console.log('Run "dai sync <repo>" to apply.')
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
      const artifact = await resolveOne(db, name, opts.type)
      if (!artifact) return
      const summary = await deleteArtifact(db, artifact.id)
      console.log(`Deleted ${summary.deleted.type} "${summary.deleted.name}"`)
      for (const g of summary.globals) if (g.status === 'removed') console.log(`removed from ${g.file}`)
      for (const d of summary.detached) {
        for (const file of d.removed) console.log(`removed ${file} (${d.project})`)
      }
    } finally {
      await db.destroy()
    }
  })

const importableHarnesses = sessionHarnesses()

program
  .command('capture')
  .description('Capture a session transcript (invoked by harness hooks; reads the hook payload from stdin)')
  .option('--harness <harness>', `harness that produced the session: ${importableHarnesses.map((h) => h.id).join(' | ')}`, 'claude')
  .option('-q, --quiet', 'suppress output')
  .action(async (opts: { harness: string; quiet?: boolean }) => {
    // Runs inside a live session: fail open, never non-zero, never break the session.
    try {
      if (!importableHarnesses.some((h) => h.id === opts.harness)) {
        if (!opts.quiet) console.error(`capture: unknown harness "${opts.harness}"`)
        return
      }
      let input = ''
      for await (const chunk of process.stdin) input += chunk
      let payload: { transcript_path?: string; session_id?: string; cwd?: string } = {}
      try {
        payload = JSON.parse(input)
      } catch {
        // no payload: fall through to the per-harness fallbacks below
      }
      const db = openDb(dbPath())
      try {
        if (opts.harness === 'claude') {
          const file = resolveTranscriptPath(payload)
          if (!file) {
            if (!opts.quiet) console.error('capture: could not locate a transcript for this session')
            return
          }
          const result = await importSessionFile(db, { harness: 'claude', file })
          if (!opts.quiet) console.log(`capture: ${result} ${file}`)
        } else if (payload.transcript_path && fs.existsSync(payload.transcript_path)) {
          const result = await importSessionFile(db, { harness: opts.harness, file: payload.transcript_path })
          if (!opts.quiet) console.log(`capture: ${result} ${payload.transcript_path}`)
        } else {
          // No transcript path in the payload: rescan this harness's session store
          // (cheap — unchanged files are skipped on mtime + size).
          const s = await importAllSessions(db, { harness: opts.harness })
          if (!opts.quiet) console.log(`capture: ${opts.harness} rescan — ${s.imported} imported, ${s.updated} updated`)
        }
      } finally {
        await db.destroy()
      }
    } catch (err) {
      if (!opts.quiet) console.error(`capture: ${err instanceof Error ? err.message : err}`)
    }
  })

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
        const usage =
          s.input_tokens !== null
            ? { input: s.input_tokens, output: s.output_tokens ?? 0, cacheRead: s.cache_read_tokens ?? 0, cacheWrite: s.cache_write_tokens ?? 0 }
            : null
        const tokens = usage ? formatTokens(usage.input + usage.output + usage.cacheRead + usage.cacheWrite) : '-'
        const cost = estimateCostUsd(s.model, usage)
        const costLabel = cost !== null ? `$${cost.toFixed(2)}` : '-'
        console.log(
          `${when}  ${s.harness.padEnd(7)} ${String(s.message_count).padStart(5)} msgs  ${tokens.padStart(7)} tok  ${costLabel.padStart(7)}  ${(s.model ?? '-').padEnd(18)} ${where}  ${label}`,
        )
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
        .orderBy('type')
        .orderBy('name')
        .execute()
      const projects = await db.selectFrom('projects').selectAll().orderBy('name').execute()
      const owned = await db.selectFrom('artifacts').selectAll().where('project_id', 'is not', null).orderBy('type').orderBy('name').execute()
      const targets = await targetsFor(db, [...globals, ...owned].map((a) => a.id))
      // Targets are the interesting column now: one artifact, every harness it is deployed to.
      const describeRow = (a: (typeof globals)[number]) => {
        const pin = a.pinned_version_id ? ' [pinned]' : ''
        const to = (targets.get(a.id) ?? [a.origin_harness]).join(', ')
        return `  ${a.type.padEnd(11)} ${a.name}${pin}  \u2192 ${to}`
      }
      if (globals.length > 0) {
        console.log('global  (all projects)')
        for (const a of globals) console.log(describeRow(a))
      }
      if (projects.length === 0 && globals.length === 0) {
        console.log('No projects yet. Run: dai add .')
        return
      }
      for (const project of projects) {
        console.log(`${project.name}  (${project.root_path})`)
        for (const a of owned.filter((x) => x.project_id === project.id)) console.log(describeRow(a))
      }
    } finally {
      await db.destroy()
    }
  })

function webuiPidPath(): string {
  return path.join(daikoHome(), 'webui.pid')
}

function webuiLogPath(): string {
  return path.join(daikoHome(), 'webui.log')
}

/** Pid file holds "<pid>\n<port>". Returns the live daemon, or null (missing/stale pid file). */
function readDaemon(): { pid: number; port: number } | null {
  try {
    const [pidLine, portLine] = fs.readFileSync(webuiPidPath(), 'utf8').split('\n')
    const pid = Number(pidLine)
    if (!Number.isInteger(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return { pid, port: Number(portLine) || readConfig().port }
  } catch {
    return null
  }
}

function openBrowser(url: string): void {
  if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function startWebuiDaemon(port: number, open: boolean): Promise<void> {
  ensureHome()
  const running = readDaemon()
  if (running) {
    console.log(`Daiko web UI daemon already running at http://localhost:${running.port} (pid ${running.pid})`)
    if (open) openBrowser(`http://localhost:${running.port}`)
    return
  }
  const url = `http://localhost:${port}`
  const log = fs.openSync(webuiLogPath(), 'a')
  const child = spawn(process.execPath, [process.argv[1], 'webui', '--no-open', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  fs.closeSync(log)
  fs.writeFileSync(webuiPidPath(), `${child.pid}\n${port}\n`)
  child.unref()
  // Give the server a moment to bind so immediate failures (port in use, missing build) surface here.
  await sleep(700)
  if (!readDaemon()) {
    fs.rmSync(webuiPidPath(), { force: true })
    console.error(`Daemon failed to start; see ${webuiLogPath()}`)
    process.exitCode = 1
    return
  }
  console.log(`Daiko web UI daemon running at ${url} (pid ${child.pid})`)
  console.log(`Logs: ${webuiLogPath()} — stop with: dai webui stop`)
  if (open) openBrowser(url)
}

async function stopWebuiDaemon(): Promise<void> {
  const pid = readDaemon()?.pid
  if (!pid) {
    fs.rmSync(webuiPidPath(), { force: true })
    console.log('Daiko web UI daemon is not running.')
    return
  }
  process.kill(pid, 'SIGTERM')
  let alive = true
  for (let i = 0; i < 20 && alive; i++) {
    await sleep(100)
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
  }
  if (alive) {
    process.kill(pid, 'SIGKILL')
    await sleep(100)
  }
  fs.rmSync(webuiPidPath(), { force: true })
  console.log(`Stopped Daiko web UI daemon (pid ${pid}).`)
}

const webui = program
  .command('webui')
  .alias('serve')
  .description('Start the Daiko web UI')
  .option('-p, --port <port>', 'port to listen on')
  .option('-d, --daemon', 'run in the background (stop with: dai webui stop)')
  .option('--no-open', 'do not open the browser')
  .action(async (opts: { port?: string; daemon?: boolean; open: boolean }) => {
    const config = readConfig()
    const port = opts.port ? Number(opts.port) : config.port
    if (opts.daemon) {
      await startWebuiDaemon(port, opts.open)
      return
    }
    const db = openDb(dbPath())
    const actual = await startServer(db, port)
    const url = `http://localhost:${actual}`
    console.log(`Daiko web UI running at ${url}`)
    if (opts.open) openBrowser(url)
  })

webui
  .command('stop')
  .description('Stop the background web UI daemon')
  .action(stopWebuiDaemon)

webui
  .command('status')
  .description('Show whether the web UI daemon is running')
  .action(() => {
    const daemon = readDaemon()
    if (daemon) console.log(`Daiko web UI daemon running at http://localhost:${daemon.port} (pid ${daemon.pid})`)
    else console.log('Daiko web UI daemon is not running.')
  })

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
