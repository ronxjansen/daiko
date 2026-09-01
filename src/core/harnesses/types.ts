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

/**
 * One file bundled with a skill, path relative to the skill's own directory
 * ("scripts/run.sh", "references/api.md"). SKILL.md itself is kept in the
 * artifact's `content`, so single-file skills are stored exactly as before.
 * Non-UTF-8 files (images, archives) are stored base64-encoded.
 */
export interface SkillFile {
  path: string
  encoding: 'utf8' | 'base64'
  content: string
  /** Executable bit on disk, restored on sync so bundled scripts stay runnable. */
  exec?: boolean
}

/** The canonical name every agent-instruction file maps to, whatever a harness calls it on disk. */
export const INSTRUCTIONS_NAME = 'instructions'

/**
 * One artifact as read off disk. `harness` and `originPath` record *where it was found*;
 * they are provenance, not a destination. Where it gets written is decided by the
 * artifact's target harnesses and their layouts (see src/core/render.ts), so the same
 * scanned skill can land in .claude/skills, .codex/skills and .agents/skills at once.
 */
export interface ScannedArtifact {
  type: ArtifactType
  /** Canonical name: the skill's directory name, the MCP server's key, or INSTRUCTIONS_NAME. */
  name: string
  /** Harness whose config this was read from. */
  harness: string
  /** Where it was read from: project-relative, or ~-prefixed for a harness-global config. */
  originPath: string
  content: string
  /** Sibling files of a skill (scripts, references, assets); undefined for other types. */
  files?: SkillFile[]
}

/**
 * Where one harness keeps project-level configuration. This single declaration drives both
 * directions: scanning reads these locations, and sync renders canonical artifacts back into
 * them. A harness that omits a field simply cannot host that artifact type — sync says so
 * rather than writing another harness's file.
 */
export interface HarnessLayout {
  /** Instruction file at the project root, e.g. 'CLAUDE.md'. Also the write target. */
  agentFile?: string
  /** Older/alternate instruction filenames read on scan but never written back. */
  agentFileAliases?: string[]
  /** Directory holding one sub-directory per skill, e.g. '.claude/skills'. */
  skillsDir?: string
  /** JSON config with a top-level mcpServers map, e.g. '.mcp.json'. */
  mcpConfig?: string
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
  /** Stable id stored in the DB (sessions.harness, artifacts.origin_harness, artifact_targets.harness) and used in CLI/API filters. */
  id: string
  /** Human-readable name shown in the CLI and web UI. */
  label: string
  /** Where this harness keeps project config. Drives scanning and rendering alike; omit for session-only harnesses. */
  layout?: HarnessLayout
  /** Absolute paths of session transcript files in this harness's local store. */
  discoverSessionFiles?(home: string): string[]
  /** Parse one transcript file into the normalized shape; null = empty or metadata-only. */
  parseSession?(file: string): ParsedSession | null
  /** Project artifacts beyond the declared layout (e.g. Claude's local-scope MCP servers in ~/.claude.json). */
  scanExtraProjectArtifacts?(root: string): ScannedArtifact[]
  /** MCP servers from harness-wide configs (stored globally, available to every project). */
  scanGlobalArtifacts?(home: string): ScannedArtifact[]
  /** Remove a globally registered MCP server from this harness's global config file. */
  removeGlobalMcpServer?(home: string, name: string): GlobalRemoveResult
}
