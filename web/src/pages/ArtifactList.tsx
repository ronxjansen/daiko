import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, timeAgo, type ArtifactType } from '../api'

export function ArtifactList({ type, title }: { type: ArtifactType; title: string }) {
  const artifacts = useQuery({ queryKey: ['artifacts', type], queryFn: () => api.artifacts(type) })

  return (
    <div>
      <header className="page-header">
        <h1>{title}</h1>
      </header>

      {artifacts.isError && (
        <p className="empty">
          <span>
            Couldn't reach the server. Restart <code>dai webui</code> and reload.
          </span>
        </p>
      )}

      {artifacts.data?.length === 0 && (
        <p className="empty">
          <span>
            None yet. Run <code>dai add .</code> in a repo that has them.
          </span>
        </p>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th className="col-hide-sm">Project</th>
            <th className="col-hide-sm">Source</th>
            <th>Versions</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {artifacts.data?.map((a) => (
            <tr key={a.id}>
              <td>
                <Link to="/artifacts/$artifactId" params={{ artifactId: a.id }} className="row-link">
                  {a.name}
                </Link>
                {a.pinned_version_id && <span className="pin-badge">pinned</span>}
              </td>
              <td className="col-hide-sm">
                {a.project_id ? (
                  <Link to="/projects/$projectId" params={{ projectId: a.project_id }} className="row-link muted">
                    {a.project_name}
                  </Link>
                ) : (
                  <span className="muted">Global ({a.harness})</span>
                )}
              </td>
              <td className="muted mono col-hide-sm">{a.rel_path}</td>
              <td className="mono">{a.version_count}</td>
              <td className="muted mono">{timeAgo(a.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
