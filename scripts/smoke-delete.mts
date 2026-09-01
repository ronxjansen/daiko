// Smoke test for global artifact deletion. Run: npm test
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/index.js'
import { addGlobalMcpServers, addProject, attachArtifact, deleteArtifact, syncProject } from '../src/core/store.js'
import { scanGlobalMcpServers } from '../src/core/scan.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-smoke-'))
const home = path.join(tmp, 'home')
const repo = path.join(tmp, 'repo')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(repo, { recursive: true })

// Fake global configs. ~/.claude.json includes unrelated state that must survive.
fs.writeFileSync(
  path.join(home, '.claude.json'),
  JSON.stringify(
    {
      numStartups: 42,
      projects: { '/somewhere': { allowedTools: [] } },
      mcpServers: {
        keepme: { command: 'keep', args: [] },
        deleteme: { command: 'gone', args: ['--x'] },
      },
    },
    null,
    2,
  ),
)
fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
fs.writeFileSync(
  path.join(home, '.cursor', 'mcp.json'),
  JSON.stringify({ mcpServers: { cursorkeep: { url: 'http://a' }, cursorgone: { url: 'http://b' } } }, null, 2),
)
fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
fs.writeFileSync(
  path.join(home, '.codex', 'config.toml'),
  `# my codex config
model = "gpt-5"

[mcp_servers.tomlkeep]
command = "keep"

# this one goes away
[mcp_servers.tomlgone]
command = "gone"
args = ["--flag"]

[mcp_servers.tomlgone.env]
KEY = "value"

[other_section]
foo = "bar"
`,
)

const db = openDb(path.join(tmp, 'daiko.sqlite'))

// Monkey-patch: scan/delete use os.homedir(); point it at the fake home.
const realHomedir = os.homedir
;(os as any).homedir = () => home

try {
  await addProject(db, repo)
  const globals = await addGlobalMcpServers(db)
  assert.strictEqual(globals.added, 6, `expected 6 global servers, got ${globals.added}`)

  const byName = async (name: string) =>
    db.selectFrom('artifacts').selectAll().where('name', '=', name).executeTakeFirstOrThrow()

  // Attach the claude global server to the repo and sync it into .mcp.json.
  const project = await db.selectFrom('projects').selectAll().executeTakeFirstOrThrow()
  await attachArtifact(db, project.id, (await byName('deleteme')).id)
  await syncProject(db, repo)
  const projMcp = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'))
  assert.ok(projMcp.mcpServers.deleteme, 'expected deleteme synced into project .mcp.json')

  // 1. Delete the claude global server: gone from ~/.claude.json AND the project .mcp.json.
  const summary = await deleteArtifact(db, (await byName('deleteme')).id, home)
  assert.strictEqual(summary.global?.status, 'removed')
  const claudeCfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))
  assert.ok(!('deleteme' in claudeCfg.mcpServers), 'deleteme still in ~/.claude.json')
  assert.ok('keepme' in claudeCfg.mcpServers, 'keepme lost from ~/.claude.json')
  assert.strictEqual(claudeCfg.numStartups, 42, 'unrelated key lost')
  assert.deepStrictEqual(claudeCfg.projects, { '/somewhere': { allowedTools: [] } }, 'projects key lost')
  const projMcp2 = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'))
  assert.ok(!('deleteme' in projMcp2.mcpServers), 'deleteme still in project .mcp.json')
  assert.deepStrictEqual(summary.detached, [{ project: path.basename(repo), removed: ['.mcp.json'] }])

  // No resurrection: a rescan of global configs must not find it again.
  const rescanned = scanGlobalMcpServers(home).map((s) => s.name)
  assert.ok(!rescanned.includes('deleteme'), 'deleteme resurrected by rescan')

  // 2. Delete the cursor global server.
  await deleteArtifact(db, (await byName('cursorgone')).id, home)
  const cursorCfg = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
  assert.deepStrictEqual(Object.keys(cursorCfg.mcpServers), ['cursorkeep'])

  // 3. Delete the codex TOML server: sections removed, comments/other sections kept.
  await deleteArtifact(db, (await byName('tomlgone')).id, home)
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
  assert.ok(!toml.includes('tomlgone'), `tomlgone still present:\n${toml}`)
  assert.ok(toml.includes('[mcp_servers.tomlkeep]'), 'tomlkeep section lost')
  assert.ok(toml.includes('# my codex config'), 'comments lost (fallback used unexpectedly)')
  assert.ok(toml.includes('[other_section]') && toml.includes('foo = "bar"'), 'other section lost')
  const rescanToml = scanGlobalMcpServers(home).map((s) => s.name)
  assert.ok(rescanToml.includes('tomlkeep') && !rescanToml.includes('tomlgone'), 'TOML rescan wrong')

  // 4. Invalid JSON: delete must abort, DB row must survive.
  fs.writeFileSync(path.join(home, '.claude.json'), '{ this is not json')
  const keep = await byName('keepme')
  await assert.rejects(() => deleteArtifact(db, keep.id, home), /not deleted.*invalid JSON/s)
  assert.ok(await db.selectFrom('artifacts').selectAll().where('name', '=', 'keepme').executeTakeFirst(), 'row deleted despite failure')
  assert.strictEqual(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{ this is not json', 'broken file was touched')

  // 5. Server absent from file (edited manually): delete proceeds with status 'absent'.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  const s5 = await deleteArtifact(db, keep.id, home)
  assert.strictEqual(s5.global?.status, 'absent')

  console.log('all smoke tests passed')
} finally {
  ;(os as any).homedir = realHomedir
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
}
