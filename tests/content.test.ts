import { describe, expect, it } from 'vitest'
import { contentKey, hashOf, parseSkillFiles, serializeSkillFiles } from '../src/core/content.js'
import type { SkillFile } from '../src/core/harnesses/types.js'

const file = (path: string, content = 'x'): SkillFile => ({ path, encoding: 'utf8', content })

describe('hashOf', () => {
  it('is deterministic and content-sensitive', () => {
    expect(hashOf('abc')).toBe(hashOf('abc'))
    expect(hashOf('abc')).not.toBe(hashOf('abd'))
    expect(hashOf('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('serializeSkillFiles / parseSkillFiles', () => {
  it('serializes null/empty bundles to null', () => {
    expect(serializeSkillFiles(null)).toBeNull()
    expect(serializeSkillFiles(undefined)).toBeNull()
    expect(serializeSkillFiles([])).toBeNull()
  })

  it('round-trips a bundle', () => {
    const files = [file('scripts/run.sh', 'echo hi'), file('references/api.md')]
    expect(parseSkillFiles(serializeSkillFiles(files))).toEqual(files)
  })

  it('parses null, malformed JSON, and non-arrays to an empty bundle', () => {
    expect(parseSkillFiles(null)).toEqual([])
    expect(parseSkillFiles('{not json')).toEqual([])
    expect(parseSkillFiles('{"a":1}')).toEqual([])
  })
})

describe('contentKey', () => {
  it('treats identical content + bundle as the same revision', () => {
    expect(contentKey('body', [file('a')])).toBe(contentKey('body', [file('a')]))
  })

  it('treats a missing bundle and an empty bundle as the same revision', () => {
    expect(contentKey('body')).toBe(contentKey('body', []))
    expect(contentKey('body')).toBe(contentKey('body', null))
  })

  it('differs when content or bundle differs', () => {
    expect(contentKey('body')).not.toBe(contentKey('other'))
    expect(contentKey('body', [file('a')])).not.toBe(contentKey('body', [file('b')]))
    expect(contentKey('body', [file('a')])).not.toBe(contentKey('body'))
  })
})
