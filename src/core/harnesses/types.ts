import type { ArtifactType, MessageKind, MessageRole } from '../../db/schema.js'

export interface ParsedMessage {
  role: MessageRole
  kind: MessageKind
  content: string | null
  toolName: string | null
  toolUseId: string | null
  timestamp: string | null
  raw: string
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
}

export interface ScannedArtifact {
  type: ArtifactType
  name: string
  relPath: string
  harness: string
  content: string
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
  /** Project config file that a global-origin MCP server is written to on sync. */
  projectMcpConfigPath?: string
}
