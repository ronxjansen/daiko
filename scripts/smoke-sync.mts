// Smoke test: sync must never overwrite a local edit the store has not recorded. Run: npm test
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/index.js'
import { addProject, syncProject } from '../src/core/store.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-sync-'))
const repo = path.join(tmp, 'repo')
const skill = path.join(repo, '.claude', 'skills', 'demo', 'SKILL.md')
const mcp = path.join(repo, '.mcp.json')
const writeSkill = (body: string) => fs.writeFileSync(skill, body)

fs.mkdirSync(path.dirname(skill), { recursive: true })
writeSkill('---\nname: demo\ndescription: v1\n---\n\nv1 body\n')
fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { demo: { command: 'demo', args: ['--v1'] } } }, null, 2) + '\n')

const db = openDb(path.join(tmp, 'daiko.sqlite'))

try {
  await addProject(db, repo)

  // 1. Disk already matches the store: nothing written, nothing skipped.
  const clean = await syncProject(db, repo)
  assert.deepStrictEqual(clean, { written: [], removed: [], skipped: [] })

  // 2. A local edit that was never added must survive a sync and be reported.
  const localEdit = '---\nname: demo\ndescription: v1\n---\n\nlocal edit not yet added\n'
  writeSkill(localEdit)
  const conflicted = await syncProject(db, repo)
  assert.strictEqual(fs.readFileSync(skill, 'utf8'), localEdit, 'sync clobbered an unuploaded local edit')
  assert.deepStrictEqual(conflicted.written, [])
  assert.deepStrictEqual(
    conflicted.skipped.map((s) => [s.relPath, s.reason]),
    [[path.join('.claude', 'skills', 'demo', 'SKILL.md'), 'local-edit']],
  )

  // 3. Same edit under force: overwritten with the stored version.
  const forced = await syncProject(db, repo, { force: true })
  assert.deepStrictEqual(forced.skipped, [])
  assert.strictEqual(forced.written.length, 1)
  assert.ok(fs.readFileSync(skill, 'utf8').includes('v1 body'), 'force did not restore the stored version')

  // 4. Reverting to an older recorded version is not a conflict: the store has seen that content.
  writeSkill(localEdit)
  await addProject(db, repo) // upload the local edit as v2
  writeSkill('---\nname: demo\ndescription: v1\n---\n\nv1 body\n') // roll disk back to v1
  const rollForward = await syncProject(db, repo)
  assert.deepStrictEqual(rollForward.skipped, [], 'a known older version was treated as a conflict')
  assert.strictEqual(fs.readFileSync(skill, 'utf8'), localEdit, 'sync did not restore the current version')

  // 5. MCP: an unrecorded edit to a managed server entry is kept, unrelated keys untouched.
  const editedMcp =
    JSON.stringify(
      { note: 'hand written', mcpServers: { demo: { command: 'demo', args: ['--local'] }, other: { command: 'other' } } },
      null,
      2,
    ) + '\n'
  fs.writeFileSync(mcp, editedMcp)
  const mcpSync = await syncProject(db, repo)
  assert.strictEqual(fs.readFileSync(mcp, 'utf8'), editedMcp, 'sync clobbered a locally edited MCP entry')
  assert.deepStrictEqual(
    mcpSync.skipped.map((s) => [s.relPath, s.artifact, s.reason]),
    [['.mcp.json', 'demo', 'local-edit']],
  )

  // 6. MCP under force: the managed entry is restored, unmanaged ones and other keys survive.
  await syncProject(db, repo, { force: true })
  const merged = JSON.parse(fs.readFileSync(mcp, 'utf8'))
  assert.deepStrictEqual(merged.mcpServers.demo, { command: 'demo', args: ['--v1'] })
  assert.deepStrictEqual(merged.mcpServers.other, { command: 'other' })
  assert.strictEqual(merged.note, 'hand written')

  // 7. An unparseable config is never rewritten out from under the user.
  fs.writeFileSync(mcp, '{ not json at all')
  const broken = await syncProject(db, repo)
  assert.strictEqual(fs.readFileSync(mcp, 'utf8'), '{ not json at all', 'sync overwrote an unparseable config')
  assert.deepStrictEqual(
    broken.skipped.map((s) => [s.relPath, s.reason]),
    [['.mcp.json', 'unreadable']],
  )

  console.log('all sync smoke tests passed')
} finally {
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
}
