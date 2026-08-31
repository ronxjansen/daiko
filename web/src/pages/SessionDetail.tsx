import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { api, harnessLabel, type SessionMessage } from '../api'
import { shortenPath } from './Sessions'

const PAGE_SIZE = 300

export function SessionDetail() {
  const { sessionId } = useParams({ from: '/sessions/$sessionId' })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const harnesses = useQuery({ queryKey: ['harnesses'], queryFn: api.harnesses })

  const session = useInfiniteQuery({
    queryKey: ['session', sessionId],
    queryFn: ({ pageParam }) => api.session(sessionId, { limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.message_offset + last.messages.length < last.message_count ? last.message_offset + PAGE_SIZE : undefined,
  })

  const remove = useMutation({
    mutationFn: () => api.deleteSession(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      navigate({ to: '/sessions' })
    },
  })

  if (session.isLoading) return <p className="muted">Loading…</p>
  const meta = session.data?.pages[0]
  if (!meta) return <p className="muted">Session not found.</p>

  const messages = session.data?.pages.flatMap((p) => p.messages) ?? []

  return (
    <div>
      <header className="page-header">
        <div className="header-row">
          <div>
            <h1>
              <span className={`badge badge-harness-${meta.harness}`}>{harnessLabel(meta.harness, harnesses.data)}</span>{' '}
              {meta.title ?? (meta.project_path ? shortenPath(meta.project_path) : 'Session')}
            </h1>
            <p className="muted">
              <span className="mono">{meta.external_id}</span>
              {meta.project_path && (
                <>
                  {' '}
                  · <span className="mono">{meta.project_path}</span>
                </>
              )}{' '}
              · {meta.message_count} messages
              {meta.started_at && <> · {new Date(meta.started_at).toLocaleString()}</>}
            </p>
          </div>
          <div className="button-row">
            <button
              className="btn btn-danger"
              onClick={() => {
                if (confirm('Delete this session and all its messages? The source transcript file is not touched.'))
                  remove.mutate()
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </header>

      <section className="panel transcript">
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
        {session.hasNextPage && (
          <div className="pager">
            <button className="btn" onClick={() => session.fetchNextPage()} disabled={session.isFetchingNextPage}>
              {session.isFetchingNextPage ? 'Loading…' : `Load more (${messages.length} / ${meta.message_count})`}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

const KIND_LABELS: Record<SessionMessage['kind'], string> = {
  text: '',
  thinking: 'thinking',
  tool_use: 'tool call',
  tool_result: 'result',
  system: 'system',
}

const COLLAPSE_KINDS = new Set(['thinking', 'tool_result', 'system'])
const COLLAPSE_CHARS = 500

function MessageRow({ m }: { m: SessionMessage }) {
  const [open, setOpen] = useState(false)
  const content = displayContent(m)
  const collapsible = COLLAPSE_KINDS.has(m.kind) || content.length > COLLAPSE_CHARS
  const shown = collapsible && !open ? content.slice(0, COLLAPSE_CHARS) : content

  const who = m.kind === 'text' ? m.role : KIND_LABELS[m.kind]
  return (
    <div className={`msg msg-${m.role} msg-kind-${m.kind}`}>
      <div className="msg-meta">
        <span className="msg-who">{who}</span>
        {m.kind === 'tool_use' && m.tool_name && <span className="msg-tool mono">{m.tool_name}</span>}
        {m.timestamp && (
          <span className="muted mono msg-time">{new Date(m.timestamp).toLocaleTimeString()}</span>
        )}
      </div>
      <pre className="msg-body">
        {shown}
        {collapsible && !open && content.length > COLLAPSE_CHARS && <span className="muted">…</span>}
      </pre>
      {collapsible && content.length > COLLAPSE_CHARS && (
        <button className="btn btn-small msg-toggle" onClick={() => setOpen(!open)}>
          {open ? 'Collapse' : `Expand (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  )
}

/** Pretty-print tool inputs stored as JSON strings; fall back to the raw text. */
function displayContent(m: SessionMessage): string {
  const text = m.content ?? ''
  if (m.kind !== 'tool_use') return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
