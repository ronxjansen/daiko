// Smoke test: project discovery reads harness global state + session paths, never walks the disk. Run: npm test
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/index.js'
import { discoverProjects, gitRoot, installedHarnesses } from '../src/core/discover.js'
import { addProject } from '../src/core/store.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-discover-'))
const home = path.join(tmp, 'home')
const repo1 = path.join(tmp, 'repo1') // git repo; claude used a subdirectory of it
const repo1Sub = path.join(repo1, 'packages', 'web')
const repo2 = path.join(tmp, 'repo2') // plain dir, known to codex + cursor
const gone = path.join(tmp, 'deleted-repo') // referenced in config but no longer on disk

for (const dir of [home, path.join(repo1, '.git'), repo1Sub, repo2]) fs.mkdirSync(dir, { recursive: true })

// Installed harnesses: claude, codex, cursor (no ~/.gemini).
for (const dir of ['.claude', '.codex', '.cursor']) fs.mkdirSync(path.join(home, dir))

// Claude: ~/.claude.json projects map — a repo subdir (collapses to the git root), $HOME
// itself (excluded), and a deleted path (dropped).
fs.writeFileSync(
  path.join(home, '.claude.json'),
  JSON.stringify({ projects: { [repo1Sub]: {}, [home]: {}, [gone]: {} } }),
)
// Codex: trusted roots in ~/.codex/config.toml.
fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `[projects."${repo2}"]\ntrust_level = "trusted"\n`)
// Cursor: workspaceStorage/<hash>/workspace.json with a file:// URI (per-OS data dir).
const cursorData =
  process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Cursor')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Cursor')
      : path.join(home, '.config', 'Cursor')
const wsDir = path.join(cursorData, 'User', 'workspaceStorage', 'abc123')
fs.mkdirSync(wsDir, { recursive: true })
fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: `file://${repo2}` }))

const db = openDb(path.join(tmp, 'daiko.sqlite'))

try {
  assert.deepStrictEqual(
    installedHarnesses(home).map((h) => h.id),
    ['claude', 'codex', 'cursor'],
  )
  assert.strictEqual(gitRoot(repo1Sub), repo1)
  assert.strictEqual(gitRoot(home), null)

  // A captured codex session inside repo1 contributes its recorded project path.
  const now = new Date().toISOString()
  await db
    .insertInto('sessions')
    .values({
      id: randomUUID(),
      harness: 'codex',
      external_id: 'sess-1',
      source_path: path.join(tmp, 'rollout.jsonl'),
      project_path: repo1Sub,
      title: null,
      started_at: now,
      ended_at: now,
      message_count: 1,
      source_size: 1,
      source_mtime_ms: 1,
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  await addProject(db, repo2) // registered projects are flagged, not re-suggested blindly

  const projects = await discoverProjects(db, home)
  assert.deepStrictEqual(projects, [
    { path: repo1, harnesses: ['claude', 'codex'], git: true, registered: false },
    { path: repo2, harnesses: ['codex', 'cursor'], git: false, registered: true },
  ])

  console.log('smoke-discover: OK')
} finally {
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
}
