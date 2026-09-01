import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { api, timeAgo, TYPE_LABELS } from '../api'

export function ArtifactDetail() {
  const { artifactId } = useParams({ from: '/artifacts/$artifactId' })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [viewVersionId, setViewVersionId] = useState<string | null>(null)

  const [shareMessage, setShareMessage] = useState<string | null>(null)

  const artifact = useQuery({ queryKey: ['artifact', artifactId], queryFn: () => api.artifact(artifactId) })
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const viewedVersion = useQuery({
    queryKey: ['version', artifactId, viewVersionId],
    queryFn: () => api.version(artifactId, viewVersionId!),
    enabled: viewVersionId !== null,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] })
    queryClient.invalidateQueries({ queryKey: ['artifacts'] })
    queryClient.invalidateQueries({ queryKey: ['activity'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
  }

  const save = useMutation({
    mutationFn: (content: string) => api.saveArtifact(artifactId, content),
    onSuccess: () => {
      setEditing(false)
      invalidate()
    },
  })
  const pin = useMutation({
    mutationFn: (versionId: string | null) => api.pinVersion(artifactId, versionId),
    onSuccess: invalidate,
  })
  const restore = useMutation({
    mutationFn: (versionId: string) => api.restoreVersion(artifactId, versionId),
    onSuccess: () => {
      setViewVersionId(null)
      invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: () => api.deleteArtifact(artifactId),
    onSuccess: () => navigate({ to: '/' }),
    onError: (err: Error) => setShareMessage(`Delete failed: ${err.message}`),
  })
  const attach = useMutation({
    mutationFn: (projectId: string) => api.attachArtifact(projectId, artifactId),
    onSuccess: (result) => {
      setShareMessage(result.written.length === 0 ? 'Added.' : `Added and synced: ${result.written.join(', ')}`)
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['project'] })
    },
    onError: (err: Error) => setShareMessage(`Add failed: ${err.message}`),
  })
  const detach = useMutation({
    mutationFn: (projectId: string) => api.detachArtifact(projectId, artifactId),
    onSuccess: (result) => {
      setShareMessage(result.removed.length === 0 ? 'Removed.' : `Removed from disk: ${result.removed.join(', ')}`)
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['project'] })
    },
    onError: (err: Error) => setShareMessage(`Remove failed: ${err.message}`),
  })

  if (artifact.isLoading) return <p className="muted">Loading…</p>
  if (artifact.isError)
    return (
      <p className="empty">
        <span>
          Couldn't reach the server. Restart <code>dai webui</code> and reload.
        </span>
      </p>
    )
  if (!artifact.data) return <p className="muted">Artifact not found.</p>

  const a = artifact.data
  const shownContent = viewVersionId ? (viewedVersion.data?.content ?? '') : a.content

  return (
    <div>
      <header className="page-header">
        <div className="header-row">
          <div>
            <h1>
              <span className={`badge badge-${a.type}`}>{TYPE_LABELS[a.type]}</span> {a.name}
            </h1>
            <p className="muted">
              {a.project_id ? (
                <Link to="/projects/$projectId" params={{ projectId: a.project_id }} className="row-link">
                  {a.project_name}
                </Link>
              ) : (
                <span>Global</span>
              )}{' '}
              · <span className="mono">{a.rel_path}</span> · harness: {a.harness}
              {a.pinned_version_id && <span className="pin-badge">pinned</span>}
            </p>
          </div>
          <div className="button-row">
            {!editing && (
              <button
                className="btn"
                onClick={() => {
                  setDraft(a.content)
                  setViewVersionId(null)
                  setEditing(true)
                }}
              >
                Edit
              </button>
            )}
            <button
              className="btn btn-danger"
              onClick={() => {
                const globalNote =
                  !a.project_id && a.type === 'mcp_server'
                    ? ` This also removes it from the ${a.harness} global config (${a.rel_path}).`
                    : ''
                if (confirm(`Delete "${a.name}" and all its versions?${globalNote}`)) remove.mutate()
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </header>

      <div className="detail-grid">
        <section className="panel content-plate">
          {viewVersionId && (
            <div className="notice">
              Viewing an older version.{' '}
              <button className="btn btn-small" onClick={() => setViewVersionId(null)}>
                Back to current
              </button>{' '}
              <button className="btn btn-small" onClick={() => restore.mutate(viewVersionId)}>
                Restore this version
              </button>
            </div>
          )}
          {editing ? (
            <>
              <textarea className="editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
              <div className="button-row">
                <button className="btn btn-primary" onClick={() => save.mutate(draft)} disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save as new version'}
                </button>
                <button className="btn" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <pre className="content-view">{shownContent}</pre>
          )}
        </section>

        <div className="detail-side">
          <aside className="panel">
            <h2>Projects</h2>
            <p className="muted">Add this {TYPE_LABELS[a.type].toLowerCase()} to a repo, or remove it again.</p>
            {shareMessage && <p className="notice">{shareMessage}</p>}
            <ul className="share-list">
              {projects.data?.map((proj) => {
                const isOrigin = proj.id === a.project_id
                const isAttached = a.attached_projects.some((ap) => ap.id === proj.id)
                return (
                  <li key={proj.id}>
                    <Link to="/projects/$projectId" params={{ projectId: proj.id }} className="row-link">
                      {proj.name}
                    </Link>
                    {isOrigin ? (
                      <span className="tag">origin</span>
                    ) : (
                      <button
                        className="btn btn-small"
                        onClick={() => (isAttached ? detach.mutate(proj.id) : attach.mutate(proj.id))}
                        disabled={attach.isPending || detach.isPending}
                        title={
                          isAttached
                            ? 'Remove from this repo (deletes it from disk)'
                            : 'Add to this repo (writes it to disk)'
                        }
                      >
                        {isAttached ? 'Remove' : 'Add'}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </aside>

          <aside className="panel versions-panel">
            <h2>Versions</h2>
          <ul className="version-list">
            {a.versions.map((v) => {
              const isCurrent = v.id === a.current_version_id
              const isPinned = v.id === a.pinned_version_id
              return (
                <li key={v.id} className={viewVersionId === v.id ? 'selected' : ''}>
                  <button className="version-row" onClick={() => setViewVersionId(isCurrent ? null : v.id)}>
                    <span className="mono">{v.hash.slice(0, 8)}</span>
                    <span className="muted">
                      {v.source} · {timeAgo(v.created_at)}
                    </span>
                    {isCurrent && <span className="tag">current</span>}
                    {isPinned && <span className="pin-badge">pinned</span>}
                  </button>
                  <button
                    className="btn btn-small"
                    onClick={() => pin.mutate(isPinned ? null : v.id)}
                    title={isPinned ? 'Unpin: sync will use the latest version' : 'Pin: sync will always use this version'}
                  >
                    {isPinned ? 'Unpin' : 'Pin'}
                  </button>
                </li>
              )
            })}
            </ul>
          </aside>
        </div>
      </div>
    </div>
  )
}
