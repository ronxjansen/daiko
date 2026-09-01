import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Fragment } from 'react'
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

      {(stats.isError || activity.isError) && (
        <p className="empty">
          <span>
            Couldn't reach the server. Restart <code>dai webui</code> and reload.
          </span>
        </p>
      )}

      <div className="stat-grid">
        <StatCard label="Projects" value={stats.data?.projects} to="/projects" />
        <StatCard label="Skills" value={stats.data?.skills} to="/skills" />
        <StatCard label="MCP Servers" value={stats.data?.mcp_servers} to="/mcp" />
        <StatCard label="Agent Files" value={stats.data?.agent_files} />
        <StatCard label="Versions" value={stats.data?.versions} />
        <StatCard label="Sessions" value={stats.data?.sessions} to="/sessions" />
      </div>

      <SessionHeatmap />

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

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const pad = (n: number) => String(n).padStart(2, '0')

function SessionHeatmap() {
  const starts = useQuery({ queryKey: ['session-starts'], queryFn: api.sessionStarts })
  if (!starts.data?.length) return null

  // Bucket by local weekday (Monday-first) and hour of day.
  const counts = new Array<number>(7 * 24).fill(0)
  for (const iso of starts.data) {
    const d = new Date(iso)
    if (!Number.isNaN(d.getTime())) counts[((d.getDay() + 6) % 7) * 24 + d.getHours()]++
  }
  const max = Math.max(...counts)
  if (max === 0) return null
  const peak = counts.indexOf(max)
  const busiest = `${DAY_LABELS[Math.floor(peak / 24)]} ${pad(peak % 24)}:00 with ${max} session${max === 1 ? '' : 's'}`

  return (
    <section className="panel">
      <h2>Session cadence</h2>
      <div
        className="heatmap"
        role="img"
        aria-label={`Sessions by weekday and hour, local time. Busiest slot: ${busiest}.`}
      >
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className={`heatmap-hour${h % 6 ? ' heatmap-hour-minor' : ''}`}>
            {h % 3 === 0 ? pad(h) : ''}
          </div>
        ))}
        {DAY_LABELS.map((day, di) => (
          <Fragment key={day}>
            <div className="heatmap-day">{day}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const n = counts[di * 24 + h]
              return (
                <div
                  key={h}
                  className="heatmap-cell"
                  data-level={n === 0 ? 0 : Math.ceil((n / max) * 4)}
                  title={`${n} session${n === 1 ? '' : 's'} · ${day} ${pad(h)}:00–${pad(h + 1)}:00`}
                />
              )
            })}
          </Fragment>
        ))}
      </div>
      <div className="heatmap-legend">
        <span>Local time</span>
        <span className="heatmap-scale">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className="heatmap-cell" data-level={level} />
          ))}
          <span>More</span>
        </span>
      </div>
    </section>
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
