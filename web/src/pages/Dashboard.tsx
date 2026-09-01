import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Fragment, useMemo, useState } from 'react'
import { api, formatTokens, harnessLabel, timeAgo, TYPE_LABELS } from '../api'
import type { UsageBucket } from '../api'
import { HarnessMark } from '../components/HarnessIcon'

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

      <TokenUsage />

      <SessionHeatmap />

      <div className="panel-columns">
        <TopProjects />

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
    </div>
  )
}

/** The five busiest session projects of the trailing week, ranked by tokens across harnesses. */
function TopProjects() {
  const top = useQuery({ queryKey: ['top-projects'], queryFn: api.topProjects })
  const harnesses = useQuery({ queryKey: ['harnesses'], queryFn: api.harnesses })
  if (!top.data?.length) return null

  return (
    <section className="panel">
      <h2>Active projects · 7 days</h2>
      <ul className="top-projects">
        {top.data.map((p) => (
          <li key={p.path}>
            <div className="top-project-head">
              <span className="top-project-name">{p.name}</span>
              <span className="top-project-marks">
                {p.harnesses.map((h) => (
                  <HarnessMark key={h} id={h} harnesses={harnesses.data} />
                ))}
              </span>
              <span className="muted top-project-tokens" title={`${p.total_tokens.toLocaleString()} tokens`}>
                {formatTokens(p.total_tokens)}
              </span>
            </div>
            <div className="muted top-project-path" title={p.path}>
              {p.path}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const pad = (n: number) => String(n).padStart(2, '0')

const HOUR_MS = 3_600_000
const RANGE_LABELS = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' } as const
type RangeKey = keyof typeof RANGE_LABELS

interface UsageColumn {
  /** X-axis label; '' = unlabeled slot, minor = hidden on small screens. */
  label: string
  minor: boolean
  /** Tooltip heading, e.g. "Mon 31 Aug" or "14:00–15:00". */
  title: string
  byHarness: number[]
  total: number
}

/** Fold the server's hourly UTC buckets into viewer-local columns for one range. */
function buildColumns(data: UsageBucket[], range: RangeKey, series: string[]): UsageColumn[] {
  const seriesIndex = new Map(series.map((h, i) => [h, i]))
  const mk = (label: string, title: string, minor = false): UsageColumn => ({
    label,
    minor,
    title,
    byHarness: new Array<number>(series.length).fill(0),
    total: 0,
  })
  let cols: UsageColumn[]
  let indexOf: (t: number) => number
  if (range === '24h') {
    const start = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 23 * HOUR_MS
    cols = Array.from({ length: 24 }, (_, i) => {
      const h = new Date(start + i * HOUR_MS).getHours()
      return mk(h % 3 === 0 ? pad(h) : '', `${pad(h)}:00–${pad((h + 1) % 24)}:00`, h % 6 !== 0)
    })
    indexOf = (t) => (t - start) / HOUR_MS
  } else {
    const n = range === '7d' ? 7 : 30
    const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const keyToCol = new Map<string, number>()
    cols = Array.from({ length: n }, (_, i) => {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - (n - 1 - i))
      keyToCol.set(dayKey(d), i)
      const label =
        n === 7
          ? d.toLocaleDateString(undefined, { weekday: 'short' })
          : (n - 1 - i) % 6 === 0
            ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
            : ''
      return mk(label, d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))
    })
    indexOf = (t) => keyToCol.get(dayKey(new Date(t))) ?? -1
  }
  for (const b of data) {
    const i = indexOf(b.t)
    const s = seriesIndex.get(b.harness)
    if (Number.isInteger(i) && i >= 0 && i < cols.length && s !== undefined) {
      cols[i].byHarness[s] += b.tokens
      cols[i].total += b.tokens
    }
  }
  return cols
}

/** Round up to 1 / 2 / 2.5 / 5 × 10^k for clean axis figures. */
function niceCeil(v: number): number {
  if (v <= 0) return 1
  const pow = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * pow) return m * pow
  return 10 * pow
}

function TokenUsage() {
  const usage = useQuery({ queryKey: ['session-usage'], queryFn: api.sessionUsage })
  const harnesses = useQuery({ queryKey: ['harnesses'], queryFn: api.harnesses })
  const [range, setRange] = useState<RangeKey>('7d')
  const [hover, setHover] = useState<number | null>(null)

  // Series keep their 30-day order and seal shade across every range, so
  // switching a filter never repaints a harness.
  const series = useMemo(() => {
    const totals = new Map<string, number>()
    for (const b of usage.data ?? []) totals.set(b.harness, (totals.get(b.harness) ?? 0) + b.tokens)
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h)
  }, [usage.data])

  const cols = useMemo(
    () => (usage.data ? buildColumns(usage.data, range, series) : []),
    [usage.data, range, series],
  )
  if (!usage.data?.length || series.length === 0) return null

  // Deepest seal for the heaviest harness, spread evenly down to 46% —
  // the light end still clears the paper in both modes.
  const shade = (i: number) =>
    `color-mix(in srgb, var(--seal-ink) ${series.length === 1 ? 100 : Math.round(100 - (54 * i) / (series.length - 1))}%, var(--paper))`

  const windowTotals = series.map((_, s) => cols.reduce((sum, col) => sum + col.byHarness[s], 0))
  const windowTotal = windowTotals.reduce((a, b) => a + b, 0)
  const niceMax = niceCeil(Math.max(...cols.map((col) => col.total)))
  const peak = cols.reduce((best, col, i) => (col.total > cols[best].total ? i : best), 0)
  const label = (h: string) => harnessLabel(h, harnesses.data)
  const summary =
    `Token usage by harness, ${RANGE_LABELS[range]}: ` +
    (windowTotal === 0
      ? 'no usage recorded.'
      : `${formatTokens(windowTotal)} tokens total (${series
          .map((h, s) => `${label(h)} ${formatTokens(windowTotals[s])}`)
          .join(', ')}), peaking at ${formatTokens(cols[peak].total)} on ${cols[peak].title}.`)
  const tipAlign = hover === null ? '' : hover < cols.length / 4 ? ' usage-tip-left' : hover >= (cols.length * 3) / 4 ? ' usage-tip-right' : ''

  return (
    <section className="panel">
      <div className="usage-head">
        <h2>Token usage</h2>
        <div className="usage-ranges" role="group" aria-label="Usage time range">
          {(Object.keys(RANGE_LABELS) as RangeKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`usage-range${k === range ? ' active' : ''}`}
              aria-pressed={k === range}
              onClick={() => {
                setRange(k)
                setHover(null)
              }}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="usage-chart" role="img" aria-label={summary}>
        <div className="usage-plot" onPointerLeave={() => setHover(null)}>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <div key={f} className="usage-grid" style={{ bottom: `${f * 100}%` }}>
              {(f === 0.5 || f === 1) && windowTotal > 0 && <span>{formatTokens(niceMax * f)}</span>}
            </div>
          ))}
          {cols.map((col, i) => (
            <div key={`${range}-${i}`} className="usage-col" onPointerEnter={() => setHover(i)}>
              {series.map(
                (h, s) =>
                  col.byHarness[s] > 0 && (
                    <div
                      key={h}
                      className="usage-seg"
                      style={{ height: `${(col.byHarness[s] / niceMax) * 100}%`, background: shade(s) }}
                    />
                  ),
              )}
            </div>
          ))}
          {windowTotal === 0 && <p className="usage-empty">No usage in this window.</p>}
          {hover !== null && cols[hover] && cols[hover].total > 0 && (
            <div className={`usage-tip${tipAlign}`} style={{ left: `${((hover + 0.5) / cols.length) * 100}%` }}>
              <div className="usage-tip-head">{cols[hover].title}</div>
              {series.map(
                (h, s) =>
                  cols[hover].byHarness[s] > 0 && (
                    <div key={h} className="usage-tip-row">
                      <span className="usage-swatch" style={{ background: shade(s) }} />
                      <span className="usage-tip-val">{formatTokens(cols[hover].byHarness[s])}</span>
                      <span className="usage-tip-name">{label(h)}</span>
                    </div>
                  ),
              )}
              {cols[hover].byHarness.filter((v) => v > 0).length > 1 && (
                <div className="usage-tip-row usage-tip-total">
                  <span className="usage-swatch" />
                  <span className="usage-tip-val">{formatTokens(cols[hover].total)}</span>
                  <span className="usage-tip-name">total</span>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="usage-x">
          {cols.map((col, i) => (
            <span key={`${range}-${i}`} className={col.minor ? 'usage-x-minor' : undefined}>
              {col.label}
            </span>
          ))}
        </div>
      </div>
      <div className="usage-legend">
        <span className="usage-keys">
          {series.map((h, s) => (
            <span key={h} className="usage-key">
              <span className="usage-swatch" style={{ background: shade(s) }} />
              {label(h)} <span className="usage-key-figure">{formatTokens(windowTotals[s])}</span>
            </span>
          ))}
        </span>
        <span className="usage-key">
          Total <span className="usage-key-figure">{formatTokens(windowTotal)}</span>
        </span>
      </div>
    </section>
  )
}

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
