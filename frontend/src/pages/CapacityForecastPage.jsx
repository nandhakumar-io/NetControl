// pages/CapacityForecastPage.jsx — "this disk will hit 100% in ~9 days".
//
// services/capacityForecast.js, routes/capacityForecast.js, and the
// capacity_forecast_notices migration were fully built server-side (plus a
// periodic check that pages admins through the same bell/web-push pipeline
// as regular alerts — see webPush's `url: '/capacity'`, which is why this
// page lives at that exact path). This covers the list view (every device,
// soonest-to-fill first, disk or RAM) with search/group/status filtering,
// a configurable lookback window, CSV export, per-row expand showing the
// daily-average history a trend was fit on plus a fill-progress gauge, and
// a "Run command" quick action that deep-links into Bulk Command with the
// device preselected — so a device that's about to fill up is one click
// from actually doing something about it.
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  TrendingUp, RefreshCw, Loader2, ChevronDown, ChevronRight, HardDrive, MemoryStick,
  AlertTriangle, CheckCircle2, TrendingDown, Minus, HelpCircle, Search, Download,
  TerminalSquare, Layers,
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine,
  ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'

const STATUS_CFG = {
  rising:             { color: '#f87171', icon: TrendingUp,   label: 'Rising' },
  stable:             { color: '#60a5fa', icon: Minus,        label: 'Stable' },
  falling:            { color: '#34d399', icon: TrendingDown, label: 'Falling' },
  no_data:            { color: '#94a3b8', icon: HelpCircle,   label: 'No Data' },
  insufficient_data:  { color: '#94a3b8', icon: HelpCircle,   label: 'Insufficient Data' },
  error:              { color: '#94a3b8', icon: HelpCircle,   label: 'Error' },
}

const LOOKBACK_OPTIONS = [
  { value: 7,  label: '7d' },
  { value: 14, label: '14d' },
  { value: 30, label: '30d' },
  { value: 60, label: '60d' },
]

function StatusPill({ status }) {
  const c = STATUS_CFG[status] || STATUS_CFG.no_data
  const Icon = c.icon
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-body font-semibold"
      style={{ color: c.color, background: `${c.color}18`, border: `1px solid ${c.color}35` }}>
      <Icon size={11} /> {c.label}
    </span>
  )
}

function fmtDays(d) {
  if (d == null) return '—'
  if (d < 1) return '< 1 day'
  const rounded = Math.round(d)
  return `~${rounded} day${rounded === 1 ? '' : 's'}`
}
function fmtDate(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Builds a single chart-ready series from the daily-average history a
// trend was fit on, plus a dashed continuation of that same trend line out
// to the projected fill point (or a short fixed horizon if not rising) —
// so the chart shows both what actually happened and where it's headed. ──
function buildTrendSeries(f) {
  const hist = f.history || []
  if (!hist.length) return []
  const points = hist.map(h => ({ ts: h.ts, actual: h.pct, projected: null }))
  const last = hist[hist.length - 1]
  points[points.length - 1] = { ...points[points.length - 1], projected: last.pct } // connects the two lines with no gap

  if (f.status === 'rising' && f.slope_per_day) {
    const DAY = 86400
    const horizonDays = Math.max(1, Math.min(f.days_to_full != null ? Math.ceil(f.days_to_full) + 2 : 7, 45))
    for (let i = 1; i <= horizonDays; i++) {
      const projPct = last.pct + f.slope_per_day * i
      points.push({ ts: last.ts + i * DAY, actual: null, projected: Math.round(Math.min(105, projPct) * 10) / 10 })
      if (projPct >= 100) break
    }
  }
  return points
}

function TrendTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const p = payload.find(p => p.dataKey === 'actual' && p.value != null) || payload.find(p => p.dataKey === 'projected' && p.value != null)
  if (!p) return null
  const isProjected = p.dataKey === 'projected'
  return (
    <div style={{ background: 'rgba(6,6,18,0.98)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', padding: '7px 11px' }}>
      <div style={{ color: 'var(--text-faint)' }}>{new Date(p.payload.ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
      <div style={{ color: isProjected ? '#fbbf24' : '#6c5ce7' }}>
        {isProjected ? 'Projected: ' : 'Actual: '}<strong>{p.value}%</strong>
      </div>
    </div>
  )
}

// ── Real trend chart: solid area for actual history, dashed line
// continuing the fitted trend out to the projected fill date, with a
// reference line at 100% so it's visually obvious what "full" means. ──────
function TrendChart({ f }) {
  const data = useMemo(() => buildTrendSeries(f), [f])
  if (!data.length) return <p className="text-xs font-body py-6 text-center" style={{ color: 'var(--text-muted)' }}>No history in this window.</p>

  const lineColor = f.status === 'rising' ? '#f87171' : f.status === 'falling' ? '#34d399' : '#6c5ce7'

  return (
    <div>
      <ResponsiveContainer width="100%" height={150}>
        <AreaChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id={`cf-actual-${f.device_id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={0.28} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis dataKey="ts" tickFormatter={t => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} width={30} />
          <Tooltip content={<TrendTooltip />} />
          <ReferenceLine y={100} stroke="rgba(248,113,113,0.4)" strokeDasharray="3 3" label={{ value: 'Full', position: 'insideTopRight', fill: '#f87171', fontSize: 9 }} />
          <Area type="monotone" dataKey="actual" name="Actual" stroke={lineColor} strokeWidth={2} fill={`url(#cf-actual-${f.device_id})`} dot={false} isAnimationActive={false} connectNulls />
          <Area type="monotone" dataKey="projected" name="Projected" stroke="#fbbf24" strokeWidth={1.5} strokeDasharray="4 3" fill="transparent" dot={false} isAnimationActive={false} connectNulls />
        </AreaChart>
      </ResponsiveContainer>
      {f.status === 'rising' && (
        <div className="flex items-center gap-3 justify-center mt-1">
          <span className="flex items-center gap-1 text-[10px] font-mono" style={{ color: lineColor }}>
            <span className="inline-block w-3 h-px" style={{ background: lineColor }} /> Actual
          </span>
          <span className="flex items-center gap-1 text-[10px] font-mono" style={{ color: '#fbbf24' }}>
            <span className="inline-block w-3 h-px border-t border-dashed" style={{ borderColor: '#fbbf24' }} /> Projected
          </span>
        </div>
      )}
    </div>
  )
}

// ── Overview: horizontal bar chart of the devices closest to filling up,
// so the urgency is visible at a glance instead of only in the list below.
function SoonestToFillChart({ forecasts, thresholds, metric }) {
  const top = useMemo(() => {
    return forecasts
      .filter(f => f.status === 'rising' && f.days_to_full != null)
      .sort((a, b) => a.days_to_full - b.days_to_full)
      .slice(0, 8)
      .map(f => ({
        name: f.device_name.length > 18 ? f.device_name.slice(0, 17) + '…' : f.device_name,
        fullName: f.device_name,
        days: Math.round(f.days_to_full * 10) / 10,
        critical: f.days_to_full <= thresholds.criticalDays,
        warning: f.days_to_full <= thresholds.warningDays,
      }))
      .reverse() // so the soonest-to-fill renders at the top of the vertical bar chart
  }, [forecasts, thresholds])

  if (!top.length) {
    return (
      <div className="card flex flex-col items-center justify-center py-8 gap-2">
        <CheckCircle2 size={22} style={{ color: 'var(--text-faint)' }} />
        <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>No devices are currently trending toward full.</p>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        {metric === 'disk' ? <HardDrive size={13} style={{ color: 'var(--text-muted)' }} /> : <MemoryStick size={13} style={{ color: 'var(--text-muted)' }} />}
        <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-primary)' }}>Soonest to fill</span>
      </div>
      <ResponsiveContainer width="100%" height={Math.max(160, top.length * 34)}>
        <BarChart data={top} layout="vertical" margin={{ top: 4, right: 24, left: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false}
            label={{ value: 'days to full', position: 'insideBottomRight', fill: '#475569', fontSize: 9, dy: 10 }} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={110} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const d = payload[0].payload
              return (
                <div style={{ background: 'rgba(6,6,18,0.98)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', padding: '7px 11px' }}>
                  <div style={{ color: 'var(--text-primary)' }}>{d.fullName}</div>
                  <div style={{ color: d.critical ? '#f87171' : d.warning ? '#fbbf24' : '#6c5ce7' }}>~{d.days} day{d.days === 1 ? '' : 's'} to full</div>
                </div>
              )
            }}
          />
          <Bar dataKey="days" radius={[0, 4, 4, 0]} barSize={16}>
            {top.map((d, i) => (
              <Cell key={i} fill={d.critical ? '#f87171' : d.warning ? '#fbbf24' : '#6c5ce7'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Fill-progress gauge — current % now, with a marker for where the
// trend line was fit from, colored by the same warning/critical
// thresholds the backend notifier actually pages on ─────────────────────
function ProjectionGauge({ f, thresholds }) {
  if (f.current_pct == null) return null
  const pct = Math.min(100, Math.max(0, f.current_pct))
  const isCritical = f.status === 'rising' && f.days_to_full != null && f.days_to_full <= thresholds.criticalDays
  const isWarning  = f.status === 'rising' && f.days_to_full != null && f.days_to_full <= thresholds.warningDays
  const fillColor = isCritical ? '#f87171' : isWarning ? '#fbbf24' : '#6c5ce7'

  return (
    <div className="space-y-1">
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-input)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: fillColor }} />
      </div>
      <div className="flex justify-between text-[10px] font-body" style={{ color: 'var(--text-faint)' }}>
        <span>{pct}% used now</span>
        <span>100%</span>
      </div>
    </div>
  )
}

function ForecastRow({ f, thresholds }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const hasProjection = f.status === 'rising' && f.days_to_full != null
  const isCritical = hasProjection && f.days_to_full <= thresholds.criticalDays

  const runCommand = (e) => {
    e.stopPropagation()
    navigate(`/bulk-command?deviceId=${f.device_id}`)
  }

  return (
    <div className="card p-0 overflow-hidden" style={isCritical ? { borderColor: 'rgba(248,113,113,0.35)' } : undefined}>
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.02]" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-body font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>{f.device_name}</span>
            <StatusPill status={f.status} />
          </div>
          <p className="text-xs font-body mt-0.5 font-mono" style={{ color: 'var(--text-muted)' }}>
            {f.device_ip} · {f.group_name || 'Ungrouped'}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-display" style={{ color: 'var(--text-primary)' }}>
            {f.current_pct != null ? `${f.current_pct}%` : '—'}
          </p>
          <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
            {f.slope_per_day != null ? `${f.slope_per_day > 0 ? '+' : ''}${f.slope_per_day}%/day` : ''}
          </p>
        </div>
        <div className="text-right shrink-0 w-28">
          <p className="text-sm font-body font-semibold" style={{ color: isCritical ? '#f87171' : 'var(--text-primary)' }}>
            {hasProjection ? fmtDays(f.days_to_full) : '—'}
          </p>
          <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
            {hasProjection ? fmtDate(f.projected_full_at) : ''}
          </p>
        </div>
        <button
          onClick={runCommand}
          title="Run a command on this device"
          className="btn-ghost text-xs px-2.5 py-1.5 flex items-center gap-1.5 shrink-0"
        >
          <TerminalSquare size={12} /> Run
        </button>
      </div>

      {open && (
        <div className="px-4 pb-4 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="pt-3 flex items-center justify-between text-xs font-body mb-2" style={{ color: 'var(--text-muted)' }}>
            <span>{f.sample_days ?? 0} day{f.sample_days === 1 ? '' : 's'} of data{f.r2 != null ? ` · R² ${f.r2}` : ''}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TrendChart f={f} />
            <div className="flex flex-col justify-center gap-3">
              <ProjectionGauge f={f} thresholds={thresholds} />
              {f.status === 'rising' && f.slope_per_day != null && (
                <p className="text-[11px] font-body" style={{ color: 'var(--text-faint)' }}>
                  Trending up {f.slope_per_day}%/day — at this rate it reaches 100% {f.days_to_full != null ? fmtDays(f.days_to_full).replace('~', 'in ~') : 'soon'}.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function toCsv(rows) {
  const header = ['Device', 'IP', 'Group', 'Status', 'Current %', '%/day', 'Days to full', 'Projected full date']
  const lines = rows.map(f => [
    f.device_name, f.device_ip, f.group_name || 'Ungrouped', f.status,
    f.current_pct ?? '', f.slope_per_day ?? '', f.days_to_full ?? '',
    f.projected_full_at ? fmtDate(f.projected_full_at) : '',
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
  return [header.join(','), ...lines].join('\n')
}

export default function CapacityForecastPage() {
  const [metric, setMetric] = useState('disk')
  const [lookbackDays, setLookbackDays] = useState(14)
  const [forecasts, setForecasts] = useState([])
  const [thresholds, setThresholds] = useState({ warningDays: 7, criticalDays: 2 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all') // all | rising | critical
  const [sortBy, setSortBy] = useState('soonest')          // soonest | name | pct
  const [autoRefresh, setAutoRefresh] = useState(false)
  const pollRef = useRef(null)

  // Thresholds rarely change (they're an env-configured constant), so one
  // fetch on mount is plenty — no need to refetch alongside every forecast load.
  useEffect(() => {
    api.get('/capacity-forecast/config/thresholds')
      .then(({ data }) => setThresholds(data))
      .catch(() => { /* fall back to the defaults above if this fails */ })
  }, [])

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setRefreshing(true) : setLoading(true)
    try {
      const { data } = await api.get('/capacity-forecast', { params: { metric, lookbackDays } })
      setForecasts(data)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load capacity forecast')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [metric, lookbackDays])

  useEffect(() => { load() }, [load])

  // ── Auto-refresh toggle — polls every 60s while enabled ──────────────────
  useEffect(() => {
    if (!autoRefresh) { clearInterval(pollRef.current); return }
    pollRef.current = setInterval(() => load(true), 60000)
    return () => clearInterval(pollRef.current)
  }, [autoRefresh, load])

  const groups = useMemo(() => {
    const map = new Map()
    for (const f of forecasts) map.set(f.group_id || 'ungrouped', f.group_name || 'Ungrouped')
    return [...map.entries()]
  }, [forecasts])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = forecasts.filter(f => {
      if (groupFilter !== 'all' && (f.group_id || 'ungrouped') !== groupFilter) return false
      if (statusFilter === 'rising' && f.status !== 'rising') return false
      if (statusFilter === 'critical' && !(f.status === 'rising' && f.days_to_full != null && f.days_to_full <= thresholds.criticalDays)) return false
      if (!q) return true
      return f.device_name.toLowerCase().includes(q) || f.device_ip?.toLowerCase().includes(q)
    })

    rows = [...rows].sort((a, b) => {
      if (sortBy === 'name') return a.device_name.localeCompare(b.device_name)
      if (sortBy === 'pct') return (b.current_pct ?? -1) - (a.current_pct ?? -1)
      return (a.days_to_full ?? Infinity) - (b.days_to_full ?? Infinity) // soonest
    })
    return rows
  }, [forecasts, search, groupFilter, statusFilter, sortBy, thresholds])

  const exportCsv = () => {
    if (!filtered.length) { toast.error('Nothing to export'); return }
    const blob = new Blob([toCsv(filtered)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `capacity-forecast-${metric}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const critical = forecasts.filter(f => f.status === 'rising' && f.days_to_full != null && f.days_to_full <= thresholds.criticalDays).length
  const warning  = forecasts.filter(f => f.status === 'rising' && f.days_to_full != null && f.days_to_full > thresholds.criticalDays && f.days_to_full <= thresholds.warningDays).length
  const rising   = forecasts.filter(f => f.status === 'rising').length

  return (
    <div>
      <PageHeader
        icon={TrendingUp}
        title="Capacity Forecast"
        description="Disk and RAM usage trends, projected forward to see what's about to fill up."
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex rounded-lg border p-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
              <button
                onClick={() => setMetric('disk')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-body font-semibold transition-colors"
                style={metric === 'disk'
                  ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
                  : { color: 'var(--text-muted)' }}
              >
                <HardDrive size={13} /> Disk
              </button>
              <button
                onClick={() => setMetric('ram')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-body font-semibold transition-colors"
                style={metric === 'ram'
                  ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
                  : { color: 'var(--text-muted)' }}
              >
                <MemoryStick size={13} /> RAM
              </button>
            </div>
            <select
              value={lookbackDays}
              onChange={e => setLookbackDays(Number(e.target.value))}
              className="input-field py-1.5 text-xs w-20"
              title="Lookback window"
            >
              {LOOKBACK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button
              onClick={() => setAutoRefresh(a => !a)}
              className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5"
              style={autoRefresh ? { color: '#6c5ce7' } : undefined}
              title="Auto-refresh every 60s"
            >
              <Layers size={13} /> Auto {autoRefresh ? 'on' : 'off'}
            </button>
            <button onClick={exportCsv} className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5">
              <Download size={13} /> Export CSV
            </button>
            <button onClick={() => load(true)} className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5">
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4 mb-6">
        <div className="grid grid-cols-2 gap-4 content-start">
          <StatCard icon={AlertTriangle} label={`Critical (≤${thresholds.criticalDays}d)`} value={critical}
            iconColor="text-accent-red" iconBg="bg-accent-red/10 border-accent-red/25" />
          <StatCard icon={TrendingUp} label={`Warning (≤${thresholds.warningDays}d)`} value={warning}
            iconColor="text-accent-yellow" iconBg="bg-accent-yellow/10 border-accent-yellow/25" />
          <StatCard icon={TrendingUp} label="Rising" value={rising}
            iconColor="text-accent-yellow" iconBg="bg-accent-yellow/10 border-accent-yellow/25" />
          <StatCard icon={CheckCircle2} label="Devices Tracked" value={forecasts.length}
            iconColor="text-brand-400" iconBg="bg-brand-500/10 border-brand-500/25" />
        </div>
        <SoonestToFillChart forecasts={forecasts} thresholds={thresholds} metric={metric} />
      </div>

      <div className="card p-3 mb-4 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-faint)' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search devices…"
            className="input-field pl-8 py-2 text-sm"
          />
        </div>
        <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)} className="input-field py-2 text-sm w-36 shrink-0">
          <option value="all">All groups</option>
          {groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="input-field py-2 text-sm w-36 shrink-0">
          <option value="all">All statuses</option>
          <option value="rising">Rising only</option>
          <option value="critical">Critical only</option>
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="input-field py-2 text-sm w-40 shrink-0">
          <option value="soonest">Sort: Soonest to fill</option>
          <option value="name">Sort: Device name</option>
          <option value="pct">Sort: Current usage</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
      ) : forecasts.length === 0 ? (
        <div className="card text-center py-12">
          <TrendingUp size={28} className="mx-auto mb-3" style={{ color: 'var(--text-faint)' }} />
          <p className="font-body text-sm" style={{ color: 'var(--text-muted)' }}>No devices to forecast yet — metrics need a few days of history before a trend can be fit.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-12">
          <Search size={28} className="mx-auto mb-3" style={{ color: 'var(--text-faint)' }} />
          <p className="font-body text-sm" style={{ color: 'var(--text-muted)' }}>No devices match your filters.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(f => <ForecastRow key={f.device_id} f={f} thresholds={thresholds} />)}
        </div>
      )}
    </div>
  )
}