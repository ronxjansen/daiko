import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, timeAgo } from '../api'

export function Projects() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

  return (
    <div>
      <header className="page-header">
        <h1>Projects</h1>
        <p className="muted">
          Register a repo with <code>dai add /path/to/repo</code>.
        </p>
      </header>

      {projects.data?.length === 0 && (
        <p className="empty">
          <span>No projects registered yet.</span>
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
          {projects.data?.map((p) => (
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
