import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api, timeAgo } from '../api'

export function Projects() {
  const [search, setSearch] = useState('')
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

  const needle = search.trim().toLowerCase()
  const visible = projects.data?.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || p.root_path.toLowerCase().includes(needle),
  )

  return (
    <div>
      <header className="page-header">
        <h1>Projects</h1>
        <p className="muted">
          Register a repo with <code>dai add /path/to/repo</code>.
        </p>
        <input
          type="search"
          className="search-input"
          placeholder="Search by name or directory…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>

      {projects.isError && (
        <p className="empty">
          <span>
            Couldn't reach the server. Restart <code>dai webui</code> and reload.
          </span>
        </p>
      )}

      {projects.data?.length === 0 && (
        <p className="empty">
          <span>No projects registered yet.</span>
        </p>
      )}

      {projects.data && projects.data.length > 0 && visible?.length === 0 && (
        <p className="empty">
          <span>No projects match.</span>
        </p>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th className="col-hide-sm">Path</th>
            <th>Artifacts</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {visible?.map((p) => (
            <tr key={p.id}>
              <td>
                <Link to="/projects/$projectId" params={{ projectId: p.id }} className="row-link">
                  {p.name}
                </Link>
              </td>
              <td className="muted mono col-hide-sm">{p.root_path}</td>
              <td className="mono">{p.artifact_count}</td>
              <td className="muted mono">{timeAgo(p.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
