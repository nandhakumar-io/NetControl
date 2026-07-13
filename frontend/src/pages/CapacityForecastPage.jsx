// pages/CapacityForecastPage.jsx — "this disk will hit 100% in ~9 days".
//
// services/capacityForecast.js, routes/capacityForecast.js, and the
// capacity_forecast_notices migration were fully built server-side (plus a
// periodic check that pages admins through the same bell/web-push pipeline
// as regular alerts — see webPush's `url: '/capacity'`, which is why this
// page lives at that exact path) but had no frontend at all: no page, no
// nav entry, no route. This covers the list view (every device, soonest-
// to-fill first, disk or RAM) with a per-row expand showing the daily-
// average history the trend line was fit on.
import React, { useState, useEffect, useCallback } from 'react'
import {
  TrendingUp, RefreshCw, Loader2, ChevronDown, ChevronRight, HardDrive, MemoryStick,
  AlertTriangle, CheckCircle2, TrendingDown, Minus, HelpCircle,
} from 'lucide-react'
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

// ── Tiny bar-chart of the daily-average history a trend was fit on ─────────
function HistoryBars({ history }) {
  if (!history?.length) return <p className="text-xs font-body py-2" style={{ color: 'var(--text-muted)' }}>No history in this window.</p>
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-[3px] h-16">
        {history.map((h, i) => (
          <div key={i}
            title={`${new Date(h.ts * 1000).toLocaleDateString()} — ${h.pct}%`}
            className="flex-1 rounded-sm min-w-[4px]"
            style={{ height: `${Math.max(4, h.pct)}%`, background: h.pct >= 90 ? '#f87171' : h.pct >= 75 ? '#fbbf24' : '#6c5ce7' }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>
        <span>{new Date(history[0].ts * 1000).toLocaleDateString()}</span>
        <span>{new Date(history[history.length - 1].ts * 1000).toLocaleDateString()}</span>
      </div>
    </div>
  )
}

function ForecastRow({ f }) {
  const [open, setOpen] = useState(false)
  const hasProjection = f.status === 'rising' && f.days_to_full != null

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.02]" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-body font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>{f.device_name}</span>
            <StatusPill status={f.status} />
          </div>
          <p className="text-xs font-body mt-0.5 font-mono" style={{ color: 'var(--text-muted)' }}>{f.device_ip}</p>
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
          <p className="text-sm font-body font-semibold" style={{ color: hasProjection && f.days_to_full <= 2 ? '#f87171' : 'var(--text-primary)' }}>
            {hasProjection ? fmtDays(f.days_to_full) : '—'}
          </p>
          <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
            {hasProjection ? fmtDate(f.projected_full_at) : ''}
          </p>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="pt-3 flex items-center justify-between text-xs font-body mb-2" style={{ color: 'var(--text-muted)' }}>
            <span>{f.sample_days ?? 0} day{f.sample_days === 1 ? '' : 's'} of data{f.r2 != null ? ` · R² ${f.r2}` : ''}</span>
          </div>
          <HistoryBars history={f.history} />
        </div>
      )}
    </div>
  )
}

export default function CapacityForecastPage() {
  const [metric, setMetric] = useState('disk')
  const [forecasts, setForecasts] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setRefreshing(true) : setLoading(true)
    try {
      const { data } = await api.get('/capacity-forecast', { params: { metric, lookbackDays: 14 } })
      setForecasts(data)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load capacity forecast')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [metric])

  useEffect(() => { load() }, [load])

  const critical = forecasts.filter(f => f.status === 'rising' && f.days_to_full <= 2).length
  const warning  = forecasts.filter(f => f.status === 'rising' && f.days_to_full > 2 && f.days_to_full <= 7).length
  const rising   = forecasts.filter(f => f.status === 'rising').length

  return (
    <div>
      <PageHeader
        icon={TrendingUp}
        title="Capacity Forecast"
        description="Disk and RAM usage trends, projected forward to see what's about to fill up."
        actions={
          <div className="flex items-center gap-2">
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
            <button onClick={() => load(true)} className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5">
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <StatCard icon={AlertTriangle} label="Critical (≤2 days)" value={critical}
          iconColor="text-accent-red" iconBg="bg-accent-red/10 border-accent-red/25" />
        <StatCard icon={TrendingUp} label="Rising" value={rising}
          iconColor="text-accent-yellow" iconBg="bg-accent-yellow/10 border-accent-yellow/25" />
        <StatCard icon={CheckCircle2} label="Devices Tracked" value={forecasts.length}
          iconColor="text-brand-400" iconBg="bg-brand-500/10 border-brand-500/25" />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
      ) : forecasts.length === 0 ? (
        <div className="card text-center py-12">
          <TrendingUp size={28} className="mx-auto mb-3" style={{ color: 'var(--text-faint)' }} />
          <p className="font-body text-sm" style={{ color: 'var(--text-muted)' }}>No devices to forecast yet — metrics need a few days of history before a trend can be fit.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {forecasts.map(f => <ForecastRow key={f.device_id} f={f} />)}
        </div>
      )}
    </div>
  )
}