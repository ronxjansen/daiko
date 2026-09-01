import type { ArtifactType, MessageKind, MessageRole } from '../../db/schema.js'

/**
 * Normalized token counts for one API request (or one whole session).
 * `input` is always the NON-cached share of the prompt: harnesses whose raw
 * counts fold cached tokens into the input figure (Codex, Gemini) subtract
 * them during parsing, so cost is uniformly
 * input·rate + cacheRead·readRate + cacheWrite·writeRate + output·outRate.
 */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ParsedMessage {
  role: MessageRole
  kind: MessageKind
  content: string | null
  toolName: string | null
  toolUseId: string | null
  timestamp: string | null
  /** Model that produced this message, when the transcript records it. */
  model?: string | null
  /** Tokens for the API request that produced this message; set on at most one message per request. */
  usage?: TokenUsage | null
}

export interface ParsedSession {
  harness: string
  externalId: string
  sourcePath: string
  projectPath: string | null
  title: string | null
  startedAt: string | null
  endedAt: string | null
  messages: ParsedMessage[]
  /** Session-wide model/usage for harnesses that only report per-session totals (Codex); otherwise derived from messages. */
  model?: string | null
  usage?: TokenUsage | null
}

export interface ScannedArtifact {
  type: ArtifactType
  name: string
  relPath: string
  harness: string
  content: string
}

/**
 * Outcome of removing an entry from a harness-global config file.
 * 'absent' means the entry (or the file) was already gone — safe to proceed.
 * 'failed' means the file exists but could not be edited safely (e.g. invalid
 * JSON/TOML); callers must not pretend the entry is gone.
 */
export interface GlobalRemoveResult {
  status: 'removed' | 'absent' | 'failed'
  file: string
  reason?: string
}

/**
 * One coding harness (Claude Code, Codex, Cursor, ...). All harness-specific knowledge —
 * where session transcripts and config files live and how to parse them — belongs in an
 * adapter; core scan/import/sync logic only ever iterates the registry. Every capability
 * is optional: a harness can contribute sessions, artifacts, or both.
 */
export interface HarnessAdapter {
  /** Stable id stored in the DB (sessions.harness, artifacts.harness) and used in CLI/API filters. */
  id: string
  /** Human-readable name shown in the CLI and web UI. */
  label: string
  /** Absolute paths of session transcript files in this harness's local store. */
  discoverSessionFiles?(home: string): string[]
  /** Parse one transcript file into the normalized shape; null = empty or metadata-only. */
  parseSession?(file: string): ParsedSession | null
  /** Agent files, skills, and MCP servers found under a project root. */
  scanProjectArtifacts?(root: string): ScannedArtifact[]
  /** MCP servers from harness-wide configs (stored globally, available to every project). */
  scanGlobalArtifacts?(home: string): ScannedArtifact[]
  /** Remove a globally registered MCP server from this harness's global config file. */
  removeGlobalMcpServer?(home: string, name: string): GlobalRemoveResult
  /** Project config file that a global-origin MCP server is written to on sync. */
  projectMcpConfigPath?: string
}
