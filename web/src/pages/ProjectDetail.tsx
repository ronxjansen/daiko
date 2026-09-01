import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { api, timeAgo, TYPE_LABELS, type ArtifactType, type SyncResult, type SyncSkip } from '../api'

const TYPE_ORDER: ArtifactType[] = ['skill', 'mcp_server', 'agent_md']

const describeSkip = (skip: SyncSkip) =>
  skip.reason === 'unreadable' ? `${skip.relPath} (not valid JSON)` : `${skip.relPath} (${skip.artifact})`

/** Sync never overwrites unrecorded local edits, so the result has to say what it left behind. */
function syncMessage(result: SyncResult): string {
  const changes = [
    result.written.length > 0 && `Synced ${result.written.length} file(s): ${result.written.join(', ')}`,
    result.removed.length > 0 && `Removed ${result.removed.length} file(s) dropped upstream: ${result.removed.join(', ')}`,
  ].filter(Boolean) as string[]
  if (result.skipped.length === 0) return changes.length === 0 ? 'Already up to date.' : changes.join(' ')
  const wrote = changes.length === 0 ? 'Nothing written.' : changes.join(' ')
  return `${wrote} Kept local edits in ${result.skipped.map(describeSkip).join(', ')} — add them to the store, or overwrite them.`
}

export function ProjectDetail() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [notice, setNotice] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<SyncSkip[]>([])

  const [search, setSearch] = useState('')

  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) })
  const results = useQuery({
    queryKey: ['artifact-search', search],
    queryFn: () => api.searchArtifacts(search),
    enabled: search.trim().length > 0,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    queryClient.invalidateQueries({ queryKey: ['artifacts'] })
  }

  const attach = useMutation({
    mutationFn: (artifactId: string) => api.attachArtifact(projectId, artifactId),
    onSuccess: (result) => {
      setConflicts(result.skipped)
      setNotice(`Added. ${syncMessage(result)}`)
      invalidate()
    },
    onError: (err: Error) => setNotice(`Add failed: ${err.message}`),
  })

  const detach = useMutation({
    mutationFn: (artifactId: string) => api.detachArtifact(projectId, artifactId),
    onSuccess: (result) => {
      setNotice(result.removed.length === 0 ? 'Removed.' : `Removed from disk: ${result.removed.join(', ')}`)
      invalidate()
    },
    onError: (err: Error) => setNotice(`Remove failed: ${err.message}`),
  })

  const sync = useMutation({
    mutationFn: (force: boolean) => api.syncProject(projectId, force),
    onSuccess: (result) => {
      setConflicts(result.skipped)
      setNotice(syncMessage(result))
    },
    onError: (err: Error) => setNotice(`Sync failed: ${err.message}`),
  })

  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate({ to: '/projects' })
    },
  })

  if (project.isLoading) return <p className="muted">Loading…</p>
  if (project.isError)
    return (
      <p className="empty">
        <span>
          Couldn't reach the server. Restart <code>dai webui</code> and reload.
        </span>
      </p>
    )
  if (!project.data) return <p className="muted">Project not found.</p>

  const p = project.data
  const addable = (results.data ?? []).filter(
    (a) => a.project_id !== p.id && !p.linked_artifacts.some((l) => l.id === a.id),
  )

  return (
    <div>
      <header className="page-header">
        <div className="header-row">
          <div>
            <h1>{p.name}</h1>
            <p className="muted mono">{p.root_path}</p>
          </div>
          <div className="button-row">
            <button className="btn" onClick={() => sync.mutate(false)} disabled={sync.isPending}>
              {sync.isPending ? 'Syncing…' : 'Sync to disk'}
            </button>
            {conflicts.length > 0 && (
              <button
                className="btn btn-danger"
                disabled={sync.isPending}
                onClick={() => {
                  const files = conflicts.map(describeSkip).join('\n')
                  if (confirm(`Replace these local edits with the stored version?\n\n${files}`)) sync.mutate(true)
                }}
              >
                Overwrite local edits
              </button>
            )}
            <button
              className="btn btn-danger"
              onClick={() => {
                if (confirm(`Remove project "${p.name}" and all its stored versions?`)) remove.mutate()
              }}
            >
              Remove
            </button>
          </div>
        </div>
        {notice && <p className={conflicts.length > 0 ? 'notice notice-warn' : 'notice'}>{notice}</p>}
      </header>

      {TYPE_ORDER.map((type) => {
        const items = p.artifacts.filter((a) => a.type === type)
        if (items.length === 0) return null
        return (
          <section className="panel" key={type}>
            <h2>{TYPE_LABELS[type]}s</h2>
            <ul className="artifact-list">
              {items.map((a) => (
                <li key={a.id}>
                  <Link to="/artifacts/$artifactId" params={{ artifactId: a.id }}>
                    <span className="artifact-name">{a.name}</span>
                    {a.pinned_version_id && <span className="pin-badge">pinned</span>}
                    <span className="muted mono">{a.rendered_paths.map((r) => r.relPath).join('  ')}</span>
                    <span className="muted">{timeAgo(a.updated_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      })}

      {p.linked_artifacts.length > 0 && (
        <section className="panel">
          <h2>Shared from Library</h2>
          <p className="muted">Skills and MCP servers added from other projects. Removing also deletes them from this repo.</p>
          <ul className="artifact-list">
            {p.linked_artifacts.map((a) => (
              <li key={a.id} className="artifact-row">
                <Link to="/artifacts/$artifactId" params={{ artifactId: a.id }}>
                  <span className={`badge badge-${a.type}`}>{TYPE_LABELS[a.type]}</span>
                  <span className="artifact-name">{a.name}</span>
                  <span className="muted">{a.project_name ? `from ${a.project_name}` : 'global'}</span>
                </Link>
                <button className="btn btn-small" onClick={() => detach.mutate(a.id)} disabled={detach.isPending}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>Add from Library</h2>
        <p className="muted">Search every stored skill, MCP server, and agent file; adding writes it into this repo.</p>
        <input
          className="search-input"
          type="search"
          placeholder="Search skills, MCP servers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search.trim().length > 0 && (
          <ul className="artifact-list">
            {addable.map((a) => (
              <li key={a.id} className="artifact-row">
                <Link to="/artifacts/$artifactId" params={{ artifactId: a.id }}>
                  <span className={`badge badge-${a.type}`}>{TYPE_LABELS[a.type]}</span>
                  <span className="artifact-name">{a.name}</span>
                  <span className="muted">{a.project_name ?? 'global'}</span>
                </Link>
                <button className="btn btn-small" onClick={() => attach.mutate(a.id)} disabled={attach.isPending}>
                  Add
                </button>
              </li>
            ))}
            {results.data && addable.length === 0 && <li className="muted">No matches.</li>}
          </ul>
        )}
      </section>

      {p.global_artifacts.length > 0 && (
        <section className="panel">
          <h2>Global MCP Servers</h2>
          <p className="muted">Registered harness-wide, available to every project.</p>
          <ul className="artifact-list">
            {p.global_artifacts.map((a) => (
              <li key={a.id}>
                <Link to="/artifacts/$artifactId" params={{ artifactId: a.id }}>
                  <span className="artifact-name">{a.name}</span>
                  {a.pinned_version_id && <span className="pin-badge">pinned</span>}
                  <span className="muted mono">{a.rendered_paths.map((r) => r.relPath).join('  ')}</span>
                  <span className="muted">{a.targets.join(', ')}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.artifacts.length === 0 && (
        <p className="empty">
          <span>
            No artifacts yet. Run <code>dai add {p.root_path}</code>.
          </span>
        </p>
      )}
    </div>
  )
}
