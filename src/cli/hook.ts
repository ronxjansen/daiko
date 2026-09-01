import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installedHarnesses } from '../core/discover.js'

// Hook commands are uniform across harnesses:
//  - "dai sync --hook" reads the hook payload from stdin (cwd / workspace_roots), syncs that
//    project, never exits non-zero, and prints nothing to stdout (Gemini and Codex parse
//    hook stdout as JSON output).
//  - "dai capture --harness <id> --quiet" imports the payload's transcript_path, falling
//    back to a rescan of that harness's session store.
const SYNC_COMMAND = 'dai sync --hook'
const captureCommand = (harness: string) => `dai capture --harness ${harness} --quiet`

interface HookEntry {
  type: string
  command: string
  timeout?: number
  async?: boolean
}

interface HookMatcher {
  matcher?: string
  hooks: HookEntry[]
}

/** Load a JSON config file; {} when missing, throws when unparseable (never clobber it). */
function readConfigFile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} exists but is not valid JSON; fix it first`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} exists but is not a JSON object; fix it first`)
  }
  return parsed as Record<string, unknown>
}

function writeConfigFile(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

/** "dai sync --hook" and "dai capture --harness x" both reduce to their "dai <verb>" base. */
const commandBase = (command: string) => command.split(' --')[0]

/**
 * Add a hook to a Claude-style nested hooks map (event → matcher groups → command hooks),
 * used verbatim by Claude Code, Codex, and Gemini. Skips when any existing hook in the
 * event already runs the same dai command (idempotent across re-runs and older installs).
 */
function ensureNestedHook(
  hooks: Record<string, HookMatcher[]>,
  event: string,
  command: string,
  extra: Partial<HookEntry> = {},
): void {
  const matchers: HookMatcher[] = Array.isArray(hooks[event]) ? hooks[event] : []
  const installed = matchers.some((m) => m.hooks?.some((h) => h.command?.includes(commandBase(command))))
  if (!installed) {
    matchers.push({ hooks: [{ type: 'command', command, ...extra }] })
  }
  hooks[event] = matchers
}

/** Same idempotent insert for Cursor's flat hooks map (event → array of hook definitions). */
function ensureFlatHook(hooks: Record<string, Array<{ command?: string }>>, event: string, command: string): void {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : []
  if (!entries.some((h) => h.command?.includes(commandBase(command)))) {
    entries.push({ command })
  }
  hooks[event] = entries
}

export interface HookInstallResult {
  harness: string
  file: string
  note: string
}

interface HookInstaller {
  id: string
  install(root: string): HookInstallResult
}

/** Config file for one harness: <root>/<dir>/<name>. Root is $HOME for global installs. */
const configPath = (root: string, dir: string, name: string) => path.join(root, dir, name)

const installers: HookInstaller[] = [
  {
    id: 'claude',
    // Claude Code: hooks live in settings.json; timeouts are seconds, capture runs async
    // so it can never delay or break a session.
    install(root) {
      const file = configPath(root, '.claude', 'settings.json')
      const settings = readConfigFile(file)
      const hooks = (settings.hooks ?? {}) as Record<string, HookMatcher[]>
      ensureNestedHook(hooks, 'SessionStart', SYNC_COMMAND)
      ensureNestedHook(hooks, 'Stop', captureCommand('claude'), { timeout: 30, async: true })
      ensureNestedHook(hooks, 'SessionEnd', captureCommand('claude'), { timeout: 30, async: true })
      settings.hooks = hooks
      writeConfigFile(file, settings)
      return { harness: 'claude', file, note: 'sync on SessionStart, capture on Stop/SessionEnd' }
    },
  },
  {
    id: 'codex',
    // Codex: same nested format in hooks.json; timeouts are seconds. Project-local hooks
    // only load once the repo's .codex layer is trusted. No SessionEnd capture: Codex caps
    // SessionEnd hooks at 1s (too tight for a Node CLI) and Stop already captures every turn.
    install(root) {
      const file = configPath(root, '.codex', 'hooks.json')
      const config = readConfigFile(file)
      const hooks = (config.hooks ?? {}) as Record<string, HookMatcher[]>
      ensureNestedHook(hooks, 'SessionStart', SYNC_COMMAND)
      ensureNestedHook(hooks, 'Stop', captureCommand('codex'), { timeout: 30, async: true })
      config.hooks = hooks
      writeConfigFile(file, config)
      return { harness: 'codex', file, note: 'sync on SessionStart, capture on Stop' }
    },
  },
  {
    id: 'cursor',
    // Cursor: flat hooks.json ({version, hooks: {event: [{command}]}}). Sync only — Daiko
    // has no parser for Cursor transcripts yet, so a capture hook would have nothing to import.
    install(root) {
      const file = configPath(root, '.cursor', 'hooks.json')
      const config = readConfigFile(file)
      config.version ??= 1
      const hooks = (config.hooks ?? {}) as Record<string, Array<{ command?: string }>>
      ensureFlatHook(hooks, 'sessionStart', SYNC_COMMAND)
      config.hooks = hooks
      writeConfigFile(file, config)
      return { harness: 'cursor', file, note: 'sync on sessionStart (no transcript capture yet)' }
    },
  },
  {
    id: 'gemini',
    // Gemini CLI: nested format in settings.json; timeouts are milliseconds and hooks run
    // synchronously (no async flag), so capture gets a hard 30s cap.
    install(root) {
      const file = configPath(root, '.gemini', 'settings.json')
      const settings = readConfigFile(file)
      const hooks = (settings.hooks ?? {}) as Record<string, HookMatcher[]>
      ensureNestedHook(hooks, 'SessionStart', SYNC_COMMAND)
      ensureNestedHook(hooks, 'AfterAgent', captureCommand('gemini'), { timeout: 30_000 })
      ensureNestedHook(hooks, 'SessionEnd', captureCommand('gemini'), { timeout: 30_000 })
      settings.hooks = hooks
      writeConfigFile(file, settings)
      return { harness: 'gemini', file, note: 'sync on SessionStart, capture on AfterAgent/SessionEnd' }
    },
  },
]

export const hookHarnessIds = installers.map((i) => i.id)

/** Hook-capable harnesses installed on this machine, per the adapter registry's globalConfigDir. */
export function detectHookHarnesses(home = os.homedir()): string[] {
  const installed = new Set(installedHarnesses(home).map((h) => h.id))
  return hookHarnessIds.filter((id) => installed.has(id))
}

export interface InstallHooksSummary {
  installed: HookInstallResult[]
  failed: Array<{ harness: string; error: string }>
}

/**
 * Install Daiko hooks for the given harnesses, in <project>/<dir>/... (or the harness's
 * global config under $HOME with global=true). Idempotent; a broken config file for one
 * harness never blocks the others.
 */
export function installHooks(
  projectRoot: string,
  opts: { global?: boolean; harnesses?: string[] } = {},
): InstallHooksSummary {
  const ids = opts.harnesses ?? hookHarnessIds
  const root = opts.global ? os.homedir() : projectRoot
  const summary: InstallHooksSummary = { installed: [], failed: [] }
  for (const installer of installers) {
    if (!ids.includes(installer.id)) continue
    try {
      summary.installed.push(installer.install(root))
    } catch (err) {
      summary.failed.push({ harness: installer.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return summary
}
