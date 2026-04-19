// pages/MonitoringPage.jsx — Enterprise-grade monitoring for thousands of agents
// Architecture:
//  • Fleet overview section: aggregated KPI cards + time-series charts
//  • Virtualized device list: only renders ~20 visible rows at a time
//  • Collapsed-by-default rows with expand-on-click for full metrics
//  • 5s polling with delta-merge (only updates changed entries)
//  • useMemo everywhere to avoid re-renders on unchanged data
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Activity, Cpu, HardDrive, Wifi, Clock, RefreshCw,
  AlertTriangle, CheckCircle2, Monitor, Search, Server,
  ArrowDown, ArrowUp, ChevronDown, ChevronUp, MemoryStick,
  Zap, Filter, LayoutGrid, AlignJustify, TrendingUp,
  TrendingDown, Circle, Layers, Eye,
} from 'lucide-react'
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar as RBar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Legend, ReferenceLine,
} from 'recharts'
import api from '../lib/api'
import { useThemeStore } from '../store/themeStore'

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtUptime = s => {
  if (!s) return '—'
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}
const fmtBytes = b => {
  if (!b || b < 0) return '0 B/s'
  if (b < 1024) return `${b.toFixed(0)} B/s`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB/s`
  return `${(b / 1048576).toFixed(1)} MB/s`
}
const fmtMB = mb => !mb ? '—' : mb < 1024 ? `${mb.toFixed(0)} MB` : `${(mb / 1024).toFixed(1)} GB`
const fmtGB = gb => gb == null ? '—' : gb < 1 ? `${(gb * 1024).toFixed(0)} MB` : `${gb.toFixed(1)} GB`
const secAgo = ts => ts ? Math.floor(Date.now() / 1000) - ts : null
const isStale = (ts, s = 45) => { const a = secAgo(ts); return a === null || a > s }
const pct = (u, t) => t ? Math.round((u / t) * 100) : 0

const cpuColor  = v => !v && v !== 0 ? '#475569' : v >= 90 ? '#f87171' : v >= 70 ? '#fb923c' : v >= 50 ? '#facc15' : '#34d399'
const ramColor  = p => p >= 90 ? '#f87171' : p >= 75 ? '#fb923c' : p >= 55 ? '#facc15' : '#818cf8'
const diskColor = p => p >= 90 ? '#f87171' : p >= 80 ? '#fb923c' : p >= 70 ? '#facc15' : '#34d399'
const statusColor = s => ({ online: '#34d399', offline: '#f87171', unknown: '#475569' }[s] || '#475569')

// ─── Tiny components ──────────────────────────────────────────────────────────
function Bar({ value, color, h = 4 }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height: h, background: 'rgba(255,255,255,0.07)' }}>
      <div className="h-full rounded-full transition-all duration-700"
        style={{ width: `${Math.min(100, Math.max(0, value || 0))}%`, background: color }} />
    </div>
  )
}

function Gauge({ value, color, size = 60, label }) {
  const r = size / 2 - 6, circ = 2 * Math.PI * r
  const pctVal = Math.min(100, Math.max(0, value || 0))
  const dash = (pctVal / 100) * circ
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="5" />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="5"
            strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.8s ease' }} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono font-bold" style={{ color, fontSize: 11 }}>
            {value == null ? '—' : `${Math.round(pctVal)}%`}
          </span>
        </div>
      </div>
      {label && <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>{label}</span>}
    </div>
  )
}

function SparkLine({ data, color, height = 28 }) {
  if (!data || data.length < 2) return <div style={{ height }} />
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 1, right: 0, left: 0, bottom: 1 }}>
        <defs>
          <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
          fill={`url(#sg-${color.replace('#', '')})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#0a0a14', border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 8, padding: '8px 12px', fontSize: 11, fontFamily: 'monospace',
    }}>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>
          {p.name}: <strong>{typeof p.value === 'number' ? p.value.toFixed(1) : p.value}{p.unit || '%'}</strong>
        </div>
      ))}
    </div>
  )
}

// ─── Fleet Overview Charts ────────────────────────────────────────────────────
function FleetCharts({ devices, metrics }) {
  // Build 20-point fleet time series by averaging last N history points
  const fleetSeries = useMemo(() => {
    const LEN = 20
    const series = Array.from({ length: LEN }, (_, i) => ({ t: i, cpu: null, ram: null, net: null, count: 0 }))

    for (const [, entry] of Object.entries(metrics)) {
      const hist = entry.history || []
      if (!hist.length) continue
      // Sample evenly from history into LEN buckets
      for (let i = 0; i < LEN; i++) {
        const srcIdx = Math.floor((i / LEN) * hist.length)
        const snap = hist[srcIdx]
        if (!snap) continue
        if (snap.cpu != null)  { series[i].cpu = (series[i].cpu || 0) + snap.cpu;  series[i].count++ }
        if (snap.ram)          { series[i].ram = (series[i].ram || 0) + pct(snap.ram.used, snap.ram.total) }
        if (snap.network?.rxSec) { series[i].net = (series[i].net || 0) + snap.network.rxSec / 1024 }
      }
    }
    return series.map(s => ({
      t: s.t,
      cpu: s.count ? Math.round(s.cpu / s.count * 10) / 10 : null,
      ram: s.count ? Math.round(s.ram / s.count) : null,
      net: Math.round((s.net || 0) * 10) / 10,
    }))
  }, [metrics])

  // OS breakdown for bar chart
  const osCounts = useMemo(() => {
    const counts = { Linux: 0, Windows: 0, Unknown: 0 }
    for (const d of devices) {
      if (d.os_type === 'linux') counts.Linux++
      else if (d.os_type === 'windows') counts.Windows++
      else counts.Unknown++
    }
    return Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => ({ name: k, value: v }))
  }, [devices])

  // Status breakdown
  const statusCounts = useMemo(() => ({
    online:  devices.filter(d => d.status === 'online').length,
    offline: devices.filter(d => d.status === 'offline').length,
    unknown: devices.filter(d => !d.status || d.status === 'unknown').length,
  }), [devices])

  // CPU distribution histogram buckets (0-20, 20-40, 40-60, 60-80, 80-100)
  const cpuDist = useMemo(() => {
    const buckets = [
      { range: '0–20%',  count: 0, color: '#34d399' },
      { range: '20–40%', count: 0, color: '#86efac' },
      { range: '40–60%', count: 0, color: '#facc15' },
      { range: '60–80%', count: 0, color: '#fb923c' },
      { range: '80–100%',count: 0, color: '#f87171' },
    ]
    for (const [, entry] of Object.entries(metrics)) {
      const cpu = entry.latest?.cpu
      if (cpu == null) continue
      const idx = Math.min(4, Math.floor(cpu / 20))
      buckets[idx].count++
    }
    return buckets
  }, [metrics])

  const reporting = Object.values(metrics).filter(m => m.latest && !isStale(m.latest.ts)).length

  if (devices.length === 0) return null

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Fleet CPU + RAM trend */}
      <div className="lg:col-span-2 glass rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <TrendingUp size={14} style={{ color: '#818cf8' }} />
            <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-primary)' }}>
              Fleet CPU & RAM — {reporting} reporting agents
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] flex items-center gap-1" style={{ color: '#818cf8' }}>
              <span className="inline-block w-3 h-0.5 rounded" style={{ background: '#818cf8' }} /> CPU
            </span>
            <span className="text-[10px] flex items-center gap-1" style={{ color: '#34d399' }}>
              <span className="inline-block w-3 h-0.5 rounded" style={{ background: '#34d399' }} /> RAM
            </span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={140}>
          <AreaChart data={fleetSeries} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <defs>
              <linearGradient id="fcpu" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#818cf8" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#818cf8" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="fram" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" stopOpacity={0.2} />
                <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
            <XAxis dataKey="t" hide />
            <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} />
            <ReferenceLine y={80} stroke="#f87171" strokeDasharray="4 4" strokeOpacity={0.4} />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="cpu" name="CPU" unit="%" stroke="#818cf8" strokeWidth={2}
              fill="url(#fcpu)" dot={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="ram" name="RAM" unit="%" stroke="#34d399" strokeWidth={2}
              fill="url(#fram)" dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* CPU Distribution histogram */}
      <div className="glass rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Cpu size={14} style={{ color: '#fb923c' }} />
          <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-primary)' }}>CPU Load Distribution</span>
        </div>
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={cpuDist} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
            <XAxis dataKey="range" tick={{ fontSize: 8, fill: '#475569' }} tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: '#475569' }} tickLine={false} axisLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <RBar dataKey="count" name="Devices" radius={[3, 3, 0, 0]} maxBarSize={32}
              isAnimationActive={false}
              fill="#818cf8"
              label={false}>
              {cpuDist.map((entry, index) => (
                <rect key={index} fill={entry.color} />
              ))}
            </RBar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Virtualized list row (collapsed) ────────────────────────────────────────
// Renders a single compact row per device — expandable for full detail
const DeviceRow = React.memo(function DeviceRow({ device, metrics, expanded, onToggle }) {
  const m    = metrics?.latest
  const hist = metrics?.history || []
  const stale = !m || isStale(m.ts)
  const active = device.status === 'online' && !stale

  const cpuVal  = m?.cpu ?? null
  const ramPct  = m?.ram ? pct(m.ram.used, m.ram.total) : null
  const diskPct = m?.disk?.[0]?.use ?? null
  const ago     = m ? secAgo(m.ts) : null

  const cc = cpuColor(cpuVal)
  const rc = ramColor(ramPct)
  const dc = diskColor(diskPct)

  const cpuHist = useMemo(() =>
    hist.map((h, i) => ({ i, v: h.cpu })).filter(h => h.v != null).slice(-60),
  [hist])
  const ramHist = useMemo(() =>
    hist.map((h, i) => ({ i, v: h.ram ? pct(h.ram.used, h.ram.total) : null })).filter(h => h.v != null).slice(-60),
  [hist])
  const netHist = useMemo(() =>
    hist.map((h, i) => ({ i, v: (h.network?.rxSec || 0) / 1024 })).slice(-60),
  [hist])

  const statusDot = active ? '#34d399' : device.status === 'online' ? '#facc15' : '#f87171'
  const statusGlow = active ? '0 0 6px #34d39966' : 'none'

  return (
    <div
      className="rounded-xl overflow-hidden transition-all duration-200"
      style={{
        border: `1px solid ${active ? 'rgba(52,211,153,0.18)' : 'var(--border-subtle)'}`,
        background: 'var(--bg-card)',
        marginBottom: 6,
      }}
    >
      {/* ── Collapsed row ── */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none group"
        onClick={onToggle}
      >
        {/* Status dot */}
        <div className="w-2 h-2 rounded-full shrink-0 transition-all"
          style={{ background: statusDot, boxShadow: statusGlow }} />

        {/* OS badge */}
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono shrink-0 font-bold
          ${device.os_type === 'windows' ? 'bg-sky-400/10 text-sky-400' : 'bg-violet-400/10 text-violet-400'}`}>
          {device.os_type === 'windows' ? 'WIN' : 'LNX'}
        </span>

        {/* Name + IP */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-body font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {device.name}
          </p>
          <p className="text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>{device.ip_address}</p>
        </div>

        {/* Inline metrics — visible on md+ */}
        {active ? (
          <div className="hidden md:flex items-center gap-4 shrink-0">
            {/* CPU gauge + spark */}
            <div className="flex items-center gap-2 w-[110px]">
              <div className="flex-1">
                <div className="flex justify-between mb-1">
                  <span className="text-[9px] font-bold uppercase" style={{ color: 'var(--text-faint)' }}>CPU</span>
                  <span className="text-[10px] font-mono font-bold" style={{ color: cc }}>{cpuVal?.toFixed(1)}%</span>
                </div>
                <Bar value={cpuVal} color={cc} h={3} />
              </div>
              <div style={{ width: 40 }}>
                <SparkLine data={cpuHist.map(h => ({ v: h.v }))} color={cc} height={20} />
              </div>
            </div>

            {/* RAM */}
            <div className="flex items-center gap-2 w-[90px]">
              <div className="flex-1">
                <div className="flex justify-between mb-1">
                  <span className="text-[9px] font-bold uppercase" style={{ color: 'var(--text-faint)' }}>RAM</span>
                  <span className="text-[10px] font-mono font-bold" style={{ color: rc }}>{ramPct}%</span>
                </div>
                <Bar value={ramPct} color={rc} h={3} />
              </div>
            </div>

            {/* Disk */}
            <div className="hidden lg:flex items-center gap-2 w-[80px]">
              <div className="flex-1">
                <div className="flex justify-between mb-1">
                  <span className="text-[9px] font-bold uppercase" style={{ color: 'var(--text-faint)' }}>DISK</span>
                  <span className="text-[10px] font-mono font-bold" style={{ color: dc }}>{diskPct?.toFixed(0)}%</span>
                </div>
                <Bar value={diskPct} color={dc} h={3} />
              </div>
            </div>

            {/* Network RX */}
            <div className="hidden xl:flex items-center gap-2 w-[80px]">
              <div className="flex-1">
                <span className="text-[9px] font-bold uppercase" style={{ color: 'var(--text-faint)' }}>NET RX</span>
                <p className="text-[10px] font-mono font-bold" style={{ color: '#38bdf8' }}>
                  {fmtBytes(m?.network?.rxSec)}
                </p>
              </div>
            </div>

            {/* Uptime */}
            <div className="hidden xl:block w-[60px]">
              <span className="text-[9px] font-bold uppercase" style={{ color: 'var(--text-faint)' }}>UP</span>
              <p className="text-[10px] font-mono" style={{ color: 'var(--text-secondary)' }}>{fmtUptime(m?.uptime)}</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-body px-2 py-0.5 rounded-full"
              style={{
                background: device.status === 'online' ? 'rgba(250,204,21,0.10)' : 'rgba(248,113,113,0.10)',
                color: device.status === 'online' ? '#facc15' : '#f87171',
                border: `1px solid ${device.status === 'online' ? 'rgba(250,204,21,0.25)' : 'rgba(248,113,113,0.25)'}`,
              }}>
              {device.status === 'online' ? 'No agent data' : device.status || 'Unknown'}
            </span>
          </div>
        )}

        {/* Freshness */}
        {ago != null && (
          <span className="text-[9px] font-mono shrink-0 hidden lg:block w-8 text-right"
            style={{ color: ago < 10 ? '#34d399' : ago < 30 ? '#facc15' : '#f87171' }}>
            {ago < 5 ? 'live' : `${ago}s`}
          </span>
        )}

        {/* Expand chevron */}
        <div className="ml-1 p-1 rounded-lg transition-colors group-hover:bg-white/5 shrink-0"
          style={{ color: 'var(--text-muted)' }}>
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </div>
      </div>

      {/* ── Expanded detail panel ── */}
      {expanded && (
        <div className="px-4 pb-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {(!m || stale) ? (
            <div className="py-10 flex flex-col items-center gap-2" style={{ opacity: 0.4 }}>
              <Activity size={22} style={{ color: 'var(--text-muted)' }} />
              <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>
                {device.status !== 'online' ? 'Device is offline' : 'Waiting for agent metrics…'}
              </p>
            </div>
          ) : (
            <div className="pt-3 space-y-4">
              {/* System info strip */}
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {m.hostname && <span className="text-[11px] font-mono" style={{ color: 'var(--text-secondary)' }}>{m.hostname}</span>}
                {m.os       && <span className="text-[11px] font-body"  style={{ color: 'var(--text-muted)' }}>{m.os}</span>}
                {m.uptime   && <span className="text-[11px] font-body"  style={{ color: 'var(--text-muted)' }}>Uptime: {fmtUptime(m.uptime)}</span>}
                {m.network  && <span className="text-[11px] font-mono"  style={{ color: 'var(--text-muted)' }}>
                  ↓ {fmtBytes(m.network.rxSec)} ↑ {fmtBytes(m.network.txSec)}
                </span>}
              </div>

              {/* 4-metric grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

                {/* CPU */}
                <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <Cpu size={11} style={{ color: cc }} />
                      <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>CPU</span>
                    </div>
                    <Gauge value={cpuVal} color={cc} size={44} />
                  </div>
                  <Bar value={cpuVal} color={cc} h={4} />
                  <div className="mt-2" style={{ height: 48 }}>
                    {cpuHist.length > 3 && (
                      <ResponsiveContainer width="100%" height={48}>
                        <AreaChart data={cpuHist} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id={`cg-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={cc} stopOpacity={0.35} />
                              <stop offset="100%" stopColor={cc} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <ReferenceLine y={80} stroke="#f87171" strokeDasharray="3 3" strokeOpacity={0.5} />
                          <Area type="monotone" dataKey="v" stroke={cc} strokeWidth={1.5}
                            fill={`url(#cg-${device.id})`} dot={false} isAnimationActive={false} />
                          <Tooltip content={<CustomTooltip />} />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>

                {/* RAM */}
                <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <MemoryStick size={11} style={{ color: rc }} />
                      <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>RAM</span>
                    </div>
                    <Gauge value={ramPct} color={rc} size={44} />
                  </div>
                  <Bar value={ramPct} color={rc} h={4} />
                  <div className="flex justify-between mt-1">
                    <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>{fmtMB(m.ram?.used)}</span>
                    <span className="text-[9px] font-mono" style={{ color: 'var(--text-faint)' }}>/{fmtMB(m.ram?.total)}</span>
                  </div>
                  <div className="mt-2" style={{ height: 40 }}>
                    {ramHist.length > 3 && (
                      <ResponsiveContainer width="100%" height={40}>
                        <AreaChart data={ramHist} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id={`rg-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={rc} stopOpacity={0.35} />
                              <stop offset="100%" stopColor={rc} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <Area type="monotone" dataKey="v" stroke={rc} strokeWidth={1.5}
                            fill={`url(#rg-${device.id})`} dot={false} isAnimationActive={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>

                {/* Disk */}
                <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                  <div className="flex items-center gap-1.5 mb-3">
                    <HardDrive size={11} style={{ color: '#818cf8' }} />
                    <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Disk</span>
                  </div>
                  {(m.disk || []).slice(0, 4).map((d, i) => (
                    <div key={i} className="mb-2.5 last:mb-0">
                      <div className="flex justify-between mb-1">
                        <span className="text-[9px] font-mono truncate" style={{ color: 'var(--text-secondary)', maxWidth: 60 }}>{d.mount}</span>
                        <span className="text-[9px] font-mono font-bold" style={{ color: diskColor(d.use) }}>{d.use?.toFixed(0)}%</span>
                      </div>
                      <Bar value={d.use} color={diskColor(d.use)} h={4} />
                      <div className="flex justify-between mt-0.5">
                        <span className="text-[8px] font-mono" style={{ color: 'var(--text-faint)' }}>{fmtGB(d.used)}</span>
                        <span className="text-[8px] font-mono" style={{ color: 'var(--text-faint)' }}>{fmtGB(d.total)}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Network */}
                <div className="rounded-xl p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                  <div className="flex items-center gap-1.5 mb-3">
                    <Wifi size={11} style={{ color: '#38bdf8' }} />
                    <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Network</span>
                  </div>
                  <div className="space-y-2 mb-3">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-1">
                        <ArrowDown size={9} style={{ color: '#34d399' }} />
                        <span className="text-[9px] font-body" style={{ color: 'var(--text-muted)' }}>RX</span>
                      </div>
                      <span className="text-[10px] font-mono font-bold" style={{ color: '#34d399' }}>
                        {fmtBytes(m.network?.rxSec)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-1">
                        <ArrowUp size={9} style={{ color: '#fb923c' }} />
                        <span className="text-[9px] font-body" style={{ color: 'var(--text-muted)' }}>TX</span>
                      </div>
                      <span className="text-[10px] font-mono font-bold" style={{ color: '#fb923c' }}>
                        {fmtBytes(m.network?.txSec)}
                      </span>
                    </div>
                  </div>
                  <div style={{ height: 48 }}>
                    {netHist.length > 3 && (
                      <ResponsiveContainer width="100%" height={48}>
                        <AreaChart data={netHist} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id={`ng-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.3} />
                              <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <Area type="monotone" dataKey="v" stroke="#38bdf8" strokeWidth={1.5}
                            fill={`url(#ng-${device.id})`} dot={false} isAnimationActive={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              </div>

              {/* Top processes */}
              {m.processes?.length > 0 && (
                <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
                  <div className="grid px-3 py-2 text-[9px] font-bold uppercase tracking-wider"
                    style={{ gridTemplateColumns: '48px 1fr 56px 56px', background: 'var(--bg-input)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-faint)' }}>
                    <span>PID</span><span>Process</span><span className="text-right">CPU</span><span className="text-right">MEM</span>
                  </div>
                  {m.processes.slice(0, 8).map((p, i) => (
                    <div key={i} className="grid px-3 py-1.5 items-center"
                      style={{ gridTemplateColumns: '48px 1fr 56px 56px', borderBottom: i < m.processes.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                      <span className="text-[9px] font-mono" style={{ color: 'var(--text-faint)' }}>{p.pid}</span>
                      <span className="text-[11px] font-mono truncate" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                      <span className="text-[9px] font-mono text-right font-bold" style={{ color: cpuColor(p.cpu) }}>{(p.cpu || 0).toFixed(1)}%</span>
                      <span className="text-[9px] font-mono text-right" style={{ color: 'var(--text-muted)' }}>{(p.mem || 0).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ─── Virtual scroll container ─────────────────────────────────────────────────
// Renders only visible rows + a buffer of 5 above/below. Each row is ~48px collapsed.
// When expanded, we fall back to showing all — expansion is rare (1-2 at a time).
const ROW_HEIGHT = 58 // approximate collapsed row height px

function VirtualList({ items, metrics, expanded, onToggle }) {
  const containerRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(800)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const anyExpanded = expanded.size > 0

  // If any rows are expanded, skip virtualization (expanded rows have variable height)
  if (anyExpanded) {
    return (
      <div>
        {items.map(d => (
          <DeviceRow key={d.id} device={d} metrics={metrics[d.id]}
            expanded={expanded.has(d.id)} onToggle={() => onToggle(d.id)} />
        ))}
      </div>
    )
  }

  // Pure virtualization for collapsed rows only
  const totalHeight = items.length * ROW_HEIGHT
  const BUFFER = 5
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER)
  const endIdx   = Math.min(items.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + BUFFER)
  const visible  = items.slice(startIdx, endIdx)

  return (
    <div
      ref={containerRef}
      onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      style={{ height: Math.min(totalHeight, 600), overflowY: 'auto', position: 'relative' }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: startIdx * ROW_HEIGHT, left: 0, right: 0 }}>
          {visible.map(d => (
            <DeviceRow key={d.id} device={d} metrics={metrics[d.id]}
              expanded={false} onToggle={() => onToggle(d.id)} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── KPI strip ────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color, icon: Icon, onClick, active }) {
  return (
    <button
      onClick={onClick}
      className={`glass rounded-2xl p-4 text-left transition-all ${onClick ? 'cursor-pointer hover:scale-[1.015]' : 'cursor-default'}`}
      style={active ? { borderColor: color, boxShadow: `0 0 0 1px ${color}40` } : {}}
    >
      <div className="flex items-start justify-between mb-2">
        <Icon size={14} style={{ color }} />
        <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <p className="text-2xl font-display font-bold leading-none" style={{ color }}>{value}</p>
      {sub && <p className="text-[10px] font-body mt-1" style={{ color: 'var(--text-faint)' }}>{sub}</p>}
    </button>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function MonitoringPage() {
  const [devices,      setDevices]      = useState([])
  const [groups,       setGroups]       = useState([])
  const [metrics,      setMetrics]      = useState({})
  const [expanded,     setExpanded]     = useState(new Set())
  const [search,       setSearch]       = useState('')
  const [filterGroup,  setFilterGroup]  = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [sortBy,       setSortBy]       = useState('name') // 'name' | 'cpu' | 'ram' | 'status'
  const [loading,      setLoading]      = useState(true)
  const [refreshing,   setRefreshing]   = useState(false)
  const [lastRefresh,  setLastRefresh]  = useState(null)
  const { theme } = useThemeStore()
  const isLight = theme === 'light'

  // Delta-merge metrics: only update entries that changed
  const metricsRef = useRef({})
  const mergeMetrics = useCallback((incoming) => {
    const prev   = metricsRef.current
    const merged = { ...prev }
    let changed  = false
    for (const [id, entry] of Object.entries(incoming)) {
      const prevTs = prev[id]?.latest?.ts
      const newTs  = entry?.latest?.ts
      if (newTs !== prevTs) {
        merged[id] = entry
        changed = true
      }
    }
    if (changed) {
      metricsRef.current = merged
      setMetrics(merged)
    }
  }, [])

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true)
    try {
      const [d, g, m] = await Promise.all([
        api.get('/devices'),
        api.get('/groups'),
        api.get('/metrics'),
      ])
      setDevices(d.data || [])
      setGroups(g.data || [])
      mergeMetrics(m.data || {})
      setLastRefresh(Date.now())
    } catch {
      // silent fail on poll
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [mergeMetrics])

  useEffect(() => { load() }, [load])

  // 5s quiet poll for metrics only
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const { data } = await api.get('/metrics')
        mergeMetrics(data || {})
        setLastRefresh(Date.now())
      } catch {}
    }, 5000)
    return () => clearInterval(t)
  }, [mergeMetrics])

  const toggle = useCallback(id => {
    setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  // Aggregated stats
  const reporting = useMemo(() =>
    Object.values(metrics).filter(m => m.latest && !isStale(m.latest.ts)).length,
  [metrics])

  const avgCpu = useMemo(() => {
    const v = Object.values(metrics).map(m => m.latest?.cpu).filter(x => x != null)
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null
  }, [metrics])

  const avgRam = useMemo(() => {
    const v = Object.values(metrics)
      .map(m => m.latest?.ram ? pct(m.latest.ram.used, m.latest.ram.total) : null)
      .filter(x => x != null)
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null
  }, [metrics])

  const criticalDevices = useMemo(() =>
    Object.entries(metrics).filter(([, m]) => {
      const cpu = m.latest?.cpu
      const rp  = m.latest?.ram ? pct(m.latest.ram.used, m.latest.ram.total) : null
      return (cpu != null && cpu >= 90) || (rp != null && rp >= 90)
    }).length,
  [metrics])

  // Filtered + sorted list
  const filtered = useMemo(() => {
    let list = devices.filter(d => {
      if (search && !d.name.toLowerCase().includes(search.toLowerCase()) && !d.ip_address.includes(search)) return false
      if (filterGroup !== 'all' && String(d.group_id) !== filterGroup) return false
      if (filterStatus === 'online'    && d.status !== 'online') return false
      if (filterStatus === 'offline'   && d.status !== 'offline') return false
      if (filterStatus === 'reporting' && (!metrics[d.id]?.latest || isStale(metrics[d.id].latest.ts))) return false
      if (filterStatus === 'critical') {
        const m = metrics[d.id]?.latest
        const cpu = m?.cpu, rp = m?.ram ? pct(m.ram.used, m.ram.total) : null
        if (!((cpu != null && cpu >= 90) || (rp != null && rp >= 90))) return false
      }
      return true
    })

    // Sort
    list = [...list].sort((a, b) => {
      if (sortBy === 'cpu') {
        const ca = metrics[a.id]?.latest?.cpu ?? -1
        const cb = metrics[b.id]?.latest?.cpu ?? -1
        return cb - ca
      }
      if (sortBy === 'ram') {
        const ra = metrics[a.id]?.latest?.ram ? pct(metrics[a.id].latest.ram.used, metrics[a.id].latest.ram.total) : -1
        const rb = metrics[b.id]?.latest?.ram ? pct(metrics[b.id].latest.ram.used, metrics[b.id].latest.ram.total) : -1
        return rb - ra
      }
      if (sortBy === 'status') {
        const sv = s => s === 'online' ? 0 : s === 'offline' ? 2 : 1
        return sv(a.status) - sv(b.status)
      }
      return a.name.localeCompare(b.name)
    })

    return list
  }, [devices, search, filterGroup, filterStatus, sortBy, metrics])

  if (loading) return (
    <div className="flex items-center justify-center" style={{ minHeight: '60vh' }}>
      <div className="flex flex-col items-center gap-3">
        <Activity size={28} className="animate-pulse" style={{ color: '#818cf8' }} />
        <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>Loading monitoring…</p>
      </div>
    </div>
  )

  return (
    <div className="p-6 space-y-5 animate-fade-in max-w-[1600px] mx-auto pb-10">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0
            ${isLight ? 'bg-[#6c5ce7] text-white' : 'bg-brand-500/20 border border-brand-500/30 text-brand-400'}`}>
            <Activity size={18} />
          </div>
          <div>
            <h1 className="text-xl font-display font-bold" style={{ color: 'var(--text-primary)' }}>
              Live Monitoring
            </h1>
            <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
              Real-time agent metrics · {reporting}/{devices.length} reporting · 5s refresh
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>
              Updated {new Date(lastRefresh).toLocaleTimeString()}
            </span>
          )}
          <button onClick={() => load(true)} disabled={refreshing} className="icon-btn" title="Refresh">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Total Devices" value={devices.length} color="var(--text-secondary)"
          icon={Server} sub={`${groups.length} groups`} />
        <KpiCard label="Online" value={devices.filter(d => d.status === 'online').length}
          color="#34d399" icon={CheckCircle2}
          onClick={() => setFilterStatus(s => s === 'online' ? 'all' : 'online')}
          active={filterStatus === 'online'} />
        <KpiCard label="Offline" value={devices.filter(d => d.status === 'offline').length}
          color="#f87171" icon={AlertTriangle}
          onClick={() => setFilterStatus(s => s === 'offline' ? 'all' : 'offline')}
          active={filterStatus === 'offline'} />
        <KpiCard label="Reporting" value={reporting} color="#818cf8" icon={Activity}
          onClick={() => setFilterStatus(s => s === 'reporting' ? 'all' : 'reporting')}
          active={filterStatus === 'reporting'} sub="Agent active" />
        <KpiCard label="Avg CPU" value={avgCpu != null ? `${avgCpu}%` : '—'}
          color={cpuColor(avgCpu)} icon={Cpu}
          sub={avgRam != null ? `RAM avg ${avgRam}%` : undefined} />
        <KpiCard label="Critical" value={criticalDevices} color={criticalDevices > 0 ? '#f87171' : '#34d399'}
          icon={criticalDevices > 0 ? AlertTriangle : CheckCircle2}
          onClick={() => setFilterStatus(s => s === 'critical' ? 'all' : 'critical')}
          active={filterStatus === 'critical'} sub=">90% CPU or RAM" />
      </div>

      {/* ── Fleet charts ── */}
      {reporting > 0 && <FleetCharts devices={devices} metrics={metrics} />}

      {/* ── Filters + Sort ── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search size={11} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search devices…" className="input-field pl-8 py-1.5 text-xs h-8" />
        </div>

        {/* Group filter */}
        <select value={filterGroup} onChange={e => setFilterGroup(e.target.value)}
          className="input-field text-xs h-8 py-0" style={{ minWidth: 130 }}>
          <option value="all">All groups</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>

        {/* Status chips */}
        <div className="flex gap-1">
          {['all', 'online', 'offline', 'reporting', 'critical'].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={`chip h-8 px-2.5 text-xs capitalize ${filterStatus === s ? 'chip-selected' : ''}`}>
              {s}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[10px] font-body" style={{ color: 'var(--text-faint)' }}>Sort:</span>
          {[['name', 'Name'], ['cpu', 'CPU'], ['ram', 'RAM'], ['status', 'Status']].map(([k, l]) => (
            <button key={k} onClick={() => setSortBy(k)}
              className={`text-[10px] px-2 py-1 rounded-lg font-body font-medium transition-all
                ${sortBy === k ? 'bg-brand-500/15 text-brand-400 border border-brand-500/25' : 'text-slate-500 hover:text-slate-300'}`}>
              {l}
            </button>
          ))}
        </div>

        {/* Expand / collapse all */}
        <button
          onClick={() => setExpanded(expanded.size > 0 ? new Set() : new Set(filtered.map(d => d.id)))}
          className="btn-ghost text-xs py-1 px-2.5 h-8 flex items-center gap-1.5">
          <Eye size={11} />
          {expanded.size > 0 ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {/* ── Device list ── */}
      {filtered.length === 0 ? (
        <div className="glass rounded-2xl p-12 flex flex-col items-center gap-2" style={{ opacity: 0.5 }}>
          <Monitor size={24} style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>No devices match your filters</p>
        </div>
      ) : (
        <>
          {/* Column headers */}
          <div className="hidden md:grid px-4 py-1.5 text-[9px] font-bold uppercase tracking-widest rounded-lg"
            style={{
              gridTemplateColumns: 'auto auto 1fr 110px 90px 80px 80px auto auto',
              gap: '0 12px',
              color: 'var(--text-faint)',
              background: 'var(--bg-input)',
              border: '1px solid var(--border-subtle)',
            }}>
            <span />
            <span />
            <span>Device</span>
            <span>CPU</span>
            <span>RAM</span>
            <span className="hidden lg:block">Disk</span>
            <span className="hidden xl:block">Net RX</span>
            <span className="hidden xl:block">Uptime</span>
            <span className="hidden lg:block">Age</span>
          </div>

          <VirtualList
            items={filtered}
            metrics={metrics}
            expanded={expanded}
            onToggle={toggle}
          />

          <p className="text-center text-[10px] font-body" style={{ color: 'var(--text-faint)' }}>
            Showing {filtered.length} of {devices.length} devices · {reporting} reporting agents · auto-updates every 5s
          </p>
        </>
      )}
    </div>
  )
}
