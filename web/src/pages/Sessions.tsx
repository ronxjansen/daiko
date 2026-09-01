import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, formatCost, formatTokens, timeAgo, harnessLabel, type SessionHarness } from '../api'
import { HarnessIcon, HarnessMark } from '../components/HarnessIcon'

const PAGE_SIZE = 50

/** Debounce keystrokes so each pause yields one server query, not one per key. */
function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export function Sessions() {
  const [harness, setHarness] = useState<SessionHarness | undefined>(undefined)
  const [project, setProject] = useState<string | undefined>(undefined)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const q = useDebounced(search.trim())
  const harnesses = useQuery({ queryKey: ['harnesses'], queryFn: api.harnesses })
  const projects = useQuery({ queryKey: ['session-projects'], queryFn: api.sessionProjects })
  const sessions = useQuery({
    queryKey: ['sessions', harness ?? 'all', project ?? 'all', q, page],
    queryFn: () => api.sessions({ harness, project, q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    placeholderData: (prev) => prev,
  })

  const total = sessions.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const filtered = Boolean(q || harness || project)

  // Any filter change restarts pagination from the first page of the new result set.
  const pickHarness = (h: SessionHarness | undefined) => {
    setHarness(h)
    setPage(0)
  }
  const pickProject = (p: string | undefined) => {
    setProject(p)
    setPage(0)
  }
  const pickSearch = (s: string) => {
    setSearch(s)
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
                {h ? (
                  <>
                    <HarnessIcon id={h} />
                    {harnessLabel(h, harnesses.data)}
                  </>
                ) : (
                  'All'
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="filter-bar">
          <input
            type="search"
            className="search-input"
            placeholder="Search sessions… (all keywords must match)"
            value={search}
            onChange={(e) => pickSearch(e.target.value)}
          />
          <select
            className="filter-select"
            value={project ?? ''}
            onChange={(e) => pickProject(e.target.value || undefined)}
          >
            <option value="">All projects</option>
            {projects.data?.map((p) => (
              <option key={p} value={p}>
                {shortenPath(p)}
              </option>
            ))}
          </select>
        </div>
      </header>

      {sessions.isError && (
        <p className="empty">
          <span>
            Couldn't reach the server. Restart <code>dai webui</code> and reload.
          </span>
        </p>
      )}

      {sessions.data?.sessions.length === 0 &&
        (filtered ? (
          <p className="empty">
            <span>No sessions match.</span>
          </p>
        ) : (
          <p className="empty">
            <span>
              No sessions yet. Run <code>dai import</code> to backfill, or <code>dai hook</code> to capture live
              sessions.
            </span>
          </p>
        ))}

      <table className="table">
        <thead>
          <tr>
            <th>Session</th>
            <th className="col-hide-sm">Harness</th>
            <th className="col-hide-sm">Project</th>
            <th>Messages</th>
            <th className="col-hide-sm">Tokens</th>
            <th className="col-hide-sm">Est. cost</th>
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
                <HarnessMark id={s.harness} harnesses={harnesses.data} />
              </td>
              <td className="muted mono col-hide-sm">{s.project_path ? shortenPath(s.project_path) : '–'}</td>
              <td className="mono">{s.message_count}</td>
              <td className="mono col-hide-sm" title={s.model ?? undefined}>
                {s.total_tokens !== null ? formatTokens(s.total_tokens) : '–'}
              </td>
              <td className="mono col-hide-sm">{s.estimated_cost_usd !== null ? formatCost(s.estimated_cost_usd) : '–'}</td>
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
