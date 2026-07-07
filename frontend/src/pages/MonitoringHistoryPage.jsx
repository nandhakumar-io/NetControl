// pages/MonitoringHistoryPage.jsx
//
// Long-term metrics view for a single device — backed by the durable
// `metrics_history` table (60s buckets, retained ~13 months, see
// backend/db/migrate-metrics-history.js) rather than the ~25-min in-memory
// ring buffer the live Monitoring page uses. Lets you:
//   - Pick a lookback window (1h/24h/7d/30d) or a fully custom date range
//   - Compare that window against a previous period / last week / last
//     month / another custom range, overlaid on the same charts
//   - Export the underlying data as CSV for either range
//
// Kept as its own route/page (not a tab bolted onto MonitoringPage) so the
// live dashboard stays fast and uncluttered, and this page can afford
// heavier date-range UI without competing for space with the live view.
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowLeft, Download, RefreshCw, Cpu, MemoryStick, HardDrive, Network,
  ArrowDown, ArrowUp, ChevronDown, GitCompare, X, Calendar, Server, Users,
} from 'lucide-react'
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts'
import api from '../lib/api'

// ─── Helpers ──────────────────────────────────────────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000)
const round1 = v => (v == null ? null : Math.round(v * 10) / 10)
const fmtBps = b => {
  if (b == null) return '—'
  if (b < 1024) return `${b.toFixed(0)} B/s`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB/s`
  return `${(b / 1048576).toFixed(1)} MB/s`
}
const toEpoch = (localDateTimeStr) => {
  if (!localDateTimeStr) return null
  const t = new Date(localDateTimeStr).getTime()
  return Number.isNaN(t) ? null : Math.floor(t / 1000)
}
const toLocalInput = (epochSec) => {
  const d = new Date(epochSec * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtElapsed = (sec, span) => {
  if (span <= 3 * 3600) return `${Math.round(sec / 60)}m`
  if (span <= 2 * 86400) return `${(sec / 3600).toFixed(1)}h`
  return `${(sec / 86400).toFixed(1)}d`
}
const fmtRangeLabel = (from, to) => {
  const d1 = new Date(from * 1000), d2 = new Date(to * 1000)
  const sameDay = d1.toDateString() === d2.toDateString()
  const opts = { month: 'short', day: 'numeric' }
  return sameDay
    ? `${d1.toLocaleDateString([], opts)}, ${d1.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${d2.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : `${d1.toLocaleDateString([], opts)} – ${d2.toLocaleDateString([], opts)}`
}

const RANGE_PRESETS = [
  { key: '1h', label: '1H', span: 3600 },
  { key: '24h', label: '24H', span: 86400 },
  { key: '7d', label: '7D', span: 7 * 86400 },
  { key: '30d', label: '30D', span: 30 * 86400 },
  { key: '90d', label: '90D', span: 90 * 86400 },
  { key: '1y', label: '1Y', span: 365 * 86400 },
]
const COMPARE_PRESETS = [
  { key: 'previous', label: 'Previous period' },
  { key: 'last_week', label: 'Same time, last week' },
  { key: 'last_month', label: 'Same time, last month' },
  { key: 'custom', label: 'Custom range' },
]

const COLOR_A = { cpu: '#a78bfa', ram: '#06b6d4', disk: '#22c55e', rx: '#22c55e', tx: '#f97316' }
const COLOR_B = '#64748b'

// ─── Small primitives ─────────────────────────────────────────────────────────
function RangeChip({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={`chip h-8 px-3 text-xs ${active ? 'chip-selected' : ''}`}>
      {children}
    </button>
  )
}

function StatBlock({ icon: Icon, color, label, avg, max, unit = '%', deltaAvg }) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={11} style={{ color }} />
        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <p className="text-lg font-display font-bold leading-none" style={{ color }}>
          {avg == null ? '—' : `${round1(avg)}${unit}`}
        </p>
        {deltaAvg != null && (
          <span className="text-[10px] font-mono font-bold flex items-center gap-0.5"
            style={{ color: deltaAvg > 0 ? '#ef4444' : deltaAvg < 0 ? '#22c55e' : 'var(--text-faint)' }}>
            {deltaAvg > 0 ? <ArrowUp size={9} /> : deltaAvg < 0 ? <ArrowDown size={9} /> : null}
            {Math.abs(deltaAvg).toFixed(1)}{unit}
          </span>
        )}
      </div>
      <p className="text-[9px] font-mono mt-0.5" style={{ color: 'var(--text-faint)' }}>
        peak {max == null ? '—' : `${round1(max)}${unit}`}
      </p>
    </div>
  )
}

function HistoryTooltip({ active, payload, unit = '%' }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'rgba(6,6,18,0.98)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', padding: '8px 12px' }}>
      {payload.map((p, i) => p.value != null && (
        <div key={i} style={{ color: p.color }}>
          {p.name}: <strong>{round1(p.value)}{unit}</strong>
        </div>
      ))}
    </div>
  )
}

// ─── Metric chart (with optional overlay of compare series) ──────────────────
function MetricChart({ title, icon: Icon, color, data, aKey, bKey, compareOn, unit = '%', height = 180 }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon size={13} style={{ color }} />
          <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
        </div>
        {compareOn && (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 text-[9px] font-mono" style={{ color }}>
              <span className="inline-block w-3 h-px" style={{ background: color }} /> Current
            </span>
            <span className="flex items-center gap-1 text-[9px] font-mono" style={{ color: COLOR_B }}>
              <span className="inline-block w-3 h-px border-t border-dashed" style={{ borderColor: COLOR_B }} /> Compare
            </span>
          </div>
        )}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id={`hg-${aKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis dataKey="elapsed" tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} width={30} />
          <Tooltip content={<HistoryTooltip unit={unit} />} />
          <Area type="monotone" dataKey={aKey} name="Current" stroke={color} strokeWidth={2} fill={`url(#hg-${aKey})`} dot={false} isAnimationActive={false} connectNulls />
          {compareOn && (
            <Area type="monotone" dataKey={bKey} name="Compare" stroke={COLOR_B} strokeWidth={1.5} strokeDasharray="4 3" fill="transparent" dot={false} isAnimationActive={false} connectNulls />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MonitoringHistoryPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceId] = useState(searchParams.get('device') || '')
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)

  // 'device' = single-device history (original view), 'group' = combined
  // trend across every device in a group, using the group history endpoints
  // that were already built into the backend (see routes/metrics.js) but
  // not yet surfaced anywhere in the UI.
  const [viewMode, setViewMode] = useState(searchParams.get('mode') === 'group' ? 'group' : 'device')
  const [groups, setGroups] = useState([])
  const [groupId, setGroupId] = useState(searchParams.get('group') || '')
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const [groupDevicesSummary, setGroupDevicesSummary] = useState([])

  const [range, setRange] = useState('24h') // '1h'|'24h'|'7d'|'30d'|'custom'
  const [customFrom, setCustomFrom] = useState(toLocalInput(nowSec() - 86400))
  const [customTo, setCustomTo] = useState(toLocalInput(nowSec()))

  const [compareOn, setCompareOn] = useState(false)
  const [comparePreset, setComparePreset] = useState('previous')
  const [compareFromInput, setCompareFromInput] = useState('')
  const [compareToInput, setCompareToInput] = useState('')
  const [compareMenuOpen, setCompareMenuOpen] = useState(false)

  const [rowsA, setRowsA] = useState([])
  const [rowsB, setRowsB] = useState([])
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(null) // 'A' | 'B' | null

  // Load device list once, default to the first device if none was passed in
  useEffect(() => {
    api.get('/devices').then(({ data }) => {
      setDevices(data || [])
      if (!deviceId && data?.length) {
        setDeviceId(data[0].id)
        setSearchParams(prev => { prev.set('device', data[0].id); return prev }, { replace: true })
      }
    }).catch(() => toast.error('Failed to load devices'))
    api.get('/groups').then(({ data }) => {
      setGroups(data || [])
      if (!groupId && data?.length) setGroupId(data[0].id)
    }).catch(() => toast.error('Failed to load groups'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedDevice = useMemo(() => devices.find(d => d.id === deviceId) || null, [devices, deviceId])
  const selectedGroup = useMemo(() => groups.find(g => g.id === groupId) || null, [groups, groupId])

  const rangeAB = useMemo(() => {
    let fromA, toA
    if (range === 'custom') {
      fromA = toEpoch(customFrom); toA = toEpoch(customTo)
      if (fromA == null || toA == null || fromA >= toA) { fromA = nowSec() - 86400; toA = nowSec() }
    } else {
      const preset = RANGE_PRESETS.find(r => r.key === range) || RANGE_PRESETS[1]
      toA = nowSec(); fromA = toA - preset.span
    }
    const spanA = toA - fromA

    let fromB = null, toB = null
    if (compareOn) {
      if (comparePreset === 'previous')      { fromB = fromA - spanA; toB = fromA }
      else if (comparePreset === 'last_week') { fromB = fromA - 7 * 86400; toB = toA - 7 * 86400 }
      else if (comparePreset === 'last_month') { fromB = fromA - 30 * 86400; toB = toA - 30 * 86400 }
      else if (comparePreset === 'custom') {
        fromB = toEpoch(compareFromInput); toB = toEpoch(compareToInput)
        if (fromB == null || toB == null || fromB >= toB) { fromB = fromA - spanA; toB = fromA }
      }
    }
    return { fromA, toA, spanA, fromB, toB }
  }, [range, customFrom, customTo, compareOn, comparePreset, compareFromInput, compareToInput])

  const fetchHistory = useCallback(async (id, from, to) => {
    const { data } = await api.get(`/metrics/${id}/history`, { params: { from, to } })
    return data?.points || []
  }, [])

  const fetchGroupHistory = useCallback(async (id, from, to) => {
    const { data } = await api.get(`/metrics/group/${id}/history`, { params: { from, to } })
    return data
  }, [])

  const load = useCallback(async () => {
    const activeId = viewMode === 'group' ? groupId : deviceId
    if (!activeId) return
    setLoading(true)
    try {
      const { fromA, toA, fromB, toB } = rangeAB
      if (viewMode === 'group') {
        const [a, b] = await Promise.all([
          fetchGroupHistory(groupId, fromA, toA),
          compareOn && fromB != null ? fetchGroupHistory(groupId, fromB, toB) : Promise.resolve(null),
        ])
        setRowsA(a?.points || [])
        setRowsB(b?.points || [])
        setGroupDevicesSummary(a?.devices || [])
      } else {
        const [a, b] = await Promise.all([
          fetchHistory(deviceId, fromA, toA),
          compareOn && fromB != null ? fetchHistory(deviceId, fromB, toB) : Promise.resolve([]),
        ])
        setRowsA(a)
        setRowsB(b)
        setGroupDevicesSummary([])
      }
    } catch (e) {
      toast.error(`Failed to load ${viewMode === 'group' ? 'group' : 'metrics'} history`)
    } finally {
      setLoading(false)
    }
  }, [viewMode, deviceId, groupId, rangeAB, compareOn, fetchHistory, fetchGroupHistory])

  useEffect(() => { load() }, [load])

  // Keep ?mode=/?device=/?group= in the URL in sync so the link is shareable / refreshable
  useEffect(() => {
    setSearchParams(prev => {
      prev.set('mode', viewMode)
      if (viewMode === 'group') { if (groupId) prev.set('group', groupId) }
      else { if (deviceId) prev.set('device', deviceId) }
      return prev
    }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, deviceId, groupId])

  // Merge series A/B by index (both queries cover equal-length spans so
  // bucket counts line up) into one chart-friendly array per metric.
  const merged = useMemo(() => {
    const { fromA, spanA } = rangeAB
    const len = Math.max(rowsA.length, rowsB.length)
    const out = []
    for (let i = 0; i < len; i++) {
      const a = rowsA[i], b = rowsB[i]
      const elapsedSec = a ? a.ts - fromA : (rangeAB.fromB != null ? (b.ts - rangeAB.fromB) : i)
      out.push({
        elapsed: fmtElapsed(elapsedSec, spanA),
        aTime: a ? new Date(a.ts * 1000).toLocaleString() : null,
        bTime: b ? new Date(b.ts * 1000).toLocaleString() : null,
        a_cpu: a?.cpu_avg ?? null, b_cpu: b?.cpu_avg ?? null,
        a_ram: a?.ram_avg ?? null, b_ram: b?.ram_avg ?? null,
        a_disk: a?.disk_avg ?? null, b_disk: b?.disk_avg ?? null,
        a_rx: a?.net_rx_avg ?? null, b_rx: b?.net_rx_avg ?? null,
        a_tx: a?.net_tx_avg ?? null, b_tx: b?.net_tx_avg ?? null,
      })
    }
    return out
  }, [rowsA, rowsB, rangeAB])

  const stats = useMemo(() => {
    const agg = (rows, key) => {
      const vals = rows.map(r => r[key]).filter(v => v != null)
      if (!vals.length) return { avg: null, max: null }
      return { avg: vals.reduce((s, v) => s + v, 0) / vals.length, max: Math.max(...vals) }
    }
    const maxAgg = (rows, key) => {
      const vals = rows.map(r => r[key]).filter(v => v != null)
      return vals.length ? Math.max(...vals) : null
    }
    return {
      cpu:  { ...agg(rowsA, 'cpu_avg'),  max: maxAgg(rowsA, 'cpu_max'),  b: agg(rowsB, 'cpu_avg') },
      ram:  { ...agg(rowsA, 'ram_avg'),  max: maxAgg(rowsA, 'ram_max'),  b: agg(rowsB, 'ram_avg') },
      disk: { ...agg(rowsA, 'disk_avg'), max: maxAgg(rowsA, 'disk_max'), b: agg(rowsB, 'disk_avg') },
      rx:   { ...agg(rowsA, 'net_rx_avg'), b: agg(rowsB, 'net_rx_avg') },
      tx:   { ...agg(rowsA, 'net_tx_avg'), b: agg(rowsB, 'net_tx_avg') },
    }
  }, [rowsA, rowsB])

  const doExport = async (which) => {
    const activeId = viewMode === 'group' ? groupId : deviceId
    if (!activeId) return
    setExporting(which)
    try {
      const from = which === 'A' ? rangeAB.fromA : rangeAB.fromB
      const to   = which === 'A' ? rangeAB.toA   : rangeAB.toB
      const path = viewMode === 'group' ? `/metrics/group/${groupId}/history/export` : `/metrics/${deviceId}/history/export`
      const res = await api.get(path, { params: { from, to }, responseType: 'blob' })
      const disposition = res.headers['content-disposition'] || ''
      const match = disposition.match(/filename="?([^"]+)"?/)
      const filename = match?.[1] || `netcontrol-metrics-${activeId}.csv`
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      toast.success('Metrics exported as CSV')
    } catch {
      toast.error('Export failed')
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="p-5 space-y-5 animate-fade-in max-w-[1600px] mx-auto pb-10">

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/monitoring')} className="icon-btn">
            <ArrowLeft size={14} />
          </button>
          <div>
            <h1 className="text-lg font-display font-bold" style={{ color: 'var(--text-primary)' }}>Metrics History</h1>
            <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {fmtRangeLabel(rangeAB.fromA, rangeAB.toA)}
              {compareOn && rangeAB.fromB != null && (
                <span className="opacity-60"> · vs {fmtRangeLabel(rangeAB.fromB, rangeAB.toB)}</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Device / Group view toggle */}
          <div className="flex items-center rounded-lg border p-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <button onClick={() => setViewMode('device')}
              className={`text-xs px-2.5 py-1 rounded-md font-body flex items-center gap-1.5 transition-colors ${viewMode === 'device' ? 'bg-brand-500/15 text-brand-400' : ''}`}
              style={viewMode !== 'device' ? { color: 'var(--text-muted)' } : undefined}>
              <Server size={11} /> Device
            </button>
            <button onClick={() => setViewMode('group')}
              className={`text-xs px-2.5 py-1 rounded-md font-body flex items-center gap-1.5 transition-colors ${viewMode === 'group' ? 'bg-brand-500/15 text-brand-400' : ''}`}
              style={viewMode !== 'group' ? { color: 'var(--text-muted)' } : undefined}>
              <Users size={11} /> Group
            </button>
          </div>

          {viewMode === 'group' ? (
            <div className="relative">
              <button onClick={() => setGroupMenuOpen(v => !v)}
                className="btn-ghost text-xs py-1.5 px-3 h-8 flex items-center gap-1.5">
                <Users size={12} />
                {selectedGroup ? `${selectedGroup.name} (${selectedGroup.device_count})` : 'Select group'}
                <ChevronDown size={12} className={`transition-transform ${groupMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {groupMenuOpen && (
                <div className="absolute right-0 mt-2 w-56 max-h-72 overflow-y-auto z-20 glass rounded-xl overflow-hidden animate-fade-in">
                  {groups.length === 0 && (
                    <p className="px-3.5 py-2 text-xs font-body" style={{ color: 'var(--text-muted)' }}>No groups yet</p>
                  )}
                  {groups.map(g => (
                    <button key={g.id}
                      onClick={() => { setGroupId(g.id); setGroupMenuOpen(false) }}
                      className="w-full flex items-center justify-between gap-2 px-3.5 py-2 text-xs font-body text-left transition-colors"
                      style={{ color: g.id === groupId ? 'var(--text-primary)' : 'var(--text-secondary)', background: g.id === groupId ? 'var(--bg-hover)' : 'transparent' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = g.id === groupId ? 'var(--bg-hover)' : 'transparent'}>
                      <span className="truncate">{g.name}</span>
                      <span className="text-[10px] font-mono opacity-60">{g.device_count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
          <div className="relative">
            <button onClick={() => setDeviceMenuOpen(v => !v)}
              className="btn-ghost text-xs py-1.5 px-3 h-8 flex items-center gap-1.5">
              <Server size={12} />
              {selectedDevice?.name || 'Select device'}
              <ChevronDown size={12} className={`transition-transform ${deviceMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {deviceMenuOpen && (
              <div className="absolute right-0 mt-2 w-56 max-h-72 overflow-y-auto z-20 glass rounded-xl overflow-hidden animate-fade-in">
                {devices.map(d => (
                  <button key={d.id}
                    onClick={() => { setDeviceId(d.id); setDeviceMenuOpen(false) }}
                    className="w-full flex items-center gap-2 px-3.5 py-2 text-xs font-body text-left transition-colors"
                    style={{ color: d.id === deviceId ? 'var(--text-primary)' : 'var(--text-secondary)', background: d.id === deviceId ? 'var(--bg-hover)' : 'transparent' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = d.id === deviceId ? 'var(--bg-hover)' : 'transparent'}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: d.status === 'online' ? '#22c55e' : '#ef4444' }} />
                    <span className="truncate">{d.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          )}

          <button onClick={() => load()} disabled={loading} className="icon-btn">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>

          <button onClick={() => doExport('A')} disabled={exporting !== null || (viewMode === 'group' ? !groupId : !deviceId)}
            className="btn-ghost text-xs py-1.5 px-3 h-8 flex items-center gap-1.5 disabled:opacity-50">
            {exporting === 'A' ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />}
            Export CSV
          </button>
        </div>
      </div>

      {/* Range + compare controls */}
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_PRESETS.map(r => (
          <RangeChip key={r.key} active={range === r.key} onClick={() => setRange(r.key)}>{r.label}</RangeChip>
        ))}
        <RangeChip active={range === 'custom'} onClick={() => setRange('custom')}>Custom</RangeChip>

        {range === 'custom' && (
          <div className="flex items-center gap-1.5 ml-1">
            <Calendar size={11} style={{ color: 'var(--text-faint)' }} />
            <input type="datetime-local" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
              className="input-field text-xs h-8 py-0" style={{ minWidth: 165 }} />
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>to</span>
            <input type="datetime-local" value={customTo} onChange={e => setCustomTo(e.target.value)}
              className="input-field text-xs h-8 py-0" style={{ minWidth: 165 }} />
          </div>
        )}

        <div className="w-px h-5 mx-1" style={{ background: 'var(--border-subtle)' }} />

        <button onClick={() => setCompareOn(v => !v)}
          className={`text-xs px-3 py-1.5 h-8 rounded-lg font-body transition-all flex items-center gap-1.5 ${compareOn ? 'bg-brand-500/15 text-brand-400 border border-brand-500/25' : 'btn-ghost'}`}>
          <GitCompare size={12} />
          Compare
        </button>

        {compareOn && (
          <>
            <div className="relative">
              <button onClick={() => setCompareMenuOpen(v => !v)} className="btn-ghost text-xs py-1.5 px-3 h-8 flex items-center gap-1.5">
                {COMPARE_PRESETS.find(p => p.key === comparePreset)?.label}
                <ChevronDown size={11} className={`transition-transform ${compareMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {compareMenuOpen && (
                <div className="absolute left-0 mt-2 w-52 z-20 glass rounded-xl overflow-hidden animate-fade-in">
                  {COMPARE_PRESETS.map(p => (
                    <button key={p.key} onClick={() => { setComparePreset(p.key); setCompareMenuOpen(false) }}
                      className="w-full px-3.5 py-2 text-xs font-body text-left transition-colors"
                      style={{ color: p.key === comparePreset ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {comparePreset === 'custom' && (
              <div className="flex items-center gap-1.5">
                <input type="datetime-local" value={compareFromInput} onChange={e => setCompareFromInput(e.target.value)}
                  className="input-field text-xs h-8 py-0" style={{ minWidth: 165 }} />
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>to</span>
                <input type="datetime-local" value={compareToInput} onChange={e => setCompareToInput(e.target.value)}
                  className="input-field text-xs h-8 py-0" style={{ minWidth: 165 }} />
              </div>
            )}

            <button onClick={() => doExport('B')} disabled={exporting !== null || rangeAB.fromB == null}
              className="text-[10px] font-mono px-2 py-1 rounded-lg flex items-center gap-1 disabled:opacity-40"
              style={{ color: 'var(--text-faint)' }}>
              {exporting === 'B' ? <RefreshCw size={11} className="animate-spin" /> : <Download size={11} />}
              export compare range
            </button>

            <button onClick={() => setCompareOn(false)} className="icon-btn !w-7 !h-7">
              <X size={12} />
            </button>
          </>
        )}
      </div>

      {loading && rowsA.length === 0 ? (
        <div className="flex items-center justify-center py-24">
          <RefreshCw size={20} className="animate-spin" style={{ color: '#a78bfa' }} />
        </div>
      ) : (viewMode === 'group' ? !groupId : !deviceId) ? (
        <div className="glass rounded-2xl p-12 flex flex-col items-center gap-2 opacity-50">
          {viewMode === 'group' ? <Users size={22} style={{ color: 'var(--text-muted)' }} /> : <Server size={22} style={{ color: 'var(--text-muted)' }} />}
          <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>No {viewMode} selected</p>
        </div>
      ) : rowsA.length === 0 ? (
        <div className="glass rounded-2xl p-12 flex flex-col items-center gap-2 opacity-50">
          <Calendar size={22} style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>No history data in this range yet</p>
          <p className="text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>History accumulates as the agent reports — check back once it's been running a while</p>
        </div>
      ) : (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatBlock icon={Cpu} color={COLOR_A.cpu} label="CPU" avg={stats.cpu.avg} max={stats.cpu.max}
              deltaAvg={compareOn && stats.cpu.b.avg != null ? stats.cpu.avg - stats.cpu.b.avg : null} />
            <StatBlock icon={MemoryStick} color={COLOR_A.ram} label="RAM" avg={stats.ram.avg} max={stats.ram.max}
              deltaAvg={compareOn && stats.ram.b.avg != null ? stats.ram.avg - stats.ram.b.avg : null} />
            <StatBlock icon={HardDrive} color={COLOR_A.disk} label="Disk" avg={stats.disk.avg} max={stats.disk.max}
              deltaAvg={compareOn && stats.disk.b.avg != null ? stats.disk.avg - stats.disk.b.avg : null} />
            <StatBlock icon={ArrowDown} color={COLOR_A.rx} label="Net RX" avg={stats.rx.avg} max={null} unit=" B/s" />
            <StatBlock icon={ArrowUp} color={COLOR_A.tx} label="Net TX" avg={stats.tx.avg} max={null} unit=" B/s" />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <MetricChart title="CPU usage" icon={Cpu} color={COLOR_A.cpu} data={merged} aKey="a_cpu" bKey="b_cpu" compareOn={compareOn} />
            <MetricChart title="RAM usage" icon={MemoryStick} color={COLOR_A.ram} data={merged} aKey="a_ram" bKey="b_ram" compareOn={compareOn} />
            <MetricChart title="Disk usage" icon={HardDrive} color={COLOR_A.disk} data={merged} aKey="a_disk" bKey="b_disk" compareOn={compareOn} />
            <div className="glass rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Network size={13} style={{ color: '#06b6d4' }} />
                <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-primary)' }}>Network I/O (avg)</span>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={merged} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="elapsed" tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} width={30}
                    tickFormatter={fmtBps} />
                  <Tooltip content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    return (
                      <div style={{ background: 'rgba(6,6,18,0.98)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', padding: '8px 12px' }}>
                        {payload.map((p, i) => p.value != null && (
                          <div key={i} style={{ color: p.color }}>{p.name}: <strong>{fmtBps(p.value)}</strong></div>
                        ))}
                      </div>
                    )
                  }} />
                  <Line type="monotone" dataKey="a_rx" name="RX" stroke={COLOR_A.rx} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="a_tx" name="TX" stroke={COLOR_A.tx} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                  {compareOn && (
                    <>
                      <Line type="monotone" dataKey="b_rx" name="RX (compare)" stroke={COLOR_B} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
                      <Line type="monotone" dataKey="b_tx" name="TX (compare)" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
                    </>
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {viewMode === 'group' && groupDevicesSummary.length > 0 && (
            <div className="glass rounded-2xl p-4 overflow-x-auto">
              <div className="flex items-center gap-2 mb-3">
                <Users size={13} style={{ color: '#a78bfa' }} />
                <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-primary)' }}>Per-device breakdown</span>
                <span className="text-[10px] font-mono opacity-50">avg / peak over this window</span>
              </div>
              <table className="w-full text-xs font-mono" style={{ minWidth: 560 }}>
                <thead>
                  <tr style={{ color: 'var(--text-faint)' }} className="text-[10px] uppercase tracking-wide">
                    <th className="text-left font-normal pb-2">Device</th>
                    <th className="text-right font-normal pb-2">CPU</th>
                    <th className="text-right font-normal pb-2">RAM</th>
                    <th className="text-right font-normal pb-2">Disk</th>
                    <th className="text-right font-normal pb-2">Net RX</th>
                    <th className="text-right font-normal pb-2">Net TX</th>
                  </tr>
                </thead>
                <tbody>
                  {groupDevicesSummary.map(d => (
                    <tr key={d.device_id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                      <td className="py-2 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: d.status === 'online' ? '#22c55e' : '#ef4444' }} />
                        <span style={{ color: 'var(--text-secondary)' }}>{d.name}</span>
                      </td>
                      <td className="text-right" style={{ color: COLOR_A.cpu }}>{d.cpu_avg == null ? '—' : `${round1(d.cpu_avg)}%`} <span className="opacity-50">/ {d.cpu_max == null ? '—' : `${round1(d.cpu_max)}%`}</span></td>
                      <td className="text-right" style={{ color: COLOR_A.ram }}>{d.ram_avg == null ? '—' : `${round1(d.ram_avg)}%`} <span className="opacity-50">/ {d.ram_max == null ? '—' : `${round1(d.ram_max)}%`}</span></td>
                      <td className="text-right" style={{ color: COLOR_A.disk }}>{d.disk_avg == null ? '—' : `${round1(d.disk_avg)}%`} <span className="opacity-50">/ {d.disk_max == null ? '—' : `${round1(d.disk_max)}%`}</span></td>
                      <td className="text-right" style={{ color: COLOR_A.rx }}>{fmtBps(d.net_rx_avg)}</td>
                      <td className="text-right" style={{ color: COLOR_A.tx }}>{fmtBps(d.net_tx_avg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-center text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>
            {rowsA.length} data point{rowsA.length === 1 ? '' : 's'} · sourced from durable metrics history (not the live 5s stream)
            {viewMode === 'group' && selectedGroup ? ` · combined across ${selectedGroup.device_count} device${selectedGroup.device_count === 1 ? '' : 's'} in "${selectedGroup.name}"` : ''}
          </p>
        </>
      )}
    </div>
  )
}