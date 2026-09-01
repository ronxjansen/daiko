export type ArtifactType = 'skill' | 'mcp_server' | 'agent_md'

export interface Stats {
  projects: number
  skills: number
  mcp_servers: number
  agent_files: number
  versions: number
  sessions: number
}

/** Harness id from the server-side registry; the list of known ids comes from /api/harnesses. */
export type SessionHarness = string

export interface HarnessInfo {
  id: string
  label: string
  /** Whether this harness contributes importable sessions. */
  sessions: boolean
  /** Which artifact types this harness can hold in a project tree. */
  hosts: Record<ArtifactType, boolean>
}

/** The registry as served by /api/harnesses, including the support matrix. */
export interface HarnessRegistry {
  harnesses: HarnessInfo[]
  /** Harness ids that can host each artifact type. */
  supports: Record<ArtifactType, string[]>
}

export interface Session {
  id: string
  harness: SessionHarness
  external_id: string
  source_path: string
  project_path: string | null
  title: string | null
  started_at: string | null
  ended_at: string | null
  message_count: number
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  /** Derived server-side; null when the transcript reported no usage / unknown model. */
  total_tokens: number | null
  estimated_cost_usd: number | null
  created_at: string
  updated_at: string
  preview?: string | null
}

export interface SessionMessage {
  id: string
  seq: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'system'
  content: string | null
  tool_name: string | null
  tool_use_id: string | null
  timestamp: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  /** Derived server-side for the API request this message heads; null when untracked. */
  estimated_cost_usd: number | null
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatCost(usd: number): string {
  return usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : '<$0.01'
}

export interface SessionList {
  sessions: Session[]
  total: number
}

export interface SessionDetail extends Session {
  messages: SessionMessage[]
  message_offset: number
  message_limit: number
}

export interface ActivityRow {
  id: string
  source: string
  created_at: string
  artifact_id: string
  artifact_name: string
  type: ArtifactType
  project_name: string | null
}

export interface Project {
  id: string
  name: string
  root_path: string
  created_at: string
  updated_at: string
  artifact_count?: number
}

export interface Artifact {
  id: string
  /** null = global artifact, available to all projects */
  project_id: string | null
  type: ArtifactType
  name: string
  /** Provenance: the harness this was first scanned from. Not where it gets written. */
  origin_harness: string
  /** Provenance: where it was first read from. */
  origin_path: string
  /** Harnesses this canonical artifact is rendered into. */
  targets: string[]
  /** The files it materializes to, one per target that can hold it. */
  rendered_paths: RenderedPath[]
  current_version_id: string | null
  pinned_version_id: string | null
  created_at: string
  updated_at: string
  project_name?: string | null
  version_count?: number
}

/** One canonical artifact projected into one harness's layout. */
export interface RenderedPath {
  harness: string
  relPath: string
}

export interface VersionMeta {
  id: string
  artifact_id: string
  hash: string
  source: string
  created_at: string
}

export interface Version extends VersionMeta {
  content: string
}

export interface AttachedProject {
  id: string
  name: string
  root_path: string
}

/** A file bundled with a skill (script, reference, asset), listed without its contents. */
export interface SkillFileMeta {
  path: string
  encoding: 'utf8' | 'base64'
  exec: boolean
  size: number
}

export interface SkillFile extends Omit<SkillFileMeta, 'exec'> {
  content: string
  exec?: boolean
}

export interface ArtifactDetail extends Artifact {
  versions: VersionMeta[]
  /** The artifact's own file: SKILL.md for a skill. */
  content: string
  /** Everything else in the skill's directory; empty for other types. */
  files: SkillFileMeta[]
  attached_projects: AttachedProject[]
  /** Harnesses that could hold this artifact type at all. */
  available_targets: string[]
}

export interface ProjectDetail extends Project {
  artifacts: Artifact[]
  /** Artifacts shared into this project from other projects or the global pool. */
  linked_artifacts: Artifact[]
  global_artifacts: Artifact[]
}

/** A path sync left alone because disk holds content the store never recorded. */
export interface SyncSkip {
  /** null when the artifact has no target that can hold it. */
  relPath: string | null
  artifact: string | null
  reason: 'local-edit' | 'unreadable' | 'no-target'
  targets?: string[]
}

export interface SyncResult {
  written: string[]
  /** Bundled skill files deleted upstream and pruned from the working tree. */
  removed: string[]
  skipped: SyncSkip[]
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.error) message = body.error
    } catch {
      // keep default message
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const api = {
  harnesses: () => request<HarnessRegistry>('/api/harnesses').then((r) => r.harnesses),
  harnessRegistry: () => request<HarnessRegistry>('/api/harnesses'),
  stats: () => request<Stats>('/api/stats'),
  activity: () => request<ActivityRow[]>('/api/activity'),
  projects: () => request<Project[]>('/api/projects'),
  project: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),
  syncProject: (id: string, force = false) =>
    request<SyncResult>(`/api/projects/${id}/sync${force ? '?force=true' : ''}`, { method: 'POST' }),
  deleteProject: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),
  artifacts: (type?: ArtifactType) => request<Artifact[]>(`/api/artifacts${type ? `?type=${type}` : ''}`),
  searchArtifacts: (q: string, type?: ArtifactType) => {
    const params = new URLSearchParams({ q })
    if (type) params.set('type', type)
    return request<Artifact[]>(`/api/artifacts?${params}`)
  },
  attachArtifact: (projectId: string, artifactId: string) =>
    request<{ ok: true } & SyncResult>(`/api/projects/${projectId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({ artifact_id: artifactId }),
    }),
  detachArtifact: (projectId: string, artifactId: string) =>
    request<{ ok: true; removed: string[] }>(`/api/projects/${projectId}/artifacts/${artifactId}`, { method: 'DELETE' }),
  artifact: (id: string) => request<ArtifactDetail>(`/api/artifacts/${id}`),
  version: (artifactId: string, versionId: string) =>
    request<Version>(`/api/artifacts/${artifactId}/versions/${versionId}`),
  artifactFile: (id: string, filePath: string, versionId?: string) => {
    const params = new URLSearchParams({ path: filePath })
    if (versionId) params.set('version_id', versionId)
    return request<SkillFile>(`/api/artifacts/${id}/file?${params}`)
  },
  /** Without `path` this saves the artifact's own file; with it, one bundled skill file. */
  saveArtifact: (id: string, content: string, filePath?: string) =>
    request<{ ok: true }>(`/api/artifacts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(filePath ? { content, path: filePath } : { content }),
    }),
  setTargets: (id: string, targets: string[]) =>
    request<{ ok: true; targets: string[]; rendered_paths: RenderedPath[] }>(`/api/artifacts/${id}/targets`, {
      method: 'PUT',
      body: JSON.stringify({ targets }),
    }),
  pinVersion: (id: string, versionId: string | null) =>
    request<{ ok: true }>(`/api/artifacts/${id}/pin`, { method: 'POST', body: JSON.stringify({ version_id: versionId }) }),
  restoreVersion: (id: string, versionId: string) =>
    request<{ ok: true }>(`/api/artifacts/${id}/restore`, { method: 'POST', body: JSON.stringify({ version_id: versionId }) }),
  deleteArtifact: (id: string) =>
    request<{
      ok: true
      deleted: { type: ArtifactType; name: string }
      /** Global config files checked when a global MCP server was deleted. */
      globals: Array<{ file: string; status: 'removed' | 'absent' }>
      detached: Array<{ project: string; removed: string[] }>
    }>(`/api/artifacts/${id}`, { method: 'DELETE' }),
  sessions: (opts: { harness?: SessionHarness; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams()
    if (opts.harness) params.set('harness', opts.harness)
    if (opts.limit) params.set('limit', String(opts.limit))
    if (opts.offset) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return request<SessionList>(`/api/sessions${qs ? `?${qs}` : ''}`)
  },
  sessionStarts: () => request<string[]>('/api/sessions/starts'),
  session: (id: string, opts: { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams()
    if (opts.limit) params.set('limit', String(opts.limit))
    if (opts.offset !== undefined) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return request<SessionDetail>(`/api/sessions/${id}${qs ? `?${qs}` : ''}`)
  },
  deleteSession: (id: string) => request<{ ok: true }>(`/api/sessions/${id}`, { method: 'DELETE' }),
}

/** Label from the registry list, falling back to the title-cased id while it loads. */
export function harnessLabel(id: string, harnesses?: HarnessInfo[]): string {
  return harnesses?.find((h) => h.id === id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1)
}

export const TYPE_LABELS: Record<ArtifactType, string> = {
  skill: 'Skill',
  mcp_server: 'MCP Server',
  agent_md: 'Agent File',
}

export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}
