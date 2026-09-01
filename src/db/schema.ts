export type ArtifactType = 'skill' | 'mcp_server' | 'agent_md'
/** Harness id from the registry in src/core/harnesses; stored as plain TEXT so new harnesses need no migration. */
export type Harness = string

export interface ProjectsTable {
  id: string
  name: string
  root_path: string
  created_at: string
  updated_at: string
}

/**
 * A canonical artifact: one logical skill, instruction document, or MCP server, identified
 * by (project_id, type, name) alone. It carries no harness and no path — where it lands on
 * disk is decided by its rows in artifact_targets and those harnesses' layouts, so the same
 * artifact renders into .claude/skills, .codex/skills and .agents/skills at once.
 */
export interface ArtifactsTable {
  id: string
  /** null = global artifact (e.g. an MCP server from a harness-wide config), available to all projects */
  project_id: string | null
  type: ArtifactType
  name: string
  /** Provenance only: the harness this was first scanned from. Never decides where it is written. */
  origin_harness: Harness
  /** Provenance only: where it was first read (project-relative, or ~-prefixed for a harness-global config). */
  origin_path: string
  current_version_id: string | null
  pinned_version_id: string | null
  created_at: string
  updated_at: string
}

/**
 * A harness an artifact should be rendered into. Deployment lives here rather than on the
 * artifact, so one canonical object can serve many harness formats; the set only grows by
 * scanning (a copy found in another harness) or by an explicit choice.
 */
export interface ArtifactTargetsTable {
  artifact_id: string
  harness: Harness
  created_at: string
}

export interface VersionsTable {
  id: string
  artifact_id: string
  /** Hash of `content` alone — the artifact's own file, not the bundle (see store.versionArtifact). */
  hash: string
  content: string
  /** JSON SkillFile[]: a skill's scripts/references/assets. null for skills that are just SKILL.md, and for every other type. */
  files: string | null
  source: string
  created_at: string
}

/** A skill/MCP server/agent file shared into a project beyond the one it was scanned from. */
export interface ProjectArtifactsTable {
  project_id: string
  artifact_id: string
  created_at: string
}

/** Harness id from the registry in src/core/harnesses; stored as plain TEXT so new harnesses need no migration. */
export type SessionHarness = string
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'
export type MessageKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'system'

export interface SessionsTable {
  id: string
  harness: SessionHarness
  external_id: string
  source_path: string
  project_path: string | null
  title: string | null
  started_at: string | null
  ended_at: string | null
  message_count: number
  source_size: number
  source_mtime_ms: number
  /** Primary model of the session (last non-synthetic model seen); null when the transcript doesn't record one. */
  model: string | null
  /** Session token totals; input_tokens is the non-cached share (see TokenUsage). All null = harness reported no usage. */
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  created_at: string
  updated_at: string
}

export interface MessagesTable {
  id: string
  session_id: string
  seq: number
  role: MessageRole
  kind: MessageKind
  content: string | null
  tool_name: string | null
  tool_use_id: string | null
  timestamp: string | null
  model: string | null
  /** Tokens of the API request that produced this message; set on one message per request, null elsewhere. */
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
}

export interface DB {
  projects: ProjectsTable
  artifacts: ArtifactsTable
  artifact_targets: ArtifactTargetsTable
  versions: VersionsTable
  project_artifacts: ProjectArtifactsTable
  sessions: SessionsTable
  messages: MessagesTable
}
