import { describe, expect, it } from 'vitest'
import { harnessesSupporting, renderPath, renderPaths, supportMatrix } from '../src/core/render.js'

describe('renderPath', () => {
  it('projects each artifact type into a harness layout', () => {
    expect(renderPath('claude', { type: 'skill', name: 'demo' })).toBe('.claude/skills/demo/SKILL.md')
    expect(renderPath('claude', { type: 'agent_md', name: 'instructions' })).toBe('CLAUDE.md')
    expect(renderPath('claude', { type: 'mcp_server', name: 'srv' })).toBe('.mcp.json')
  })

  it('returns null when the harness has no location for the type', () => {
    expect(renderPath('gemini', { type: 'skill', name: 'demo' })).toBeNull() // no skills dir
    expect(renderPath('codex', { type: 'mcp_server', name: 'srv' })).toBeNull() // no project MCP config
  })

  it('returns null for unknown harnesses', () => {
    expect(renderPath('nope', { type: 'agent_md', name: 'instructions' })).toBeNull()
  })
})

describe('renderPaths', () => {
  it('renders one entry per target harness that can host the artifact', () => {
    const paths = renderPaths({ type: 'skill', name: 'demo' }, ['claude', 'codex'])
    expect(paths).toEqual([
      { harness: 'claude', relPath: '.claude/skills/demo/SKILL.md' },
      { harness: 'codex', relPath: '.codex/skills/demo/SKILL.md' },
    ])
  })

  it('dedupes shared paths, attributing them to the first target in registry order', () => {
    // codex, opencode and goose all read AGENTS.md; one file serves all three.
    const paths = renderPaths({ type: 'agent_md', name: 'instructions' }, ['opencode', 'goose', 'codex'])
    expect(paths).toEqual([{ harness: 'codex', relPath: 'AGENTS.md' }])
  })

  it('orders output by registry, not by the order targets were given', () => {
    const paths = renderPaths({ type: 'skill', name: 'demo' }, ['codex', 'claude'])
    expect(paths.map((p) => p.harness)).toEqual(['claude', 'codex'])
  })

  it('drops targets that cannot host the type', () => {
    expect(renderPaths({ type: 'skill', name: 'demo' }, ['gemini'])).toEqual([])
  })
})

describe('support matrix', () => {
  it('derives support from layouts', () => {
    expect(harnessesSupporting('mcp_server')).toContain('claude')
    expect(harnessesSupporting('mcp_server')).not.toContain('codex')
    expect(harnessesSupporting('skill')).toContain('codex')
    expect(harnessesSupporting('skill')).not.toContain('gemini')
    expect(harnessesSupporting('agent_md')).toContain('gemini')
  })

  it('serves every artifact type', () => {
    const matrix = supportMatrix()
    expect(Object.keys(matrix).sort()).toEqual(['agent_md', 'mcp_server', 'skill'])
    for (const harnesses of Object.values(matrix)) expect(harnesses.length).toBeGreaterThan(0)
  })
})
