// Multi-file skill lifecycle: whole skill directories (scripts, references, binary assets)
// are stored, synced, pruned, and protected from clobbering local edits. Ported from
// scripts/smoke-skills.mts; steps build on each other, so they run in order.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from '../src/db/schema.js'
import { openDb } from '../src/db/index.js'
import { addProject, attachArtifact, parseSkillFiles, setTargets, syncProject } from '../src/core/store.js'
import { scanProject } from '../src/core/scan.js'

let tmp: string
let source: string
let target: string
let db: Kysely<DB>
let storedId: string

const write = (root: string, rel: string, content: string | Buffer, mode?: number) => {
  const file = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mode !== undefined) fs.chmodSync(file, mode)
}
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')))
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, ...rel.split('/')))

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-bundles-'))
  source = path.join(tmp, 'source')
  target = path.join(tmp, 'target')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(target, { recursive: true })

  // A skill with everything a real one ships: subdirectories, an executable script, a binary asset.
  write(source, '.claude/skills/demo/SKILL.md', '---\nname: demo\n---\nBody\n')
  write(source, '.claude/skills/demo/scripts/run.sh', '#!/bin/sh\necho hi\n', 0o755)
  write(source, '.claude/skills/demo/references/api.md', '# API\n')
  write(source, '.claude/skills/demo/assets/logo.png', PNG)
  write(source, '.claude/skills/demo/.git/config', 'must not be stored\n')
  write(source, '.claude/skills/demo/node_modules/dep/index.js', 'nope\n')
  // One skill per harness: every adapter with a skills directory must be scanned.
  write(source, '.codex/skills/cx/SKILL.md', 'codex skill\n')
  write(source, '.cursor/skills/cu/SKILL.md', 'cursor skill\n')
  write(source, '.agents/skills/ag/SKILL.md', 'generic skill\n')

  db = openDb(path.join(tmp, 'daiko.sqlite'))
})
afterAll(async () => {
  await db.destroy()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('skill bundle lifecycle', () => {
  it('scans every harness skills dir, attaching sibling files with exec bits and encodings', async () => {
    // Goose shares the .agents/skills location with Generic, so 'ag' scans under both.
    const scanned = scanProject(source).filter((a) => a.type === 'skill')
    expect(scanned.map((a) => `${a.harness}:${a.name}`).sort()).toEqual([
      'claude:demo',
      'codex:cx',
      'cursor:cu',
      'generic:ag',
      'goose:ag',
    ])
    const demo = scanned.find((a) => a.name === 'demo')!
    expect(demo.files?.map((f) => f.path)).toEqual(['assets/logo.png', 'references/api.md', 'scripts/run.sh'])
    expect(demo.files!.find((f) => f.path === 'scripts/run.sh')!.exec).toBe(true)
    expect(demo.files!.find((f) => f.path === 'assets/logo.png')!.encoding).toBe('base64')

    await addProject(db, source)
    const stored = await db.selectFrom('artifacts').selectAll().where('name', '=', 'demo').executeTakeFirstOrThrow()
    storedId = stored.id
    const version = await db.selectFrom('versions').selectAll().where('id', '=', stored.current_version_id!).executeTakeFirstOrThrow()
    expect(parseSkillFiles(version.files)).toHaveLength(3)
  })

  it('does not create a version on an unchanged rescan, but versions a sibling-file edit', async () => {
    expect((await addProject(db, source)).updated).toBe(0)
    write(source, '.claude/skills/demo/references/api.md', '# API v2\n')
    expect((await addProject(db, source)).updated).toBe(1)
  })

  it('materializes the whole directory when shared into another repo, bit-exact', async () => {
    await addProject(db, target)
    const project = await db.selectFrom('projects').selectAll().where('root_path', '=', target).executeTakeFirstOrThrow()
    const sync = await attachArtifact(db, project.id, storedId)
    expect(sync.skipped).toEqual([])
    expect(sync.written).toContain('.claude/skills/demo/scripts/run.sh')
    expect(read(target, '.claude/skills/demo/references/api.md').toString()).toBe('# API v2\n')
    expect(read(target, '.claude/skills/demo/assets/logo.png').equals(PNG)).toBe(true)
    expect(fs.statSync(path.join(target, '.claude/skills/demo/scripts/run.sh')).mode & 0o111).not.toBe(0)
    expect(exists(target, '.claude/skills/demo/.git')).toBe(false)

    // Idempotent: a second sync writes nothing.
    expect((await syncProject(db, target)).written).toEqual([])
  })

  it('prunes a file deleted upstream, and its empty directory with it', async () => {
    fs.rmSync(path.join(source, '.claude/skills/demo/references/api.md'))
    await addProject(db, source)
    const pruned = await syncProject(db, target)
    expect(pruned.removed).toEqual(['.claude/skills/demo/references/api.md'])
    expect(exists(target, '.claude/skills/demo/references')).toBe(false)
  })

  it('never clobbers local additions or edits on an automatic sync; force overwrites edits only', async () => {
    write(target, '.claude/skills/demo/scripts/local-only.sh', 'mine\n')
    write(target, '.claude/skills/demo/scripts/run.sh', '#!/bin/sh\necho edited locally\n')
    write(source, '.claude/skills/demo/scripts/run.sh', '#!/bin/sh\necho upstream v2\n', 0o755)
    await addProject(db, source)

    const guarded = await syncProject(db, target)
    expect(guarded.skipped.map((s) => s.relPath)).toEqual(['.claude/skills/demo/scripts/run.sh'])
    expect(read(target, '.claude/skills/demo/scripts/run.sh').toString()).toBe('#!/bin/sh\necho edited locally\n')
    expect(exists(target, '.claude/skills/demo/scripts/local-only.sh')).toBe(true)

    const forced = await syncProject(db, target, { force: true })
    expect(forced.written).toContain('.claude/skills/demo/scripts/run.sh')
    expect(read(target, '.claude/skills/demo/scripts/run.sh').toString()).toBe('#!/bin/sh\necho upstream v2\n')
    expect(exists(target, '.claude/skills/demo/scripts/local-only.sh')).toBe(true)
  })

  it('fans the whole bundle out to every target layout, not just SKILL.md', async () => {
    await setTargets(db, storedId, ['claude', 'codex', 'generic'])
    const fanned = await syncProject(db, target, { force: true })
    for (const dir of ['.codex/skills/demo', '.agents/skills/demo']) {
      expect(fanned.written).toContain(`${dir}/SKILL.md`)
      expect(read(target, `${dir}/scripts/run.sh`).toString()).toBe('#!/bin/sh\necho upstream v2\n')
      expect(read(target, `${dir}/assets/logo.png`).equals(PNG)).toBe(true)
      expect(fs.statSync(path.join(target, ...`${dir}/scripts/run.sh`.split('/'))).mode & 0o111).not.toBe(0)
    }
  })
})
