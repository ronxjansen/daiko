import fs from 'node:fs'
import path from 'node:path'
import { createInterface, type Interface } from 'node:readline/promises'
import { openDb } from '../db/index.js'
import { discoverProjects, installedHarnesses, type DiscoveredProject } from '../core/discover.js'
import { dbPath, DEFAULT_PORT, ensureHome, readConfig, writeConfig } from '../core/paths.js'
import { addGlobalMcpServers, addProject, type AddConflict } from '../core/store.js'
import { harnessById } from '../core/harnesses/index.js'
import { importAllSessions, type ImportSummary } from '../core/sessions.js'
import { detectHookHarnesses, hookHarnessIds, installHooks } from './hook.js'

export interface InitOptions {
  port?: string
  /** Accept every default without prompting (implied when stdin/stdout is not a TTY). */
  yes?: boolean
  /** commander --no-sessions / --no-scan set these to false. */
  sessions: boolean
  scan: boolean
  hooks?: string
  harness?: string[]
  repos?: string[]
}

const HOOK_MODES = ['global', 'repo', 'none'] as const
type HookMode = (typeof HOOK_MODES)[number]

/** "1,3,5-7" | "1 3 5-7" | "all" → 0-based indexes into a list of `max` items; null = unparseable. */
export function parseSelection(input: string, max: number): number[] | null {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === '' || trimmed === 'all' || trimmed === '*') return [...Array(max).keys()]
  if (trimmed === 'none') return []
  const picked = new Set<number>()
  for (const part of trimmed.split(/[\s,]+/)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) return null
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    if (from < 1 || to > max || from > to) return null
    for (let i = from; i <= to; i++) picked.add(i - 1)
  }
  return [...picked].sort((a, b) => a - b)
}

async function confirm(rl: Interface, question: string, def = true): Promise<boolean> {
  const answer = (await rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
  if (answer === '') return def
  return answer === 'y' || answer === 'yes'
}

const projectLine = (p: DiscoveredProject, index: number, width: number) => {
  const labels = p.harnesses.map((h) => harnessById(h)?.label ?? h).join(', ') || 'requested via --repos'
  const marks = [p.git ? null : 'no git', p.registered ? 'already added' : null].filter(Boolean).join(', ')
  return `  ${String(index + 1).padStart(width)}. ${p.path}  —  ${labels}${marks ? `  (${marks})` : ''}`
}

function reportConflicts(conflicts: AddConflict[]): void {
  for (const c of conflicts) {
    const groups = c.variants.map((v) => v.harnesses.map((h) => harnessById(h)?.label ?? h).join('+')).join(' vs ')
    console.error(`conflict ${c.type} "${c.name}": copies differ across harnesses (${groups}); kept the stored version`)
  }
}

/**
 * Onboarding: detect installed harnesses, import every session transcript, discover the
 * projects those harnesses have been used in, upload each project's skills/MCP servers/
 * agent files, and optionally install hooks. Interactive by TTY default; every step is
 * idempotent, so rerunning init (new machine, new harness, new repos) is always safe.
 * Steps are ordered by intrusiveness: everything before hooks only writes to ~/.daiko.
 */
export async function runInit(opts: InitOptions): Promise<void> {
  if (opts.hooks && !HOOK_MODES.includes(opts.hooks as HookMode)) {
    console.error(`Unknown --hooks mode "${opts.hooks}". Use ${HOOK_MODES.join(', ')}.`)
    process.exitCode = 1
    return
  }
  const unknown = (opts.harness ?? []).filter((h) => !harnessById(h))
  if (unknown.length > 0) {
    console.error(`Unknown harness "${unknown[0]}".`)
    process.exitCode = 1
    return
  }

  ensureHome()
  writeConfig({ port: opts.port ? Number(opts.port) || DEFAULT_PORT : readConfig().port })

  const detected = installedHarnesses()
  const harnesses = opts.harness ? detected.filter((h) => opts.harness!.includes(h.id)) : detected
  if (harnesses.length === 0) {
    console.log('No harnesses detected (looked for ~/.claude, ~/.codex, ~/.cursor, ~/.gemini). Nothing to onboard.')
    return
  }
  console.log(`Detected harnesses: ${harnesses.map((h) => h.label).join(', ')}`)

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !opts.yes)
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null
  const db = openDb(dbPath())
  try {
    // 1. Sessions first: their project paths feed discovery, and importing needs no repo.
    if (opts.sessions && (!rl || (await confirm(rl, 'Import session transcripts from their local stores?')))) {
      const total: ImportSummary = { imported: 0, updated: 0, skipped: 0, failed: 0 }
      for (const h of harnesses) {
        const s = await importAllSessions(db, { harness: h.id })
        total.imported += s.imported
        total.updated += s.updated
        total.skipped += s.skipped
        total.failed += s.failed
      }
      console.log(`Sessions: ${total.imported} imported, ${total.updated} updated, ${total.skipped} unchanged, ${total.failed} failed`)
    }

    // 2. Discover projects from harness global state + imported session paths.
    const wantedIds = new Set(harnesses.map((h) => h.id))
    let candidates = (await discoverProjects(db)).filter((p) => p.harnesses.some((h) => wantedIds.has(h)))
    if (opts.repos) {
      const chosen = opts.repos.map((r) => path.resolve(r))
      candidates = candidates.filter((p) => chosen.includes(p.path))
      for (const p of chosen.filter((c) => !candidates.some((x) => x.path === c))) {
        candidates.push({ path: p, harnesses: [], git: fs.existsSync(path.join(p, '.git')), registered: false })
      }
      candidates.sort((a, b) => a.path.localeCompare(b.path))
    }
    if (candidates.length === 0) {
      console.log('No projects discovered. Register repos individually with: dai add <path>')
      return
    }
    const width = String(candidates.length).length
    console.log(`\nDiscovered ${candidates.length} project${candidates.length === 1 ? '' : 's'}:`)
    candidates.forEach((p, i) => console.log(projectLine(p, i, width)))

    // 3. Scan + upload each project's config into the store (writes only to ~/.daiko).
    let selected = candidates
    if (opts.scan) {
      if (rl) {
        const answer = (await rl.question(`Scan these repos and upload their skills, MCP servers, and agent files? [Y/n/numbers like "1,3-5"] `)).trim()
        if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
          selected = []
        } else if (!['', 'y', 'yes'].includes(answer.toLowerCase())) {
          const picked = parseSelection(answer, candidates.length)
          if (!picked) {
            console.error(`Could not parse "${answer}"; skipping the scan step.`)
            selected = []
          } else {
            selected = picked.map((i) => candidates[i])
          }
        }
      }
      let added = 0
      let updated = 0
      let unchanged = 0
      for (const p of selected) {
        const summary = await addProject(db, p.path)
        added += summary.added
        updated += summary.updated
        unchanged += summary.unchanged
        reportConflicts(summary.conflicts)
      }
      if (selected.length > 0) {
        const globals = await addGlobalMcpServers(db)
        reportConflicts(globals.conflicts)
        console.log(
          `Uploaded from ${selected.length} repo${selected.length === 1 ? '' : 's'}: ${added + globals.added} added, ${updated + globals.updated} updated, ${unchanged + globals.unchanged} unchanged`,
        )
      }
    }

    // 4. Hooks, the only step that writes outside ~/.daiko. Global is the recommended
    // default: one config per harness under ~, covers every repo, nothing to commit.
    const hookable = detectHookHarnesses().filter((id) => wantedIds.has(id))
    let mode: HookMode = (opts.hooks as HookMode) ?? 'none'
    if (rl && !opts.hooks && hookable.length > 0) {
      console.log('\nInstall hooks? New sessions then auto-sync artifacts and capture their transcripts.')
      console.log('  1. global — one config per harness under ~ (recommended; nothing to commit)')
      console.log(`  2. per-repo — writes hook config files into each of the ${selected.length} selected repos (commit them)`)
      console.log('  3. none')
      const answer = (await rl.question('Choice [1]: ')).trim()
      mode = answer === '2' || answer === 'repo' ? 'repo' : answer === '3' || answer === 'none' || answer.toLowerCase() === 'n' ? 'none' : 'global'
    }
    if (mode !== 'none' && hookable.length === 0) {
      console.log(`No hook-capable harness selected (${hookHarnessIds.join(', ')}); skipping hooks.`)
    } else if (mode === 'global') {
      const { installed, failed } = installHooks(process.cwd(), { global: true, harnesses: hookable })
      for (const r of installed) console.log(`${r.harness.padEnd(7)} ${r.note}  →  ${r.file}`)
      for (const f of failed) console.error(`${f.harness.padEnd(7)} FAILED: ${f.error}`)
      if (installed.length > 0) console.log('Every new session in a registered repo now syncs on start and is captured as it runs.')
    } else if (mode === 'repo' && selected.length === 0) {
      console.log('No repos selected; skipping per-repo hooks. Install later with: dai hook <repo>')
    } else if (mode === 'repo') {
      if (rl && !(await confirm(rl, `This writes hook config files into ${selected.length} repo${selected.length === 1 ? '' : 's'} (.claude/settings.json, .codex/hooks.json, ...). Continue?`))) {
        console.log('Skipped hooks. Install later with: dai hook <repo>  (or dai hook -g)')
      } else {
        for (const p of selected) {
          const { installed, failed } = installHooks(p.path, { harnesses: hookable })
          for (const r of installed) console.log(`${r.harness.padEnd(7)} ${r.note}  →  ${r.file}`)
          for (const f of failed) console.error(`${f.harness.padEnd(7)} FAILED: ${f.error}`)
        }
        console.log('Review the new hook config files in each repo and check them into git.')
      }
    } else if (!opts.hooks) {
      console.log('Hooks not installed. Install later with: dai hook -g  (global) or dai hook <repo>')
    }

    console.log('\nDone. Explore everything with: dai webui')
  } finally {
    rl?.close()
    await db.destroy()
  }
}
