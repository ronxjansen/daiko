import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SYNC_COMMAND = 'dai sync --quiet'
const CAPTURE_COMMAND = 'dai capture --quiet'

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

function ensureHook(
  hooks: Record<string, HookMatcher[]>,
  event: string,
  command: string,
  extra: Partial<HookEntry> = {},
): void {
  const matchers: HookMatcher[] = Array.isArray(hooks[event]) ? hooks[event] : []
  const installed = matchers.some((m) => m.hooks?.some((h) => h.command?.includes(command.split(' --')[0])))
  if (!installed) {
    matchers.push({ matcher: '', hooks: [{ type: 'command', command, ...extra }] })
  }
  hooks[event] = matchers
}

/**
 * Install Claude Code hooks in <project>/.claude/settings.json (or ~/.claude/settings.json
 * with global=true). Idempotent. Installs:
 *  - SessionStart → dai sync     (auto-sync skills/MCP/agent files; with -g this covers every
 *                                  registered repo — sync exits quietly for unregistered dirs)
 *  - Stop         → dai capture  (store the full transcript after every assistant turn)
 *  - SessionEnd   → dai capture  (final capture when the session closes)
 */
export function installHook(projectRoot: string, opts: { global?: boolean } = {}): string {
  const settingsPath = opts.global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(projectRoot, '.claude', 'settings.json')
  let settings: Record<string, unknown> = {}
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    } catch {
      throw new Error(`${settingsPath} exists but is not valid JSON; fix it first`)
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, HookMatcher[]>
  // Capture hooks run async with a timeout so they can never delay or break a session.
  // The sync hook is safe globally too: "dai sync --quiet" exits 0 for unregistered dirs.
  ensureHook(hooks, 'SessionStart', SYNC_COMMAND)
  ensureHook(hooks, 'Stop', CAPTURE_COMMAND, { timeout: 30, async: true })
  ensureHook(hooks, 'SessionEnd', CAPTURE_COMMAND, { timeout: 30, async: true })
  settings.hooks = hooks

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return settingsPath
}
