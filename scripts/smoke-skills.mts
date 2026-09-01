// Smoke test for multi-file skills: whole skill directories (scripts, references, binary
// assets) are stored, synced, pruned, and protected from clobbering local edits. Run: npm test
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db/index.js'
import { addProject, attachArtifact, parseSkillFiles, setTargets, syncProject } from '../src/core/store.js'
import { scanProject } from '../src/core/scan.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-skills-'))
const source = path.join(tmp, 'source')
const target = path.join(tmp, 'target')
fs.mkdirSync(source, { recursive: true })
fs.mkdirSync(target, { recursive: true })

const write = (root: string, rel: string, content: string | Buffer, mode?: number) => {
  const file = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mode !== undefined) fs.chmodSync(file, mode)
}
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')))
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, ...rel.split('/')))

// A skill with everything a real one ships: subdirectories, an executable script, a binary asset.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
write(source, '.claude/skills/demo/SKILL.md', '---\nname: demo\n---\nBody\n')
write(source, '.claude/skills/demo/scripts/run.sh', '#!/bin/sh\necho hi\n', 0o755)
write(source, '.claude/skills/demo/references/api.md', '# API\n')
write(source, '.claude/skills/demo/assets/logo.png', PNG)
write(source, '.claude/skills/demo/.git/config', 'must not be stored\n')
write(source, '.claude/skills/demo/node_modules/dep/index.js', 'nope\n')
// One skill per harness: every adapter with a skills directory must be scanned.
write(source, '.codex/skills/cx/SKILL.md', 'codex skill\n')
write(source, '.codex/skills/cx/scripts/go.sh', 'echo codex\n', 0o755)
write(source, '.cursor/skills/cu/SKILL.md', 'cursor skill\n')
write(source, '.cursor/skills/cu/refs/note.md', 'cursor note\n')
write(source, '.agents/skills/ag/SKILL.md', 'generic skill\n')
write(source, '.agents/skills/ag/refs/note.md', 'generic note\n')

const db = openDb(path.join(tmp, 'daiko.sqlite'))

try {
  // 1. Scanning: every harness contributes its skills, with sibling files attached.
  const scanned = scanProject(source).filter((a) => a.type === 'skill')
  assert.deepStrictEqual(
    scanned.map((a) => `${a.harness}:${a.name}`).sort(),
    ['claude:demo', 'codex:cx', 'cursor:cu', 'generic:ag'],
    'expected one skill per harness',
  )
  const demo = scanned.find((a) => a.name === 'demo')!
  assert.deepStrictEqual(
    demo.files?.map((f) => f.path),
    ['assets/logo.png', 'references/api.md', 'scripts/run.sh'],
    'bundled files wrong (ignored dirs leaking, or SKILL.md duplicated?)',
  )
  assert.strictEqual(demo.files!.find((f) => f.path === 'scripts/run.sh')!.exec, true, 'exec bit lost')
  assert.strictEqual(demo.files!.find((f) => f.path === 'assets/logo.png')!.encoding, 'base64', 'binary not base64')

  await addProject(db, source)
  const stored = await db.selectFrom('artifacts').selectAll().where('name', '=', 'demo').executeTakeFirstOrThrow()
  const version = await db
    .selectFrom('versions')
    .selectAll()
    .where('id', '=', stored.current_version_id!)
    .executeTakeFirstOrThrow()
  assert.strictEqual(parseSkillFiles(version.files).length, 3, 'files not persisted')

  // 2. Re-adding an unchanged skill must not create a version.
  const again = await addProject(db, source)
  assert.strictEqual(again.updated, 0, `unchanged rescan created versions: ${JSON.stringify(again)}`)

  // 3. Editing a bundled file (not SKILL.md) is a change worth versioning.
  write(source, '.claude/skills/demo/references/api.md', '# API v2\n')
  const edited = await addProject(db, source)
  assert.strictEqual(edited.updated, 1, 'sibling-file edit not versioned')

  // 4. Sharing the skill into another repo materializes the whole directory.
  await addProject(db, target)
  const project = await db.selectFrom('projects').selectAll().where('root_path', '=', target).executeTakeFirstOrThrow()
  const sync = await attachArtifact(db, project.id, stored.id)
  assert.deepStrictEqual(sync.skipped, [], `unexpected skips: ${JSON.stringify(sync.skipped)}`)
  assert.ok(
    sync.written.includes('.claude/skills/demo/scripts/run.sh'),
    `bundled files not reported as synced: ${JSON.stringify(sync.written)}`,
  )
  assert.strictEqual(read(target, '.claude/skills/demo/references/api.md').toString(), '# API v2\n')
  assert.ok(read(target, '.claude/skills/demo/assets/logo.png').equals(PNG), 'binary asset corrupted')
  const mode = fs.statSync(path.join(target, '.claude/skills/demo/scripts/run.sh')).mode
  assert.ok((mode & 0o111) !== 0, 'synced script is not executable')
  assert.ok(!exists(target, '.claude/skills/demo/.git'), '.git leaked into the store')

  // 5. Idempotent: a second sync writes nothing.
  const resync = await syncProject(db, target)
  assert.deepStrictEqual(resync.written, [], `re-sync rewrote files: ${JSON.stringify(resync.written)}`)

  // 6. A file deleted upstream is pruned downstream (and its empty dir with it).
  fs.rmSync(path.join(source, '.claude/skills/demo/references/api.md'))
  await addProject(db, source)
  const pruned = await syncProject(db, target)
  assert.deepStrictEqual(pruned.removed, ['.claude/skills/demo/references/api.md'], 'upstream deletion not pruned')
  assert.ok(!exists(target, '.claude/skills/demo/references'), 'empty directory left behind')

  // 7. Local additions and local edits are never clobbered by an automatic sync.
  write(target, '.claude/skills/demo/scripts/local-only.sh', 'mine\n')
  write(target, '.claude/skills/demo/scripts/run.sh', '#!/bin/sh\necho edited locally\n')
  write(source, '.claude/skills/demo/scripts/run.sh', '#!/bin/sh\necho upstream v2\n', 0o755)
  await addProject(db, source)
  const guarded = await syncProject(db, target)
  assert.deepStrictEqual(
    guarded.skipped.map((s) => s.relPath),
    ['.claude/skills/demo/scripts/run.sh'],
    `local edit not protected: ${JSON.stringify(guarded)}`,
  )
  assert.strictEqual(read(target, '.claude/skills/demo/scripts/run.sh').toString(), '#!/bin/sh\necho edited locally\n')
  assert.ok(exists(target, '.claude/skills/demo/scripts/local-only.sh'), 'local-only file was deleted')

  // 8. force overwrites the local edit, still leaving the untracked local file alone.
  const forced = await syncProject(db, target, { force: true })
  assert.ok(forced.written.includes('.claude/skills/demo/scripts/run.sh'), 'force did not overwrite')
  assert.strictEqual(read(target, '.claude/skills/demo/scripts/run.sh').toString(), '#!/bin/sh\necho upstream v2\n')
  assert.ok(exists(target, '.claude/skills/demo/scripts/local-only.sh'), 'force deleted an untracked local file')

  // 9. One canonical skill, several harnesses: the whole bundle lands in every target's
  // layout, not just SKILL.md, and each copy carries the exec bit and the binary asset.
  await setTargets(db, stored.id, ['claude', 'codex', 'generic'])
  const fanned = await syncProject(db, target, { force: true })
  for (const dir of ['.codex/skills/demo', '.agents/skills/demo']) {
    assert.ok(
      fanned.written.includes(`${dir}/SKILL.md`),
      `${dir} not deployed: ${JSON.stringify(fanned.written)}`,
    )
    assert.strictEqual(read(target, `${dir}/scripts/run.sh`).toString(), '#!/bin/sh\necho upstream v2\n')
    assert.ok(read(target, `${dir}/assets/logo.png`).equals(PNG), `${dir} binary asset corrupted`)
    assert.ok((fs.statSync(path.join(target, ...`${dir}/scripts/run.sh`.split('/'))).mode & 0o111) !== 0, `${dir} script not executable`)
  }

  console.log('all skill bundle smoke tests passed')
} finally {
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
}
