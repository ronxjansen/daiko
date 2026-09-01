import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api, harnessLabel, timeAgo, type ArtifactType } from '../api'
import { HarnessIcon, HarnessMark } from '../components/HarnessIcon'

const PAGE_SIZE = 50

export function ArtifactList({ type, title }: { type: ArtifactType; title: string }) {
  const [search, setSearch] = useState('')
  const [harness, setHarness] = useState<string | undefined>(undefined)
  const [project, setProject] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(0)
  const harnesses = useQuery({ queryKey: ['harnesses'], queryFn: api.harnesses })
  const artifacts = useQuery({ queryKey: ['artifacts', type], queryFn: () => api.artifacts(type) })

  // Filter options come from the loaded rows, so only harnesses/projects that
  // actually hold artifacts of this type are offered.
  const harnessOptions = [...new Set(artifacts.data?.flatMap((a) => a.targets) ?? [])].sort()
  const projectOptions = [
    ...new Map(
      (artifacts.data ?? []).map((a) => [a.project_id ?? 'global', a.project_name ?? 'Global'] as const),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]))

  const needle = search.trim().toLowerCase()
  const matching = artifacts.data?.filter(
    (a) =>
      (!needle || a.name.toLowerCase().includes(needle)) &&
      (!harness || a.targets.includes(harness)) &&
      (!project || (a.project_id ?? 'global') === project),
  )
  const filtered = Boolean(needle || harness || project)

  // Paginate the filtered set, so page counts always reflect active filters.
  const total = matching?.length ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const visible = matching?.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // Any filter change restarts pagination from the first page of the new result set.
  const pickSearch = (s: string) => {
    setSearch(s)
    setPage(0)
  }
  const pickHarness = (h: string | undefined) => {
    setHarness(h)
    setPage(0)
  }
  const pickProject = (p: string | undefined) => {
    setProject(p)
    setPage(0)
  }

  return (
    <div>
      <header className="page-header">
        <div className="header-row">
          <h1>{title}</h1>
          {harnessOptions.length > 1 && (
            <div className="button-row">
              {[undefined, ...harnessOptions].map((h) => (
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
          )}
        </div>
        <div className="filter-bar">
          <input
            type="search"
            className="search-input"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => pickSearch(e.target.value)}
          />
          <select className="filter-select" value={project ?? ''} onChange={(e) => pickProject(e.target.value || undefined)}>
            <option value="">All projects</option>
            {projectOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
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

      {artifacts.data && artifacts.data.length > 0 && visible?.length === 0 && filtered && (
        <p className="empty">
          <span>No {title.toLowerCase()} match.</span>
        </p>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th className="col-hide-sm">Project</th>
            <th className="col-hide-sm">Targets</th>
            <th>Versions</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {visible?.map((a) => (
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
                  <span className="muted">Global</span>
                )}
              </td>
              <td className="col-hide-sm" title={a.rendered_paths.map((r) => r.relPath).join('\n')}>
                {a.targets.map((h) => (
                  <HarnessMark key={h} id={h} />
                ))}
              </td>
              <td className="mono">{a.version_count}</td>
              <td className="muted mono">{timeAgo(a.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {pageCount > 1 && (
        <div className="pager">
          <button className="btn btn-small" disabled={page === 0} onClick={() => setPage(page - 1)}>
            ← Prev
          </button>
          <span className="muted mono">
            {page + 1} / {pageCount} · {total} {title.toLowerCase()}
          </span>
          <button className="btn btn-small" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>
            Next →
          </button>
        </div>
      )}
    </div>
  )
}
