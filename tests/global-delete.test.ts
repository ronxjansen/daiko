// Global MCP server deletion across harness config formats (claude/cursor JSON, codex TOML),
// including project-tree cleanup and no-resurrection guarantees. Ported from
// scripts/smoke-delete.mts; steps build on each other, so they run in order.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from '../src/db/schema.js'
import { openDb } from '../src/db/index.js'
import { addGlobalMcpServers, addProject, attachArtifact, deleteArtifact, syncProject } from '../src/core/store.js'
import { scanGlobalMcpServers } from '../src/core/scan.js'

let tmp: string
let home: string
let repo: string
let db: Kysely<DB>

const byName = (name: string) => db.selectFrom('artifacts').selectAll().where('name', '=', name).executeTakeFirstOrThrow()

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-delete-'))
  home = path.join(tmp, 'home')
  repo = path.join(tmp, 'repo')
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
          // Registered with two harnesses: one canonical artifact, two files to clean up.
          shared: { command: 'shared' },
        },
      },
      null,
      2,
    ),
  )
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.cursor', 'mcp.json'),
    JSON.stringify(
      { mcpServers: { cursorkeep: { url: 'http://a' }, cursorgone: { url: 'http://b' }, shared: { command: 'shared' } } },
      null,
      2,
    ),
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

  // Scan/delete use os.homedir(); point it at the fake home.
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  db = openDb(path.join(tmp, 'daiko.sqlite'))
})
afterAll(async () => {
  vi.restoreAllMocks()
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('global MCP server deletion', () => {
  it('scans harness-global configs into canonical artifacts (same-named servers merge)', async () => {
    await addProject(db, repo)
    const globals = await addGlobalMcpServers(db)
    // 7, not 8: "shared" is registered with two harnesses but is one canonical artifact.
    expect(globals.added).toBe(7)
    const sharedRows = await db.selectFrom('artifacts').selectAll().where('name', '=', 'shared').execute()
    expect(sharedRows).toHaveLength(1)
  })

  it('deletes a claude global server from ~/.claude.json AND attached project trees', async () => {
    const project = await db.selectFrom('projects').selectAll().executeTakeFirstOrThrow()
    await attachArtifact(db, project.id, (await byName('deleteme')).id)
    await syncProject(db, repo)
    expect(JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8')).mcpServers.deleteme).toBeTruthy()

    const summary = await deleteArtifact(db, (await byName('deleteme')).id, home)
    expect(summary.globals.filter((g) => g.status === 'removed').map((g) => path.basename(g.file))).toEqual(['.claude.json'])
    const claudeCfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))
    expect(claudeCfg.mcpServers).not.toHaveProperty('deleteme')
    expect(claudeCfg.mcpServers).toHaveProperty('keepme')
    expect(claudeCfg.numStartups).toBe(42) // unrelated state untouched
    expect(claudeCfg.projects).toEqual({ '/somewhere': { allowedTools: [] } })
    expect(JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8')).mcpServers).not.toHaveProperty('deleteme')
    expect(summary.detached).toEqual([{ project: path.basename(repo), removed: ['.mcp.json'] }])

    // No resurrection: a rescan of global configs must not find it again.
    expect(scanGlobalMcpServers(home).map((s) => s.name)).not.toContain('deleteme')
  })

  it('deletes a cursor global server from ~/.cursor/mcp.json', async () => {
    await deleteArtifact(db, (await byName('cursorgone')).id, home)
    const cursorCfg = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
    expect(Object.keys(cursorCfg.mcpServers)).toEqual(['cursorkeep', 'shared'])
  })

  it('deletes a codex TOML server, keeping comments and other sections', async () => {
    await deleteArtifact(db, (await byName('tomlgone')).id, home)
    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')
    expect(toml).not.toContain('tomlgone')
    expect(toml).toContain('[mcp_servers.tomlkeep]')
    expect(toml).toContain('# my codex config') // comments survive (no fallback rewrite)
    expect(toml).toContain('[other_section]')
    expect(toml).toContain('foo = "bar"')
    const rescanned = scanGlobalMcpServers(home).map((s) => s.name)
    expect(rescanned).toContain('tomlkeep')
    expect(rescanned).not.toContain('tomlgone')
  })

  it('clears every harness config for a server registered with two harnesses', async () => {
    const shared = await byName('shared')
    const summary = await deleteArtifact(db, shared.id, home)
    expect(
      summary.globals.filter((g) => g.status === 'removed').map((g) => path.basename(g.file)).sort(),
    ).toEqual(['.claude.json', 'mcp.json'])
    expect(scanGlobalMcpServers(home).some((s) => s.name === 'shared')).toBe(false)
  })

  it('aborts on an unparseable config, leaving the DB row and the file untouched', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{ this is not json')
    const keep = await byName('keepme')
    await expect(deleteArtifact(db, keep.id, home)).rejects.toThrow(/not deleted.*invalid JSON/s)
    expect(await db.selectFrom('artifacts').select('id').where('name', '=', 'keepme').executeTakeFirst()).toBeTruthy()
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{ this is not json')
  })

  it('proceeds with status absent when the entry was already removed by hand', async () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
    const summary = await deleteArtifact(db, (await byName('keepme')).id, home)
    expect(summary.globals.length).toBeGreaterThan(0)
    expect(summary.globals.every((g) => g.status === 'absent')).toBe(true)
  })
})
