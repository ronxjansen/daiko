import { describe, expect, it } from 'vitest'
import { groupScanned, type ScannedArtifact } from '../src/core/scan.js'

const skill = (harness: string, content: string, name = 'demo'): ScannedArtifact => ({
  type: 'skill',
  name,
  harness,
  originPath: `.${harness}/skills/${name}/SKILL.md`,
  content,
})

describe('groupScanned', () => {
  it('collapses identical copies across harnesses into one variant with the union of targets', () => {
    const groups = groupScanned([skill('claude', 'same'), skill('codex', 'same')])
    expect(groups).toHaveLength(1)
    expect(groups[0].targets).toEqual(['claude', 'codex'])
    expect(groups[0].variants).toHaveLength(1)
    expect(groups[0].variants[0].harnesses).toEqual(['claude', 'codex'])
    expect(groups[0].variants[0].originPath).toBe('.claude/skills/demo/SKILL.md')
  })

  it('keeps drifted copies as separate variants of the same group', () => {
    const groups = groupScanned([skill('claude', 'v1'), skill('codex', 'v2')])
    expect(groups).toHaveLength(1)
    expect(groups[0].targets).toEqual(['claude', 'codex'])
    expect(groups[0].variants.map((v) => [v.content, v.harnesses])).toEqual([
      ['v1', ['claude']],
      ['v2', ['codex']],
    ])
  })

  it('separates artifacts by type and name', () => {
    const groups = groupScanned([
      skill('claude', 'a', 'one'),
      skill('claude', 'b', 'two'),
      { type: 'mcp_server', name: 'one', harness: 'claude', originPath: '.mcp.json', content: '{}' },
    ])
    expect(groups.map((g) => `${g.type}:${g.name}`).sort()).toEqual(['mcp_server:one', 'skill:one', 'skill:two'])
  })

  it('distinguishes revisions by bundled files, not just content', () => {
    const withFile = { ...skill('claude', 'same'), files: [{ path: 'run.sh', encoding: 'utf8' as const, content: 'x' }] }
    const groups = groupScanned([withFile, skill('codex', 'same')])
    expect(groups[0].variants).toHaveLength(2)
  })

  it('never duplicates a harness in targets or variant harnesses', () => {
    const groups = groupScanned([skill('claude', 'same'), skill('claude', 'same')])
    expect(groups[0].targets).toEqual(['claude'])
    expect(groups[0].variants[0].harnesses).toEqual(['claude'])
  })
})
