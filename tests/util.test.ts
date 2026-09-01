import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectSkillFiles,
  flattenContent,
  MAX_SKILL_FILE_BYTES,
  readJsonl,
  removeMcpServerFromJsonFile,
  writeFileAtomic,
} from '../src/core/harnesses/util.js'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-util-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('collectSkillFiles', () => {
  it('collects everything but SKILL.md, sorted, with encodings and exec bits', () => {
    fs.writeFileSync(path.join(tmp, 'SKILL.md'), 'the skill itself')
    fs.mkdirSync(path.join(tmp, 'scripts'))
    fs.writeFileSync(path.join(tmp, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
    fs.writeFileSync(path.join(tmp, 'zeta.md'), 'notes')
    fs.writeFileSync(path.join(tmp, 'logo.bin'), Buffer.from([0x89, 0x00, 0x01]))

    const files = collectSkillFiles(tmp)
    expect(files.map((f) => f.path)).toEqual(['logo.bin', 'scripts/run.sh', 'zeta.md'])
    expect(files.find((f) => f.path === 'logo.bin')).toMatchObject({
      encoding: 'base64',
      content: Buffer.from([0x89, 0x00, 0x01]).toString('base64'),
    })
    expect(files.find((f) => f.path === 'scripts/run.sh')?.exec).toBe(true)
    expect(files.find((f) => f.path === 'zeta.md')?.exec).toBeUndefined()
  })

  it('skips ignored dirs, symlinks, and oversized files', () => {
    fs.mkdirSync(path.join(tmp, 'node_modules'))
    fs.writeFileSync(path.join(tmp, 'node_modules', 'dep.js'), 'x')
    fs.writeFileSync(path.join(tmp, 'keep.md'), 'x')
    fs.symlinkSync(path.join(tmp, 'keep.md'), path.join(tmp, 'link.md'))
    fs.writeFileSync(path.join(tmp, 'huge.txt'), Buffer.alloc(MAX_SKILL_FILE_BYTES + 1))

    expect(collectSkillFiles(tmp).map((f) => f.path)).toEqual(['keep.md'])
  })

  it('returns an empty bundle for a missing directory', () => {
    expect(collectSkillFiles(path.join(tmp, 'nope'))).toEqual([])
  })
})

describe('removeMcpServerFromJsonFile', () => {
  it('removes the entry and preserves every other key', () => {
    const file = path.join(tmp, 'claude.json')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } }, theme: 'dark' }))
    expect(removeMcpServerFromJsonFile(file, 'a')).toEqual({ status: 'removed', file })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpServers: { b: { command: 'b' } }, theme: 'dark' })
  })

  it('reports absent for a missing entry or missing file', () => {
    const file = path.join(tmp, 'claude.json')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }))
    expect(removeMcpServerFromJsonFile(file, 'a').status).toBe('absent')
    expect(removeMcpServerFromJsonFile(path.join(tmp, 'nope.json'), 'a').status).toBe('absent')
  })

  it('refuses to touch a file that does not parse', () => {
    const file = path.join(tmp, 'broken.json')
    fs.writeFileSync(file, '{not json')
    const result = removeMcpServerFromJsonFile(file, 'a')
    expect(result.status).toBe('failed')
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json')
  })
})

describe('writeFileAtomic', () => {
  it('creates parent directories and leaves no temp files behind', () => {
    const target = path.join(tmp, 'a', 'b', 'file.txt')
    writeFileAtomic(target, 'hello')
    expect(fs.readFileSync(target, 'utf8')).toBe('hello')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['file.txt'])
  })
})

describe('flattenContent', () => {
  it('flattens strings, block arrays, and unknown shapes', () => {
    expect(flattenContent('plain')).toBe('plain')
    expect(flattenContent([{ type: 'text', text: 'a' }, 'b'])).toBe('a\nb')
    expect(flattenContent([{ type: 'image', source: 'x' }])).toBe('{"type":"image","source":"x"}')
    expect(flattenContent(null)).toBe('')
    expect(flattenContent(42)).toBe('42')
  })
})

describe('readJsonl', () => {
  it('skips blank and malformed lines', () => {
    const file = path.join(tmp, 'log.jsonl')
    fs.writeFileSync(file, '{"a":1}\n\nnot json\n{"b":2}\n')
    expect(readJsonl(file)).toEqual([{ a: 1 }, { b: 2 }])
  })
})
