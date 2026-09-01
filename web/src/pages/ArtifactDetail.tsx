import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { api, harnessLabel, timeAgo, TYPE_LABELS } from '../api'

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`)

export function ArtifactDetail() {
  const { artifactId } = useParams({ from: '/artifacts/$artifactId' })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [viewVersionId, setViewVersionId] = useState<string | null>(null)
  // null = the artifact's own file (SKILL.md); otherwise a bundled file's path.
  const [filePath, setFilePath] = useState<string | null>(null)

  const [shareMessage, setShareMessage] = useState<string | null>(null)

  const artifact = useQuery({ queryKey: ['artifact', artifactId], queryFn: () => api.artifact(artifactId) })
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
  const harnesses = useQuery({ queryKey: ['harnesses'], queryFn: api.harnesses })
  const viewedVersion = useQuery({
    queryKey: ['version', artifactId, viewVersionId],
    queryFn: () => api.version(artifactId, viewVersionId!),
    enabled: viewVersionId !== null,
  })
  const viewedFile = useQuery({
    queryKey: ['artifact-file', artifactId, filePath],
    queryFn: () => api.artifactFile(artifactId, filePath!),
    enabled: filePath !== null,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] })
    queryClient.invalidateQueries({ queryKey: ['artifacts'] })
    queryClient.invalidateQueries({ queryKey: ['activity'] })
    queryClient.invalidateQueries({ queryKey: ['stats'] })
  }

  const save = useMutation({
    mutationFn: (content: string) => api.saveArtifact(artifactId, content, filePath ?? undefined),
    onSuccess: () => {
      setEditing(false)
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['artifact-file', artifactId] })
    },
  })
  const setTargets = useMutation({
    mutationFn: (targets: string[]) => api.setTargets(artifactId, targets),
    onSuccess: (result) => {
      setShareMessage(
        result.rendered_paths.length === 0
          ? 'No target can hold this in a project tree, so sync will write nothing.'
          : `Now written to ${result.rendered_paths.map((r) => r.relPath).join(', ')} on the next sync.`,
      )
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['project'] })
    },
    onError: (err: Error) => setShareMessage(`Targets failed: ${err.message}`),
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
  // A skill is a directory: SKILL.md plus its bundled scripts, references and assets.
  const bundled = filePath ? a.files.find((f) => f.path === filePath) : undefined
  const isBinary = bundled?.encoding === 'base64'
  const editable = !isBinary && viewVersionId === null
  const shownContent = viewVersionId
    ? (viewedVersion.data?.content ?? '')
    : bundled
      ? isBinary
        ? `${bundled.path} — binary file, ${formatBytes(bundled.size)}. Stored and synced as-is.`
        : (viewedFile.data?.content ?? '')
      : a.content
  const startEditing = () => {
    setDraft(shownContent)
    setViewVersionId(null)
    setEditing(true)
  }

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
              · from <span className="mono">{a.origin_path}</span>
              {a.rendered_paths.length > 0 && (
                <> · written to <span className="mono">{a.rendered_paths.map((r) => r.relPath).join(', ')}</span></>
              )}
              {a.pinned_version_id && <span className="pin-badge">pinned</span>}
            </p>
          </div>
          <div className="button-row">
            {!editing && editable && (
              <button className="btn" onClick={startEditing}>
                Edit{bundled ? ` ${bundled.path}` : ''}
              </button>
            )}
            <button
              className="btn btn-danger"
              onClick={() => {
                const globalNote =
                  !a.project_id && a.type === 'mcp_server'
                    ? ` This also removes it from the ${harnessLabel(a.origin_harness, harnesses.data)} global config (${a.origin_path}).`
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
          {a.files.length > 0 && !viewVersionId && (
            <nav className="file-tabs" aria-label="Skill files">
              <button
                className={`file-tab${filePath === null ? ' selected' : ''}`}
                onClick={() => {
                  setEditing(false)
                  setFilePath(null)
                }}
              >
                SKILL.md
              </button>
              {a.files.map((f) => (
                <button
                  key={f.path}
                  className={`file-tab${filePath === f.path ? ' selected' : ''}`}
                  onClick={() => {
                    setEditing(false)
                    setFilePath(f.path)
                  }}
                  title={`${formatBytes(f.size)}${f.exec ? ' · executable' : ''}`}
                >
                  {f.path}
                  {f.exec && <span className="file-tab-flag">exec</span>}
                </button>
              ))}
            </nav>
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
            <h2>Targets</h2>
            <p className="muted">
              Harnesses this {TYPE_LABELS[a.type].toLowerCase()} is written for. One stored copy, one file per harness
              that can hold it.
            </p>
            <ul className="share-list">
              {a.available_targets.map((h) => {
                const on = a.targets.includes(h)
                const relPath = a.rendered_paths.find((r) => r.harness === h)?.relPath
                return (
                  <li key={h}>
                    <span className="row-link">
                      {harnessLabel(h, harnesses.data)}
                      {relPath && <span className="muted mono"> {relPath}</span>}
                    </span>
                    <button
                      className={`btn btn-small${on ? '' : ' btn-primary'}`}
                      onClick={() => setTargets.mutate(on ? a.targets.filter((t) => t !== h) : [...a.targets, h])}
                      disabled={setTargets.isPending}
                      title={on ? `Stop writing this to ${h}` : `Also write this to ${h}`}
                    >
                      {on ? 'Remove' : 'Add'}
                    </button>
                  </li>
                )
              })}
              {a.available_targets.length === 0 && (
                <li className="muted">No harness can hold a {TYPE_LABELS[a.type].toLowerCase()} in a project tree yet.</li>
              )}
            </ul>
          </aside>

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
