import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api, timeAgo, harnessLabel, type SessionHarness } from '../api'

const PAGE_SIZE = 50

export function Sessions() {
  const [harness, setHarness] = useState<SessionHarness | undefined>(undefined)
  const [page, setPage] = useState(0)
  const harnesses = useQuery({ queryKey: ['harnesses'], queryFn: api.harnesses })
  const sessions = useQuery({
    queryKey: ['sessions', harness ?? 'all', page],
    queryFn: () => api.sessions({ harness, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  })

  const total = sessions.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const pickHarness = (h: SessionHarness | undefined) => {
    setHarness(h)
    setPage(0)
  }

  return (
    <div>
      <header className="page-header">
        <div className="header-row">
          <div>
            <h1>Sessions</h1>
            <p className="muted">
              Full transcripts captured by hooks and <code>dai import</code>.
            </p>
          </div>
          <div className="button-row">
            {[undefined, ...(harnesses.data?.filter((h) => h.sessions).map((h) => h.id) ?? [])].map((h) => (
              <button
                key={h ?? 'all'}
                className={`btn btn-small ${harness === h ? 'btn-primary' : ''}`}
                onClick={() => pickHarness(h)}
              >
                {h ? harnessLabel(h, harnesses.data) : 'All'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {sessions.data?.sessions.length === 0 && (
        <p className="empty">
          <span>
            No sessions yet. Run <code>dai import</code> to backfill, or <code>dai hook</code> to capture live sessions.
          </span>
        </p>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Session</th>
            <th className="col-hide-sm">Harness</th>
            <th className="col-hide-sm">Project</th>
            <th>Messages</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {sessions.data?.sessions.map((s) => (
            <tr key={s.id}>
              <td>
                <Link to="/sessions/$sessionId" params={{ sessionId: s.id }} className="row-link session-preview">
                  {s.title ?? s.preview ?? s.external_id}
                </Link>
              </td>
              <td className="col-hide-sm">
                <span className={`badge badge-harness-${s.harness}`}>{harnessLabel(s.harness, harnesses.data)}</span>
              </td>
              <td className="muted mono col-hide-sm">{s.project_path ? shortenPath(s.project_path) : '–'}</td>
              <td className="mono">{s.message_count}</td>
              <td className="muted mono">{s.started_at ? timeAgo(s.started_at) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {pageCount > 1 && (
        <div className="pager">
          <button className="btn btn-small" disabled={page === 0} onClick={() => setPage(page - 1)}>
            ← Newer
          </button>
          <span className="muted mono">
            {page + 1} / {pageCount} · {total} sessions
          </span>
          <button className="btn btn-small" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>
            Older →
          </button>
        </div>
      )}
    </div>
  )
}

export function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join('/') : p
}
