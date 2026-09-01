import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClaudeTranscript } from '../src/core/harnesses/claude.js'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daiko-claude-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const writeTranscript = (name: string, entries: unknown[]): string => {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n')
  return file
}

const usage = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 }

describe('parseClaudeTranscript', () => {
  it('parses a session with messages, title, timestamps, and project path', () => {
    const file = writeTranscript('abc-123.jsonl', [
      { type: 'user', cwd: '/home/ron/proj', timestamp: '2026-01-01T10:00:00Z', message: { content: 'hi' } },
      {
        type: 'assistant',
        timestamp: '2026-01-01T10:00:05Z',
        message: {
          id: 'msg_1',
          model: 'claude-opus-5',
          usage,
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-01-01T10:00:07Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file.txt' }] }] },
      },
      { type: 'ai-title', title: 'Listing files' },
      'not json at all',
    ])

    const parsed = parseClaudeTranscript(file)!
    expect(parsed.externalId).toBe('abc-123') // filename, not any embedded session id
    expect(parsed.projectPath).toBe('/home/ron/proj')
    expect(parsed.title).toBe('Listing files')
    expect(parsed.startedAt).toBe('2026-01-01T10:00:00Z')
    expect(parsed.endedAt).toBe('2026-01-01T10:00:07Z')
    expect(parsed.messages.map((m) => [m.role, m.kind])).toEqual([
      ['user', 'text'],
      ['assistant', 'thinking'],
      ['assistant', 'text'],
      ['assistant', 'tool_use'],
      ['tool', 'tool_result'],
    ])
    expect(parsed.messages[3].toolName).toBe('Bash')
    expect(parsed.messages[4].content).toBe('file.txt')
  })

  it('attaches usage to exactly one message per API response', () => {
    const file = writeTranscript('s.jsonl', [
      // One response streamed as two JSONL lines sharing message.id — usage must count once.
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'b' }] } },
      // A response with multiple blocks in one line — usage on the first block only.
      {
        type: 'assistant',
        message: {
          id: 'msg_2',
          usage: { input_tokens: 50, output_tokens: 7 },
          content: [
            { type: 'thinking', thinking: 't' },
            { type: 'text', text: 'c' },
          ],
        },
      },
    ])

    const withUsage = parseClaudeTranscript(file)!.messages.filter((m) => m.usage)
    expect(withUsage).toHaveLength(2)
    expect(withUsage[0].usage).toEqual({ input: 100, output: 5, cacheRead: 20, cacheWrite: 10 })
    expect(withUsage[1].usage).toEqual({ input: 50, output: 7, cacheRead: 0, cacheWrite: 0 })
  })

  it('drops the synthetic model marker', () => {
    const file = writeTranscript('s.jsonl', [
      { type: 'assistant', message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: 'x' }] } },
    ])
    expect(parseClaudeTranscript(file)!.messages[0].model).toBeNull()
  })

  it('returns null for empty or metadata-only transcripts', () => {
    expect(parseClaudeTranscript(writeTranscript('empty.jsonl', []))).toBeNull()
    expect(parseClaudeTranscript(writeTranscript('meta.jsonl', [{ type: 'file-history-snapshot' }]))).toBeNull()
  })
})
