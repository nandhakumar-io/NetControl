import React, { useState, useEffect, useCallback } from 'react'
import {
  ListChecks, Zap, Power, RotateCcw, TerminalSquare, Upload,
  PackageCheck, Wrench, RefreshCw, Search, CheckCircle2, XCircle,
  AlertCircle, Clock
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import { format, formatDistanceToNow } from 'date-fns'

// ── Per-action icon/color, same palette Audit/Devices already use ───────────
const ACTION_META = {
  wake:                          { icon: Zap,            color: '#22c55e' },
  scheduled_wake:                { icon: Zap,            color: '#22c55e' },
  wake_relayed:                  { icon: Zap,            color: '#22c55e' },
  shutdown:                      { icon: Power,          color: '#f87171' },
  scheduled_shutdown:            { icon: Power,          color: '#f87171' },
  restart:                       { icon: RotateCcw,      color: '#fbbf24' },
  scheduled_restart:             { icon: RotateCcw,      color: '#fbbf24' },
  bulk_exec_command:             { icon: TerminalSquare, color: '#a78bfa' },
  bulk_import_devices:           { icon: Upload,         color: '#38bdf8' },
  bulk_agent_update_request:     { icon: PackageCheck,   color: '#38bdf8' },
  bulk_enable_maintenance_mode:  { icon: Wrench,         color: '#fb923c' },
  bulk_disable_maintenance_mode: { icon: Wrench,         color: '#fb923c' },
}

const FILTER_ACTIONS = [
  ['all', 'All'],
  ['wake', 'Wake'], ['shutdown', 'Shutdown'], ['restart', 'Restart'],
  ['bulk_exec_command', 'Bulk Command'],
  ['bulk_agent_update_request', 'Agent Update'],
]

function formatTime(ts) {
  try { return format(new Date(ts * 1000), 'dd MMM yyyy, HH:mm:ss') } catch { return '—' }
}
function timeAgo(ts) {
  try { return formatDistanceToNow(new Date(ts * 1000), { addSuffix: true }) } catch { return '' }
}

// A job is "partial" if it mixes success and failure (or has anything
// skipped) — this is derived client-side rather than trusting a single
// stored `result`, since a job is a rolled-up group of audit rows, not one
// row with one result column.
function jobStatus(job) {
  if (job.failure > 0 && job.success > 0) return 'partial'
  if (job.failure > 0) return 'failure'
  if (job.skipped > 0 && job.success === 0) return 'skipped'
  return 'success'
}

const STATUS_META = {
  success: { label: 'Success', icon: CheckCircle2, color: '#22c55e', bg: 'rgba(34,197,94,0.1)',  border: 'rgba(34,197,94,0.25)' },
  failure: { label: 'Failed',  icon: XCircle,       color: '#f87171', bg: 'rgba(239,68,68,0.1)',  border: 'rgba(239,68,68,0.25)' },
  partial: { label: 'Partial', icon: AlertCircle,   color: '#fbbf24', bg: 'rgba(251,191,36,0.1)', border: 'rgba(251,191,36,0.25)' },
  skipped: { label: 'Skipped', icon: AlertCircle,   color: '#94a3b8', bg: 'rgba(148,163,184,0.1)',border: 'rgba(148,163,184,0.25)' },
}

function JobRow({ job }) {
  const meta = ACTION_META[job.action] || { icon: ListChecks, color: '#a78bfa' }
  const Icon = meta.icon
  const status = jobStatus(job)
  const sMeta = STATUS_META[status]
  const SIcon = sMeta.icon

  return (
    <div className="flex items-center gap-4 px-5 py-4"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: `${meta.color}1a`, border: `1px solid ${meta.color}33` }}>
        <Icon size={15} style={{ color: meta.color }} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{job.label}</p>
          <span className="text-sm" style={{ color: 'var(--text-faint)' }}>by {job.username}</span>
        </div>
        <p className="text-sm truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {job.targets.length > 0
            ? job.targets.slice(0, 3).join(', ') + (job.total > 3 ? ` +${job.total - 3} more` : '')
            : job.details || '—'}
        </p>
      </div>

      {/* Success/fail/skip counts */}
      <div className="hidden sm:flex items-center gap-3 text-sm font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
        {job.success > 0 && <span style={{ color: '#22c55e' }}>{job.success} ok</span>}
        {job.failure > 0 && <span style={{ color: '#f87171' }}>{job.failure} failed</span>}
        {job.skipped > 0 && <span style={{ color: '#94a3b8' }}>{job.skipped} skipped</span>}
        {job.total > 1 && <span style={{ color: 'var(--text-faint)' }}>({job.total} total)</span>}
      </div>

      {/* Status pill */}
      <span className="badge text-sm shrink-0" title={jobStatus(job)}
        style={{ background: sMeta.bg, border: `1px solid ${sMeta.border}`, color: sMeta.color }}>
        <SIcon size={11} /> {sMeta.label}
      </span>

      {/* Time */}
      <div className="text-right shrink-0 hidden md:block" style={{ minWidth: 130 }}>
        <p className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>{timeAgo(job.finishedAt)}</p>
        <p className="text-[11px] font-mono" style={{ color: 'var(--text-faint)' }}>{formatTime(job.finishedAt)}</p>
      </div>
    </div>
  )
}

export default function JobsPage() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [actionFilter, setActionFilter] = useState('all')
  const [search, setSearch] = useState('')

  const fetchJobs = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const params = {}
      if (actionFilter !== 'all') params.action = actionFilter
      if (search.trim()) params.search = search.trim()
      const { data } = await api.get('/jobs', { params })
      setJobs(data)
    } catch { toast.error('Failed to load jobs') }
    finally { setLoading(false) }
  }, [actionFilter, search])

  useEffect(() => { fetchJobs() }, [fetchJobs])

  return (
    <div className="animate-fade-in">
      <PageHeader
        icon={ListChecks}
        title="Jobs"
        subtitle="Bulk edits, bulk wakes, scheduled actions, and agent updates in one timeline — reconstructed from the Audit Log, not a separate ledger."
        actions={
          <button onClick={() => fetchJobs()}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-all"
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>
            <RefreshCw size={12} /> Refresh
          </button>
        } />

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {FILTER_ACTIONS.map(([v, l]) => (
          <button key={v} onClick={() => setActionFilter(v)}
            className="px-3 py-1.5 rounded-lg text-sm font-semibold transition-all"
            style={{
              background: actionFilter === v ? 'rgba(167,139,250,0.15)' : 'transparent',
              color: actionFilter === v ? '#a78bfa' : 'var(--text-muted)',
              border: `1px solid ${actionFilter === v ? 'rgba(167,139,250,0.3)' : 'var(--border-subtle)'}`,
            }}>
            {l}
          </button>
        ))}
        <div className="flex-1" />
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-faint)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search user or device…"
            className="input-field h-9 text-sm pl-8" style={{ width: 220 }} />
        </div>
      </div>

      {/* Timeline */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-surface-2)' }}>
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="w-9 h-9 rounded-xl bg-white/5 shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-white/5 rounded w-1/3" />
                <div className="h-2.5 bg-white/5 rounded w-1/2" />
              </div>
              <div className="h-5 bg-white/5 rounded-full w-20" />
            </div>
          ))
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <Clock size={22} style={{ color: 'var(--text-faint)' }} />
            <p className="text-sm" style={{ color: 'var(--text-faint)' }}>No jobs match these filters.</p>
          </div>
        ) : (
          jobs.map(job => <JobRow key={job.id} job={job} />)
        )}
      </div>
    </div>
  )
}