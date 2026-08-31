import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, timeAgo, TYPE_LABELS } from '../api'

export function Dashboard() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const activity = useQuery({ queryKey: ['activity'], queryFn: api.activity })

  return (
    <div>
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="muted">Your central store for skills, MCP servers, and agent files.</p>
      </header>

      <div className="stat-grid">
        <StatCard label="Projects" value={stats.data?.projects} to="/projects" />
        <StatCard label="Skills" value={stats.data?.skills} to="/skills" />
        <StatCard label="MCP Servers" value={stats.data?.mcp_servers} to="/mcp" />
        <StatCard label="Agent Files" value={stats.data?.agent_files} />
        <StatCard label="Versions" value={stats.data?.versions} />
        <StatCard label="Sessions" value={stats.data?.sessions} to="/sessions" />
      </div>

      <section className="panel">
        <h2>Recent activity</h2>
        {activity.data?.length === 0 && (
          <p className="empty">
            <span>
              Nothing here yet. Run <code>dai add .</code> in a repo to get started.
            </span>
          </p>
        )}
        <ul className="activity-list">
          {activity.data?.map((row) => (
            <li key={row.id}>
              <Link to="/artifacts/$artifactId" params={{ artifactId: row.artifact_id }}>
                <span className={`badge badge-${row.type}`}>{TYPE_LABELS[row.type]}</span>
                <span className="activity-name">{row.artifact_name}</span>
                <span className="muted">{row.project_name ? `in ${row.project_name}` : 'global'}</span>
                <span className="muted activity-meta">
                  {row.source} · {timeAgo(row.created_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function StatCard({ label, value, to }: { label: string; value: number | undefined; to?: string }) {
  const inner = (
    <>
      <div className="stat-value">{value ?? '–'}</div>
      <div className="stat-label">{label}</div>
    </>
  )
  return to ? (
    <Link to={to} className="stat-card stat-link">
      {inner}
    </Link>
  ) : (
    <div className="stat-card">{inner}</div>
  )
}
