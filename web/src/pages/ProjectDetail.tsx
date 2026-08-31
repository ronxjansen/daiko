import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { api, timeAgo, TYPE_LABELS, type ArtifactType } from '../api'

const TYPE_ORDER: ArtifactType[] = ['skill', 'mcp_server', 'agent_md']

export function ProjectDetail() {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [syncMessage, setSyncMessage] = useState<string | null>(null)

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
      setSyncMessage(
        result.written.length === 0
          ? 'Added. Already up to date on disk.'
          : `Added and synced: ${result.written.join(', ')}`,
      )
      invalidate()
    },
    onError: (err: Error) => setSyncMessage(`Add failed: ${err.message}`),
  })

  const detach = useMutation({
    mutationFn: (artifactId: string) => api.detachArtifact(projectId, artifactId),
    onSuccess: (result) => {
      setSyncMessage(result.removed.length === 0 ? 'Removed.' : `Removed from disk: ${result.removed.join(', ')}`)
      invalidate()
    },
    onError: (err: Error) => setSyncMessage(`Remove failed: ${err.message}`),
  })

  const sync = useMutation({
    mutationFn: () => api.syncProject(projectId),
    onSuccess: (result) => {
      setSyncMessage(
        result.written.length === 0 ? 'Already up to date.' : `Synced ${result.written.length} file(s): ${result.written.join(', ')}`,
      )
    },
    onError: (err: Error) => setSyncMessage(`Sync failed: ${err.message}`),
  })

  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate({ to: '/projects' })
    },
  })

  if (project.isLoading) return <p className="muted">Loading…</p>
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
            <button className="btn" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? 'Syncing…' : 'Sync to disk'}
            </button>
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
        {syncMessage && <p className="notice">{syncMessage}</p>}
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
                    <span className="muted mono">{a.rel_path}</span>
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
                  <span className="muted">{a.project_name ?? `global (${a.harness})`}</span>
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
                  <span className="muted mono">{a.rel_path}</span>
                  <span className="muted">{a.harness}</span>
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
