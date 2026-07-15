import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  ScrollText, Search, RefreshCw, Zap, Power, RotateCcw,
  Shield, ChevronLeft, ChevronRight, UserCheck,
  Plus, Pencil, Trash2, Clock, CheckCircle2, XCircle, AlertCircle,
  Radio, Download, FileSpreadsheet, FileText, ChevronDown, Settings2, MinusCircle,
  Calendar, X as XIcon, ArrowUpCircle, ArrowDownCircle, GitCompare, History,
  Server, Minus, ArrowRight, Loader2, Bookmark
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import SyslogSettingsModal from '../components/modals/SyslogSettingsModal'
import ScheduleLogExportModal from '../components/modals/ScheduleLogExportModal'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'
import SavedViews from '../components/SavedViews'
import { usePermissions } from '../hooks/usePermissions'
import { format } from 'date-fns'

// ── Maps every action string the backend can emit ───────────────────────────
const ACTION_META = {
  wake:         { icon: Zap,         color: 'text-accent-green',  bg: 'bg-accent-green/10  border-accent-green/20',  label: 'Wake'        },
  shutdown:     { icon: Power,       color: 'text-accent-red',    bg: 'bg-accent-red/10    border-accent-red/20',    label: 'Shutdown'    },
  restart:      { icon: RotateCcw,   color: 'text-accent-yellow', bg: 'bg-accent-yellow/10 border-accent-yellow/20', label: 'Restart'     },
  login:        { icon: UserCheck,   color: 'text-brand-400',     bg: 'bg-brand-500/10     border-brand-500/20',     label: 'Login'       },
  add_device:   { icon: Plus,        color: 'text-accent-cyan',   bg: 'bg-accent-cyan/10   border-accent-cyan/20',   label: 'Add Device'  },
  edit_device:  { icon: Pencil,      color: 'text-accent-yellow', bg: 'bg-accent-yellow/10 border-accent-yellow/20', label: 'Edit Device' },
  delete_device:{ icon: Trash2,      color: 'text-accent-red',    bg: 'bg-accent-red/10    border-accent-red/20',    label: 'Delete'      },
}

const RESULT_META = {
  success: {
    label: 'Success',
    cls: 'text-accent-green bg-accent-green/10 border-accent-green/25',
    icon: CheckCircle2,
  },
  failure: {
    label: 'Failure',
    cls: 'text-accent-red bg-accent-red/10 border-accent-red/25',
    icon: XCircle,
  },
  partial: {
    label: 'Partial',
    cls: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/25',
    icon: AlertCircle,
  },
}

const FILTER_ACTIONS = ['all', 'wake', 'shutdown', 'restart', 'login', 'add_device', 'edit_device', 'delete_device']
const FILTER_RESULTS = ['all', 'success', 'failure', 'partial']

// ── Helpers ─────────────────────────────────────────────────────────────────
function formatTime(ts) {
  try {
    const ms = (typeof ts === 'number' ? ts : Number(ts)) * 1000
    return format(new Date(ms), 'dd MMM yyyy, HH:mm:ss')
  } catch { return '—' }
}

function getTarget(log) {
  // For login events the "target" is the user themselves — show their username
  if (log.action === 'login') return log.username || '—'
  return log.target_name || '—'
}

function getTargetSub(log) {
  if (log.action === 'login') return log.target_type || null
  return log.target_type || null
}

function getMeta(action) {
  return ACTION_META[action] || {
    icon: Shield, color: 'text-brand-400', bg: 'bg-brand-500/10 border-brand-500/20', label: action || '—',
  }
}

// Left accent bar + zebra tint color, keyed off the row's result — gives an
// at-a-glance "something failed" scan down the left edge without having to
// read the Result badge on every single row.
const RESULT_ACCENT = {
  success: 'var(--accent-green, #22c55e)',
  failure: 'var(--accent-red, #ef4444)',
  partial: 'var(--accent-yellow, #eab308)',
}
function getResultAccent(result) {
  return RESULT_ACCENT[result] || 'transparent'
}

// ── Table cell ───────────────────────────────────────────────────────────────
// Content stays truncated so the table stays tidy and never grows a row's
// height. The full, untruncated value lives in the row's detail drawer
// (click anywhere on the row) rather than a per-cell hover tooltip — that
// reads better on mobile, where hover doesn't exist, and gives every field a
// permanent place to land instead of a floating card that disappears.
function ExpandableCell({ text, className = '', mono = false, sub = null }) {
  if (text === null || text === undefined || text === '') {
    return <span className="text-sm" style={{ color: 'var(--text-faint)' }}>—</span>
  }

  return (
    <div className="min-w-0">
      <div className={['text-sm truncate rounded', mono ? 'font-mono' : 'font-body', className].join(' ')}>
        <span className="block truncate">{text}</span>
      </div>
      {sub && (
        <p className="text-xs font-body truncate mt-0.5 capitalize" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </p>
      )}
    </div>
  )
}

// ── Row detail drawer ────────────────────────────────────────────────────────
// Slide-in panel showing every field of an event with nothing truncated.
// Opened by clicking (or Enter/Space-ing) anywhere on a row.
function DetailField({ label, value, mono = false }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div>
      <p className="text-xs font-body font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <p className={`text-sm break-words ${mono ? 'font-mono' : 'font-body'}`} style={{ color: 'var(--text-primary)' }}>
        {value}
      </p>
    </div>
  )
}

function AuditDetailDrawer({ log, showSync, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!log) return null

  const meta    = getMeta(log.action)
  const ActionIcon = meta.icon
  const result  = log.result || 'unknown'
  const resMeta = RESULT_META[result]
  const ResIcon = resMeta?.icon ?? AlertCircle

  return (
    <div className="fixed inset-0 z-50 animate-fade-in">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Event details"
        className="absolute right-0 top-0 bottom-0 w-full sm:w-[420px] overflow-y-auto animate-slide-in-right"
        style={{ background: 'var(--bg-surface-2)', borderLeft: '1px solid var(--border-mid)' }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2.5">
            <span className={`w-9 h-9 rounded-md border flex items-center justify-center shrink-0 ${meta.bg}`}>
              <ActionIcon size={17} className={meta.color} />
            </span>
            <div>
              <p className={`text-sm font-medium ${meta.color}`}>{meta.label}</p>
              <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{formatTime(log.timestamp)}</p>
            </div>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close details">
            <XIcon size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <DetailField label="Result" value={
            <span className={`inline-flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-md text-sm font-body font-medium border ${resMeta?.cls || 'text-slate-500 bg-surface-4 border-white/10'}`}>
              <ResIcon size={14} /> {resMeta?.label || result}
            </span>
          } />
          <DetailField label="User" value={log.username} />
          <DetailField label="User ID" value={log.user_id} mono />
          <DetailField label="Target" value={getTarget(log)} mono />
          <DetailField label="Target Type" value={getTargetSub(log)} />
          <DetailField label="Details" value={log.details} />
          <DetailField label="Source IP" value={log.ip_source} mono />
          <DetailField label="Timestamp (absolute)" value={formatTime(log.timestamp)} mono />
          <DetailField label="Timestamp (relative)" value={relativeTime(log.timestamp)} />
          {showSync && (
            <DetailField label="Syslog Sync" value={
              log.syslog_synced === 1 || log.syslog_synced === true ? 'Forwarded'
                : log.syslog_synced === 0 || log.syslog_synced === false ? 'Failed'
                : 'Not forwarded'
            } />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Skeleton row ─────────────────────────────────────────────────────────────
function SkeletonRow({ gridCols, showSync }) {
  return (
    <div className="relative grid items-center gap-4 pl-4 pr-5 py-4 border-b animate-pulse"
      style={{ gridTemplateColumns: gridCols, borderColor: 'var(--border-subtle)' }}>
      <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: 'var(--bg-input)' }} />
      <div className="h-3.5 rounded w-5/6" style={{background:"var(--bg-input)"}} />
      <div className="h-3.5 rounded w-3/4" style={{background:"var(--bg-input)"}} />
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-md shrink-0" style={{background:"var(--bg-input)"}} />
        <div className="h-3.5 rounded w-16" style={{background:"var(--bg-input)"}} />
      </div>
      <div className="h-3.5 rounded w-2/3" style={{background:"var(--bg-input)"}} />
      <div className="h-3.5 rounded w-4/5" style={{background:"var(--bg-input)"}} />
      <div className="h-5 rounded-full w-20 justify-self-end" style={{background:"var(--bg-input)"}} />
      {showSync && <div className="h-3.5 rounded w-8 justify-self-center" style={{background:"var(--bg-input)"}} />}
    </div>
  )
}

// ── Export dropdown (CSV / TXT) ─────────────────────────────────────────────
function ExportMenu({ onExport, exporting }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        disabled={exporting}
        className="btn-ghost disabled:opacity-50"
      >
        {exporting ? <RefreshCw size={16} className="animate-spin text-brand-400" /> : <Download size={16} className="text-brand-400" />}
        Export
        <ChevronDown size={14} className={`transition-transform text-brand-400 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-48 z-20 glass rounded-xl overflow-hidden animate-fade-in">
          <button
            onClick={() => { setOpen(false); onExport('csv') }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-body transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)' }}
          >
            <FileSpreadsheet size={16} className="text-accent-green" />
            Export as CSV
          </button>
          <button
            onClick={() => { setOpen(false); onExport('txt') }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-body transition-colors"
            style={{ color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)' }}
          >
            <FileText size={16} className="text-brand-400" />
            Export as TXT
          </button>
        </div>
      )}
    </div>
  )
}

// ── Syslog sync badge ────────────────────────────────────────────────────────
function SyslogBadge({ status, isAdmin, onOpenSettings }) {
  if (!status) return null
  const enabled = status.enabled

  return (
    <button
      onClick={onOpenSettings}
      disabled={!isAdmin}
      title={isAdmin ? 'Configure syslog forwarding' : (enabled ? `Forwarding to ${status.host}` : 'Syslog forwarding disabled')}
      className={`flex items-center gap-1.5 px-3 h-9 rounded-lg border text-sm font-body transition-colors ${
        enabled
          ? 'bg-accent-cyan/10 border-accent-cyan/25 text-accent-cyan hover:bg-accent-cyan/15'
          : 'icon-btn !h-9'
      } ${isAdmin ? 'cursor-pointer' : 'cursor-default'}`}
    >
      {enabled ? <Radio size={16} /> : <MinusCircle size={16} className="text-brand-400" />}
      <span className="hidden sm:inline">{enabled ? 'Syslog Sync On' : 'Syslog Sync Off'}</span>
      {isAdmin && <Settings2 size={14} className="ml-0.5" style={{ color: 'var(--text-muted)' }} />}
    </button>
  )
}

// ── Device Changes — timeline & compare-snapshots ───────────────────────────
// Answers "what changed" instead of "who did what": online/offline
// transitions detected automatically by the status poller, browsable as a
// chronological feed or diffed between two points in time.
function relativeTime(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function StatusPill({ status }) {
  const map = {
    online:  { cls: 'text-accent-green bg-accent-green/10 border-accent-green/25', label: 'Online' },
    offline: { cls: 'text-slate-400 bg-surface-4 border-white/10', label: 'Offline' },
    unknown: { cls: 'text-accent-yellow bg-accent-yellow/10 border-accent-yellow/25', label: 'Unknown' },
    needs_approval: { cls: 'text-brand-400 bg-brand-500/10 border-brand-500/25', label: 'Pending' },
  }
  const m = map[status] || map.unknown
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-body font-medium border ${m.cls}`}>
      {m.label}
    </span>
  )
}

// yyyy-mm-ddThh:mm (local) <-> epoch seconds, for <input type="datetime-local">
function localToEpoch(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return Math.floor(d.getTime() / 1000)
}
function epochToLocalInput(epochSec) {
  const d = new Date(epochSec * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function DeviceChangesPanel() {
  const [mode, setMode] = useState('timeline') // 'timeline' | 'compare'

  // ── Timeline mode ──────────────────────────────────────────────────────
  const [changes, setChanges]   = useState([])
  const [tallies, setTallies]   = useState({ wentOnline: 0, wentOffline: 0 })
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(true)
  const [page, setPage]         = useState(1)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate]     = useState('')
  const LIMIT = 20

  const fetchChanges = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page, limit: LIMIT })
      const fromEpoch = fromDate ? Math.floor(new Date(`${fromDate}T00:00:00`).getTime() / 1000) : null
      const toEpoch   = toDate   ? Math.floor(new Date(`${toDate}T23:59:59`).getTime() / 1000)   : null
      if (fromEpoch) params.set('from', fromEpoch)
      if (toEpoch)   params.set('to', toEpoch)
      const { data } = await api.get(`/audit/device-changes?${params}`)
      setChanges(data.changes ?? [])
      setTotal(data.total ?? 0)
      setTallies(data.tallies ?? { wentOnline: 0, wentOffline: 0 })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load device changes')
    } finally {
      setLoading(false)
    }
  }, [page, fromDate, toDate])

  useEffect(() => { if (mode === 'timeline') fetchChanges() }, [mode, fetchChanges])
  useEffect(() => { setPage(1) }, [fromDate, toDate])

  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  // ── Compare mode ───────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000)
  const [pointA, setPointA] = useState(epochToLocalInput(now - 86400)) // 24h ago
  const [pointB, setPointB] = useState(epochToLocalInput(now))
  const [comparing, setComparing] = useState(false)
  const [compareResult, setCompareResult] = useState(null)

  const runCompare = useCallback(async () => {
    const a = localToEpoch(pointA)
    const b = localToEpoch(pointB)
    if (!a || !b) return toast.error('Pick two valid points in time to compare')
    setComparing(true)
    try {
      const { data } = await api.get(`/audit/device-compare?a=${a}&b=${b}`)
      setCompareResult(data)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Comparison failed')
    } finally {
      setComparing(false)
    }
  }, [pointA, pointB])

  useEffect(() => { if (mode === 'compare' && !compareResult) runCompare() }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="animate-fade-in">
      {/* Mode toggle */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <button
          onClick={() => setMode('timeline')}
          className={`flex items-center gap-2 h-9 px-3.5 rounded-lg text-sm font-body font-medium border transition-colors ${
            mode === 'timeline'
              ? 'bg-brand-500/15 border-brand-500/30 text-brand-400'
              : 'border-white/8 hover:bg-surface-3'
          }`}
          style={mode === 'timeline' ? {} : { color: 'var(--text-secondary)' }}
        >
          <History size={16} /> Timeline
        </button>
        <button
          onClick={() => setMode('compare')}
          className={`flex items-center gap-2 h-9 px-3.5 rounded-lg text-sm font-body font-medium border transition-colors ${
            mode === 'compare'
              ? 'bg-brand-500/15 border-brand-500/30 text-brand-400'
              : 'border-white/8 hover:bg-surface-3'
          }`}
          style={mode === 'compare' ? {} : { color: 'var(--text-secondary)' }}
        >
          <GitCompare size={16} /> Compare Snapshots
        </button>
      </div>

      {mode === 'timeline' ? (
        <>
          {/* Filters + tallies */}
          <div className="glass rounded-xl border border-white/8 px-4 py-3.5 mb-5 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Calendar size={16} className="text-brand-400 shrink-0" />
              <input type="date" aria-label="From date" className="input-field h-9 text-sm px-2 w-[136px]"
                value={fromDate} max={toDate || undefined} onChange={e => setFromDate(e.target.value)} />
              <span className="text-sm" style={{ color: 'var(--text-faint)' }}>–</span>
              <input type="date" aria-label="To date" className="input-field h-9 text-sm px-2 w-[136px]"
                value={toDate} min={fromDate || undefined} onChange={e => setToDate(e.target.value)} />
              {(fromDate || toDate) && (
                <button onClick={() => { setFromDate(''); setToDate('') }} title="Clear date range"
                  className="p-1.5 rounded-md transition-colors" style={{ color: 'var(--text-muted)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}>
                  <XIcon size={16} />
                </button>
              )}
            </div>
            <div className="ml-auto flex items-center gap-4">
              <span className="flex items-center gap-1.5 text-sm text-accent-green font-body">
                <ArrowUpCircle size={15} /> {tallies.wentOnline} came online
              </span>
              <span className="flex items-center gap-1.5 text-sm text-accent-red font-body">
                <ArrowDownCircle size={15} /> {tallies.wentOffline} went offline
              </span>
            </div>
          </div>

          {/* Feed */}
          <div className="glass rounded-xl border border-white/8 overflow-hidden">
            {loading ? (
              <div className="p-5 space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-10 rounded-lg animate-pulse" style={{ background: 'var(--bg-input)' }} />
                ))}
              </div>
            ) : changes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <div className="w-14 h-14 rounded-2xl bg-brand-500/15 border border-brand-500/25 flex items-center justify-center">
                  <History size={26} className="text-brand-400" />
                </div>
                <p className="font-body text-sm" style={{ color: 'var(--text-secondary)' }}>No status changes recorded</p>
                <p className="font-body text-sm max-w-sm text-center" style={{ color: 'var(--text-muted)' }}>
                  Changes appear here automatically as the status poller detects devices going online or offline.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {changes.map(c => {
                  const up = c.new_status === 'online'
                  return (
                    <div key={c.id} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-3/40 transition-colors">
                      {up
                        ? <ArrowUpCircle size={18} className="text-accent-green shrink-0" />
                        : <ArrowDownCircle size={18} className="text-accent-red shrink-0" />}
                      <Server size={15} className="text-brand-400 shrink-0" />
                      <span className="font-body font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                        {c.device_name}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <StatusPill status={c.old_status || 'unknown'} />
                        <ArrowRight size={12} style={{ color: 'var(--text-faint)' }} />
                        <StatusPill status={c.new_status} />
                      </span>
                      <span className="ml-auto flex items-center gap-1.5 text-xs font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                        <Clock size={12} />
                        {formatTime(c.timestamp)} · {relativeTime(c.timestamp)}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>
                Page <span style={{ color: 'var(--text-secondary)' }}>{page}</span> of {totalPages} · {total} changes
              </p>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="btn-ghost py-1.5 px-3 disabled:opacity-30 text-sm">
                  <ChevronLeft size={16} className="text-brand-400" /> Prev
                </button>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="btn-ghost py-1.5 px-3 disabled:opacity-30 text-sm">
                  Next <ChevronRight size={16} className="text-brand-400" />
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Compare controls */}
          <div className="glass rounded-xl border border-white/8 px-4 py-3.5 mb-5 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>Point A</label>
              <input type="datetime-local" className="input-field h-9 text-sm px-2"
                value={pointA} onChange={e => setPointA(e.target.value)} />
            </div>
            <ArrowRight size={16} style={{ color: 'var(--text-faint)' }} />
            <div className="flex items-center gap-2">
              <label className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>Point B</label>
              <input type="datetime-local" className="input-field h-9 text-sm px-2"
                value={pointB} onChange={e => setPointB(e.target.value)} />
            </div>
            <button onClick={runCompare} disabled={comparing} className="btn-primary h-9 ml-auto disabled:opacity-50">
              {comparing ? <RefreshCw size={16} className="animate-spin" /> : <GitCompare size={16} />}
              Compare
            </button>
          </div>

          {compareResult && (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-5">
                <div className="glass rounded-xl border border-white/8 p-4">
                  <div className="flex items-center gap-2 text-accent-green mb-1">
                    <ArrowUpCircle size={16} /><span className="text-xs font-body font-semibold uppercase tracking-widest">Came Online</span>
                  </div>
                  <p className="text-2xl font-display font-bold" style={{ color: 'var(--text-primary)' }}>{compareResult.wentOnline.length}</p>
                </div>
                <div className="glass rounded-xl border border-white/8 p-4">
                  <div className="flex items-center gap-2 text-accent-red mb-1">
                    <ArrowDownCircle size={16} /><span className="text-xs font-body font-semibold uppercase tracking-widest">Went Offline</span>
                  </div>
                  <p className="text-2xl font-display font-bold" style={{ color: 'var(--text-primary)' }}>{compareResult.wentOffline.length}</p>
                </div>
                <div className="glass rounded-xl border border-white/8 p-4">
                  <div className="flex items-center gap-2 text-accent-yellow mb-1">
                    <AlertCircle size={16} /><span className="text-xs font-body font-semibold uppercase tracking-widest">Other Change</span>
                  </div>
                  <p className="text-2xl font-display font-bold" style={{ color: 'var(--text-primary)' }}>{compareResult.otherChange.length}</p>
                </div>
                <div className="glass rounded-xl border border-white/8 p-4">
                  <div className="flex items-center gap-2 mb-1" style={{ color: 'var(--text-muted)' }}>
                    <Minus size={16} /><span className="text-xs font-body font-semibold uppercase tracking-widest">Unchanged</span>
                  </div>
                  <p className="text-2xl font-display font-bold" style={{ color: 'var(--text-primary)' }}>{compareResult.unchangedCount}</p>
                </div>
              </div>

              {/* Change lists */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { key: 'wentOnline',  title: 'Came online',   icon: ArrowUpCircle,   color: 'text-accent-green' },
                  { key: 'wentOffline', title: 'Went offline',  icon: ArrowDownCircle, color: 'text-accent-red' },
                ].map(({ key, title, icon: Icon, color }) => (
                  <div key={key} className="glass rounded-xl border border-white/8 overflow-hidden">
                    <div className={`flex items-center gap-2 px-4 py-3 border-b border-white/8 ${color}`}>
                      <Icon size={16} /><span className="text-sm font-body font-semibold">{title} ({compareResult[key].length})</span>
                    </div>
                    {compareResult[key].length === 0 ? (
                      <p className="px-4 py-6 text-sm font-body text-center" style={{ color: 'var(--text-muted)' }}>None</p>
                    ) : (
                      <div className="divide-y divide-white/5 max-h-72 overflow-y-auto">
                        {compareResult[key].map(d => (
                          <div key={d.id} className="flex items-center gap-2.5 px-4 py-2.5">
                            <Server size={14} className="text-brand-400 shrink-0" />
                            <span className="text-sm font-body truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</span>
                            <span className="ml-auto flex items-center gap-1.5 shrink-0">
                              <StatusPill status={d.before} />
                              <ArrowRight size={11} style={{ color: 'var(--text-faint)' }} />
                              <StatusPill status={d.status} />
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Scheduled Log Exports panel ─────────────────────────────────────────────
function ScheduleRow({ schedule, destinations, isAdmin, running, onEdit, onDelete, onToggle, onRun }) {
  const isSyslog = schedule.export_target === 'syslog'
  const dest = schedule.destination_id ? destinations.find(d => d.id === schedule.destination_id) : null
  const destLabel = isSyslog ? 'Syslog server' : (dest?.name || 'Local storage')

  const statusMeta = schedule.last_status === 'success'
    ? { icon: CheckCircle2, cls: 'text-accent-green' }
    : schedule.last_status === 'failure'
    ? { icon: XCircle, cls: 'text-accent-red' }
    : { icon: MinusCircle, cls: 'text-brand-400' }
  const StatusIcon = statusMeta.icon

  return (
    <div className="flex items-center gap-4 px-4 py-3.5 rounded-xl glass border border-white/8">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isSyslog ? 'bg-accent-cyan/10 border border-accent-cyan/20' : 'bg-brand-500/10 border border-brand-500/20'}`}>
        {isSyslog ? <Radio size={16} className="text-accent-cyan" /> : <FileSpreadsheet size={16} className="text-brand-400" />}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-body font-medium truncate" style={{ color: 'var(--text-primary)' }}>{schedule.name}</p>
        <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{schedule.cron_expr} · {destLabel}</p>
      </div>

      <div className="hidden sm:flex items-center gap-1.5 text-xs font-body shrink-0" style={{ color: 'var(--text-muted)' }} title={schedule.last_error || undefined}>
        <StatusIcon size={13} className={statusMeta.cls} />
        {schedule.last_run ? relativeTime(schedule.last_run) : 'Never run'}
      </div>

      <button
        onClick={() => onToggle(schedule)}
        title={schedule.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
        className={`w-10 h-5 rounded-full transition-all duration-200 relative shrink-0 ${schedule.enabled ? 'bg-accent-green' : ''}`}
        style={!schedule.enabled ? { background: 'var(--bg-surface-4)' } : {}}
      >
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${schedule.enabled ? 'left-5' : 'left-0.5'}`} />
      </button>

      <button onClick={() => onRun(schedule)} disabled={running} title="Run now" className="icon-btn shrink-0">
        {running ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} className="text-accent-yellow" />}
      </button>

      <button onClick={() => onEdit(schedule)} title="Edit" className="icon-btn shrink-0"><Pencil size={15} /></button>

      {isAdmin && (
        <button onClick={() => onDelete(schedule)} title="Delete" className="icon-btn shrink-0 hover:text-accent-red"><Trash2 size={15} /></button>
      )}
    </div>
  )
}

function ScheduledExportsPanel({ schedules, loading, destinations, syslogConfigured, isAdmin, runningScheduleId, onCreate, onEdit, onDelete, onToggle, onRun }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>
          Recurring audit log exports — to a file destination or straight to your syslog server.
        </p>
        <button onClick={onCreate} className="btn-primary flex items-center gap-2">
          <Plus size={15} /> New Schedule
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
        </div>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 glass rounded-xl border border-white/8">
          <Clock size={28} style={{ color: 'var(--text-faint)' }} />
          <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>No scheduled exports yet</p>
          <button onClick={onCreate} className="btn-ghost">Create your first schedule</button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {schedules.map(s => (
            <ScheduleRow
              key={s.id}
              schedule={s}
              destinations={destinations}
              isAdmin={isAdmin}
              running={runningScheduleId === s.id}
              onEdit={onEdit}
              onDelete={onDelete}
              onToggle={onToggle}
              onRun={onRun}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function AuditPage() {
  const [logs, setLogs]               = useState([])
  const [total, setTotal]             = useState(0)
  const [tallies, setTallies]         = useState({ success: 0, failure: 0, partial: 0, synced: 0, byAction: {} })
  const [loading, setLoading]         = useState(true)
  const [page, setPage]               = useState(1)
  const [search, setSearch]           = useState('')
  const [actionFilter, setActionFilter] = useState('all')
  const [resultFilter, setResultFilter] = useState('all')
  const [fromDate, setFromDate]       = useState('') // yyyy-mm-dd, inclusive
  const [toDate, setToDate]           = useState('') // yyyy-mm-dd, inclusive
  const [exportFormat, setExportFormat] = useState(null) // 'csv' | 'txt' | null while exporting
  const [syslogStatus, setSyslogStatus]   = useState(null)
  const [syslogModalOpen, setSyslogModalOpen] = useState(false)
  const { isAdmin } = usePermissions()
  const [tab, setTab] = useState('events') // 'events' | 'changes' | 'schedules'
  const [selectedLog, setSelectedLog] = useState(null) // row clicked -> open detail drawer
  const LIMIT = 25
  // Virtualization: only kicks in once a page's row count gets large enough
  // that rendering every row would actually cost something — at the current
  // 25/page default every row renders as before. If LIMIT is ever raised (or
  // an "unpaginated" mode is added) this keeps scrolling smooth without
  // rendering hundreds of offscreen rows.
  const ROW_HEIGHT = 68
  const VIRTUALIZE_THRESHOLD = 60
  const OVERSCAN = 6
  const [rowsScrollTop, setRowsScrollTop] = useState(0)
  const rowsContainerRef = useRef(null)
  const currentFilters = { search, actionFilter, resultFilter, fromDate, toDate }
  const [appliedView, setAppliedView] = useState(null) // { id, name, filters } | null
  const applyView = (f, view) => {
    setSearch(f.search || '')
    setActionFilter(f.actionFilter || 'all')
    setResultFilter(f.resultFilter || 'all')
    setFromDate(f.fromDate || '')
    setToDate(f.toDate || '')
    setPage(1)
    setAppliedView(view ? { id: view.id, name: view.name, filters: f } : null)
  }
  // Once a view is applied, any further tweak to the filters makes it "dirty"
  // — still shown as the active view, but flagged as no longer matching
  // exactly what was saved, so it stays legible instead of silently stale.
  const isViewDirty = appliedView
    ? Object.keys(currentFilters).some(k => (currentFilters[k] || '') !== (appliedView.filters[k] || ''))
    : false

  // ── Scheduled log exports ──────────────────────────────────────────────
  const [schedules, setSchedules]         = useState([])
  const [schedulesLoading, setSchedulesLoading] = useState(false)
  const [destinations, setDestinations]   = useState([])
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(null)
  const [deleteScheduleTarget, setDeleteScheduleTarget] = useState(null)
  const [runningScheduleId, setRunningScheduleId] = useState(null)

  // Local yyyy-mm-dd -> epoch seconds. `from` = start of that day, `to` = end
  // of that day (23:59:59) so a single-day range is inclusive of everything
  // logged on that calendar date, not just up to 00:00:00.
  const dateToEpoch = (value, endOfDay = false) => {
    if (!value) return null
    const d = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`)
    if (Number.isNaN(d.getTime())) return null
    return Math.floor(d.getTime() / 1000)
  }

  const buildParams = useCallback((extra = {}) => {
    const params = new URLSearchParams(extra)
    if (search)                 params.set('search', search)
    if (actionFilter !== 'all') params.set('action', actionFilter)
    // backend column is `result`, not `status`
    if (resultFilter !== 'all') params.set('result', resultFilter)
    const fromEpoch = dateToEpoch(fromDate, false)
    const toEpoch   = dateToEpoch(toDate, true)
    if (fromEpoch !== null) params.set('from', fromEpoch)
    if (toEpoch   !== null) params.set('to', toEpoch)
    return params
  }, [search, actionFilter, resultFilter, fromDate, toDate])

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const params = buildParams({ page, limit: LIMIT })
      const { data } = await api.get(`/audit?${params}`)
      setLogs(data.logs ?? data)
      setTotal(data.total ?? (Array.isArray(data) ? data.length : 0))
      if (data.tallies) setTallies(data.tallies)
    } catch (err) {
      const reason = err?.response?.data?.error || err?.message || 'Unknown error'
      console.error('Failed to load audit log:', err)
      toast.error(`Failed to load audit log: ${reason}`)
    } finally {
      setLoading(false)
    }
  }, [page, buildParams])

  const fetchSyslogStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/audit/syslog/status')
      setSyslogStatus(data)
    } catch { /* non-critical — badge just stays hidden */ }
  }, [])

  const fetchSchedules = useCallback(async () => {
    setSchedulesLoading(true)
    try {
      const { data } = await api.get('/log-export-schedules')
      setSchedules(data)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load scheduled exports')
    } finally {
      setSchedulesLoading(false)
    }
  }, [])

  const fetchDestinations = useCallback(async () => {
    try {
      const { data } = await api.get('/backup/destinations')
      setDestinations(data)
    } catch { /* destination picker just falls back to local-only */ }
  }, [])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  useEffect(() => { fetchSyslogStatus() }, [fetchSyslogStatus])
  useEffect(() => { if (tab === 'schedules') { fetchSchedules(); fetchDestinations() } }, [tab, fetchSchedules, fetchDestinations])
  useEffect(() => { setPage(1) }, [search, actionFilter, resultFilter, fromDate, toDate])

  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  // The Sync column only earns its place once syslog forwarding is (or has
  // ever been) relevant — otherwise it's a column of dashes wasting space.
  const showSync = !!(syslogStatus?.enabled || tallies.synced > 0)
  // minmax(floor, share) instead of a hard px width: each column still can't
  // shrink below a readable floor, but above that it flexes with whatever
  // room the viewport actually has, so the table only needs its horizontal
  // scrollbar on genuinely narrow screens instead of on every screen.
  const gridCols = showSync
    ? 'minmax(120px,0.9fr) minmax(110px,1fr) minmax(120px,1fr) minmax(160px,2.2fr) minmax(100px,1fr) 110px 64px'
    : 'minmax(130px,0.9fr) minmax(120px,1fr) minmax(130px,1fr) minmax(180px,2.2fr) minmax(110px,1fr) 110px'

  const handleExport = async (format) => {
    setExportFormat(format)
    const toastId = toast.loading('Preparing export…')
    try {
      const params = buildParams({ format })
      const res = await api.get(`/audit/export?${params}`, { responseType: 'blob' })
      const disposition = res.headers['content-disposition'] || ''
      const match = disposition.match(/filename="?([^"]+)"?/)
      const filename = match?.[1] || `netcontrol-audit-log.${format}`

      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success(`Downloaded ${filename}`, { id: toastId })
    } catch {
      toast.error('Export failed', { id: toastId })
    } finally {
      setExportFormat(null)
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1760px] mx-auto animate-fade-in">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <PageHeader
        icon={ScrollText}
        title="Audit Log"
        description="Complete record of all actions and authentication events"
        iconColor="text-accent-orange"
        iconBg="bg-accent-orange/15 border-accent-orange/25"
        actions={
          <>
            <SyslogBadge status={syslogStatus} isAdmin={isAdmin} onOpenSettings={() => setSyslogModalOpen(true)} />
            <ExportMenu onExport={handleExport} exporting={!!exportFormat} />
            <button onClick={() => { fetchLogs(); fetchSyslogStatus() }} className="btn-ghost" disabled={loading}>
              <RefreshCw size={16} className={`text-brand-400 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </>
        }
      />

      <SyslogSettingsModal
        open={syslogModalOpen}
        onClose={() => setSyslogModalOpen(false)}
        onSaved={fetchSyslogStatus}
      />

      {/* ── Security notice ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-brand-500/8 border border-brand-500/20 mb-6">
        <Shield size={18} className="text-brand-400 shrink-0" />
        <p className="text-sm font-body leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          All power actions are recorded with timestamp, user, source IP, and result.
          This log <span className="font-medium" style={{ color: 'var(--text-primary)' }}>cannot be modified or deleted</span> by normal users.
        </p>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <button
          onClick={() => setTab('events')}
          className={`flex items-center gap-2 h-9 px-3.5 rounded-lg text-sm font-body font-medium border transition-colors ${
            tab === 'events'
              ? 'bg-brand-500/15 border-brand-500/30 text-brand-400'
              : 'border-white/8 hover:bg-surface-3'
          }`}
          style={tab === 'events' ? {} : { color: 'var(--text-secondary)' }}
        >
          <ScrollText size={16} /> Event Log
        </button>
        <button
          onClick={() => setTab('changes')}
          className={`flex items-center gap-2 h-9 px-3.5 rounded-lg text-sm font-body font-medium border transition-colors ${
            tab === 'changes'
              ? 'bg-brand-500/15 border-brand-500/30 text-brand-400'
              : 'border-white/8 hover:bg-surface-3'
          }`}
          style={tab === 'changes' ? {} : { color: 'var(--text-secondary)' }}
        >
          <GitCompare size={16} /> Device Changes
        </button>
        <button
          onClick={() => setTab('schedules')}
          className={`flex items-center gap-2 h-9 px-3.5 rounded-lg text-sm font-body font-medium border transition-colors ${
            tab === 'schedules'
              ? 'bg-brand-500/15 border-brand-500/30 text-brand-400'
              : 'border-white/8 hover:bg-surface-3'
          }`}
          style={tab === 'schedules' ? {} : { color: 'var(--text-secondary)' }}
        >
          <Clock size={16} /> Scheduled Exports
        </button>
      </div>

      {tab === 'changes' ? (
        <DeviceChangesPanel />
      ) : tab === 'schedules' ? (
        <ScheduledExportsPanel
          schedules={schedules}
          loading={schedulesLoading}
          destinations={destinations}
          syslogConfigured={!!syslogStatus?.enabled}
          isAdmin={isAdmin}
          runningScheduleId={runningScheduleId}
          onCreate={() => { setEditingSchedule(null); setScheduleModalOpen(true) }}
          onEdit={(s) => { setEditingSchedule(s); setScheduleModalOpen(true) }}
          onDelete={(s) => setDeleteScheduleTarget(s)}
          onToggle={async (s) => {
            try {
              await api.patch(`/log-export-schedules/${s.id}/toggle`)
              fetchSchedules()
            } catch (err) { toast.error(err.response?.data?.error || 'Failed to toggle schedule') }
          }}
          onRun={async (s) => {
            setRunningScheduleId(s.id)
            try {
              await api.post(`/log-export-schedules/${s.id}/run`)
              toast.success(`"${s.name}" started`)
              fetchSchedules()
            } catch (err) { toast.error(err.response?.data?.error || 'Failed to run schedule') }
            finally { setRunningScheduleId(null) }
          }}
        />
      ) : (
      <>
      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="glass rounded-xl border border-white/8 px-4 py-3.5 mb-5 space-y-3">

        {/* Row 1: search + date range, side by side since both are "narrow the
            time/entity window" controls. This row no longer also carries the
            stat pills (moved to their own row below) — cramming both into
            one flex-wrap line was the main source of messy, unpredictable
            wrapping on anything narrower than a wide desktop. */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-400 pointer-events-none" />
            <input
              className="input-field pl-9 h-9 text-sm w-full"
              placeholder="Search user, device…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Date range — filters the table and scopes CSV/TXT export to a
              particular date (or from/to range). Both ends are optional and
              inclusive of the full calendar day selected. */}
          <div className="flex items-center gap-1.5 shrink-0">
            <Calendar size={16} className="text-brand-400 shrink-0" />
            <input
              type="date"
              aria-label="From date"
              className="input-field h-9 text-sm px-2 w-[136px]"
              value={fromDate}
              max={toDate || undefined}
              onChange={e => setFromDate(e.target.value)}
            />
            <span className="text-sm" style={{ color: 'var(--text-faint)' }}>–</span>
            <input
              type="date"
              aria-label="To date"
              className="input-field h-9 text-sm px-2 w-[136px]"
              value={toDate}
              min={fromDate || undefined}
              onChange={e => setToDate(e.target.value)}
            />
            {(fromDate || toDate) && (
              <button
                onClick={() => { setFromDate(''); setToDate('') }}
                title="Clear date range"
                className="p-1.5 rounded-md transition-colors shrink-0"
                style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
              >
                <XIcon size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Row 1b: result stat pills, own line so they're never competing
            with search/date for horizontal room. Wraps cleanly on its own
            if the viewport is narrow enough that not all pills fit. */}
        {!loading && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1">
            <span className="flex items-center gap-1.5 text-sm text-accent-green font-body">
              <CheckCircle2 size={14} /> {tallies.success} ok
            </span>
            <span className="flex items-center gap-1.5 text-sm text-accent-red font-body">
              <XCircle size={14} /> {tallies.failure} failed
            </span>
            {syslogStatus?.enabled && (
              <span className="flex items-center gap-1.5 text-sm text-accent-cyan font-body">
                <Radio size={14} /> {tallies.synced} synced
              </span>
            )}
            <span className="text-sm font-body ml-auto" style={{ color: 'var(--text-muted)' }}>{total} total events</span>
          </div>
        )}

        {/* Row 2: categorical filters. Each group now gets its own full-width
            line (flex-wrap on a w-full container) instead of sharing one row
            via a single flex-wrap + ml-auto — that made wrapping order
            unpredictable (Saved Views could land mid-way through the Result
            chips depending on exact viewport width). Predictable stacking:
            Action chips, then Result chips + Saved Views. */}
        <div className="space-y-2.5 pt-3 border-t border-white/6">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-body font-semibold uppercase tracking-widest mr-0.5 shrink-0" style={{ color: 'var(--text-secondary)' }}>Action</span>
            {FILTER_ACTIONS.map(a => {
              const count = a === 'all' ? total : (tallies.byAction?.[a] ?? 0)
              return (
                <button key={a} onClick={() => setActionFilter(a)}
                  className={`chip h-8 px-3 text-sm capitalize ${actionFilter === a ? 'chip-selected' : ''}`}>
                  {a === 'all' ? 'All' : (ACTION_META[a]?.label ?? a)}
                  <span className="ml-1 opacity-60 tabular-nums">({count})</span>
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-body font-semibold uppercase tracking-widest mr-0.5 shrink-0" style={{ color: 'var(--text-secondary)' }}>Result</span>
              {FILTER_RESULTS.map(r => {
                const count = r === 'all' ? total : (tallies[r] ?? 0)
                return (
                  <button key={r} onClick={() => setResultFilter(r)}
                    className={`chip h-8 px-3 text-sm capitalize ${resultFilter === r ? 'chip-selected' : ''}`}>
                    {r === 'all' ? 'All' : r.charAt(0).toUpperCase() + r.slice(1)}
                    <span className="ml-1 opacity-60 tabular-nums">({count})</span>
                  </button>
                )
              })}
            </div>

            <div className="flex items-center gap-2.5 ml-auto">
              {appliedView && (
                <span
                  className="flex items-center gap-1.5 text-xs font-body px-2.5 py-1 rounded-lg border shrink-0"
                  style={
                    isViewDirty
                      ? { color: 'var(--accent-yellow, #eab308)', background: 'rgba(234,179,8,0.08)', borderColor: 'rgba(234,179,8,0.25)' }
                      : { color: '#a78bfa', background: 'rgba(167,139,250,0.08)', borderColor: 'rgba(167,139,250,0.25)' }
                  }
                  title={isViewDirty ? `Filters no longer match "${appliedView.name}"` : `Showing saved view "${appliedView.name}"`}
                >
                  <Bookmark size={12} />
                  {appliedView.name}
                  {isViewDirty && <span className="opacity-80">· edited</span>}
                </span>
              )}
              <SavedViews page="audit" filters={currentFilters} onApply={applyView} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      {/* overflow-x-auto is a fallback, not the primary strategy: each grid
          column below is minmax(floor, share) — it flexes with whatever
          width the viewport actually has above its floor, so on a normal
          desktop the table fills the available width with no scrollbar at
          all. Only once the viewport genuinely can't fit every column at
          its floor width (phones, or a very narrow sidebar layout) does
          this container scroll horizontally, with the sticky header
          scrolling in lockstep since it's inside the same scroll box. */}
      <div className="glass rounded-xl border border-white/8 overflow-x-auto">
        <div className="min-w-[620px]">

        {/* Table header — sticky so column labels stay visible once a
            filtered result set scrolls past a screen's height */}
        <div
          className="sticky top-0 z-10 grid items-center gap-4 pl-4 pr-5 py-3 border-b border-white/10 bg-surface-2/95 backdrop-blur-sm"
          style={{ gridTemplateColumns: gridCols }}
        >
          {['Timestamp', 'User', 'Action', 'Target', 'Source IP'].map(h => (
            <span key={h} className="text-xs font-body font-semibold uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
              {h}
            </span>
          ))}
          <span className="text-xs font-body font-semibold uppercase tracking-widest text-right" style={{ color: 'var(--text-secondary)' }}>
            Result
          </span>
          {showSync && (
            <span className="text-xs font-body font-semibold uppercase tracking-widest text-center" style={{ color: 'var(--text-secondary)' }}>
              Sync
            </span>
          )}
        </div>

        {/* Rows */}
        {loading ? (
          <div>{Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} gridCols={gridCols} showSync={showSync} />)}</div>

        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-14 h-14 rounded-2xl bg-accent-purple/15 border border-accent-purple/25 flex items-center justify-center">
              <ScrollText size={26} className="text-accent-purple" />
            </div>
            <p className="font-body text-sm" style={{ color: 'var(--text-secondary)' }}>No audit events found</p>
            <p className="font-body text-sm" style={{ color: 'var(--text-muted)' }}>Try adjusting your filters</p>
            {(search || actionFilter !== 'all' || resultFilter !== 'all' || fromDate || toDate) && (
              <button
                onClick={() => { setSearch(''); setActionFilter('all'); setResultFilter('all'); setFromDate(''); setToDate('') }}
                className="btn-ghost mt-1 text-sm"
              >
                <XIcon size={14} className="text-brand-400" />
                Clear all filters
              </button>
            )}
          </div>

        ) : (
          <div
            ref={rowsContainerRef}
            className={logs.length > VIRTUALIZE_THRESHOLD ? 'divide-y divide-white/5 overflow-y-auto max-h-[70vh]' : 'divide-y divide-white/5'}
            onScroll={logs.length > VIRTUALIZE_THRESHOLD ? (e) => setRowsScrollTop(e.currentTarget.scrollTop) : undefined}
          >
            {(() => {
              const virtualize = logs.length > VIRTUALIZE_THRESHOLD
              const containerHeight = 70 * (window.innerHeight / 100) // 70vh in px
              const startIdx = virtualize ? Math.max(0, Math.floor(rowsScrollTop / ROW_HEIGHT) - OVERSCAN) : 0
              const endIdx = virtualize
                ? Math.min(logs.length, Math.ceil((rowsScrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN)
                : logs.length
              const topPad = virtualize ? startIdx * ROW_HEIGHT : 0
              const bottomPad = virtualize ? (logs.length - endIdx) * ROW_HEIGHT : 0

              return (
                <>
                  {topPad > 0 && <div style={{ height: topPad }} />}
                  {logs.slice(startIdx, endIdx).map((log, si) => {
              const i = startIdx + si
              const meta       = getMeta(log.action)
              const ActionIcon = meta.icon
              // ── result comes from `result` column, not `status` ──
              const result     = log.result || 'unknown'
              const resMeta    = RESULT_META[result]
              const ResIcon    = resMeta?.icon ?? AlertCircle

              return (
                <div
                  key={log.id ?? i}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedLog(log)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedLog(log) } }}
                  className="relative grid items-start gap-4 pl-4 pr-5 py-3.5 hover:bg-surface-3/60 transition-colors group cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand-400/50"
                  style={{
                    gridTemplateColumns: gridCols,
                    background: i % 2 === 1 ? 'var(--bg-surface-1, rgba(255,255,255,0.015))' : 'transparent',
                  }}
                >
                  {/* Result-colored accent bar — lets a failure jump out while
                      scanning down the log without reading every badge */}
                  <div
                    className="absolute left-0 top-0 bottom-0 w-[3px]"
                    style={{ background: getResultAccent(result), opacity: result === 'success' ? 0.35 : 0.8 }}
                  />

                  {/* Timestamp — relative for fast scanning, absolute on hover */}
                  <div className="flex items-center gap-2 min-w-0" title={formatTime(log.timestamp)}>
                    <Clock size={14} className="text-brand-400 shrink-0" />
                    <ExpandableCell text={relativeTime(log.timestamp)} mono className="text-slate-400 tabular-nums" />
                  </div>

                  {/* User */}
                  <ExpandableCell
                    text={log.username || '—'}
                    className="font-medium text-slate-200"
                    sub={log.user_id ? log.user_id : null}
                  />

                  {/* Action badge */}
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-8 h-8 rounded-md border flex items-center justify-center shrink-0 ${meta.bg}`}>
                      <ActionIcon size={16} className={meta.color} />
                    </span>
                    <ExpandableCell text={meta.label} className={`font-medium ${meta.color}`} />
                  </div>

                  {/* Target */}
                  <ExpandableCell
                    text={getTarget(log)}
                    mono
                    className="text-slate-300"
                    sub={[getTargetSub(log), log.details].filter(Boolean).join(' — ') || null}
                  />

                  {/* Source IP — column is `ip_source` in DB ── */}
                  <ExpandableCell text={log.ip_source || '—'} mono className="text-slate-500 tabular-nums" />

                  {/* Result — right-aligned so badges form a clean vertical
                      edge instead of ragging left inside a wide column */}
                  <div className="justify-self-end">
                    {resMeta ? (
                      <span className={`inline-flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-md text-sm font-body font-medium border ${resMeta.cls}`}>
                        <ResIcon size={14} />
                        {resMeta.label}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-md text-sm font-body font-medium border text-slate-500 bg-surface-4 border-white/10">
                        <AlertCircle size={14} />
                        {result}
                      </span>
                    )}
                  </div>

                  {/* Sync — syslog forwarding status for this event */}
                  {showSync && (
                    <div className="justify-self-center">
                      {log.syslog_synced === 1 || log.syslog_synced === true ? (
                        <span title="Forwarded to syslog server" className="inline-flex items-center gap-1 text-accent-cyan">
                          <Radio size={16} />
                        </span>
                      ) : log.syslog_synced === 0 || log.syslog_synced === false ? (
                        <span title="Syslog forward failed" className="inline-flex items-center gap-1 text-accent-red">
                          <XCircle size={16} />
                        </span>
                      ) : (
                        <span title="Not forwarded (syslog disabled or not yet attempted)" className="inline-flex items-center gap-1 text-brand-400/70">
                          <MinusCircle size={16} />
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
                  })}
                  {bottomPad > 0 && <div style={{ height: bottomPad }} />}
                </>
              )
            })()}
          </div>
        )}
        </div>
      </div>

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>
            Page <span style={{ color: 'var(--text-secondary)' }}>{page}</span> of {totalPages} · {total} events
          </p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-ghost py-1.5 px-3 disabled:opacity-30 text-sm"
            >
              <ChevronLeft size={16} className="text-brand-400" /> Prev
            </button>

            {/* Page number pills */}
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const pg = Math.max(1, Math.min(totalPages - 4, page - 2)) + i
              return (
                <button
                  key={pg}
                  onClick={() => setPage(pg)}
                  className={`w-9 h-9 rounded-lg text-sm font-body transition-all ${
                    pg === page
                      ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30'
                      : 'hover:bg-surface-3'
                  }`}
                  style={pg === page ? {} : { color: 'var(--text-muted)' }}
                >
                  {pg}
                </button>
              )
            })}

            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="btn-ghost py-1.5 px-3 disabled:opacity-30 text-sm"
            >
              Next <ChevronRight size={16} className="text-brand-400" />
            </button>
          </div>
        </div>
      )}
      </>
      )}

      {selectedLog && (
        <AuditDetailDrawer log={selectedLog} showSync={showSync} onClose={() => setSelectedLog(null)} />
      )}

      <ScheduleLogExportModal
        open={scheduleModalOpen}
        onClose={() => setScheduleModalOpen(false)}
        onSaved={fetchSchedules}
        destinations={destinations}
        syslogConfigured={!!syslogStatus?.enabled}
        editing={editingSchedule}
      />

      <ActionConfirmModal
        open={!!deleteScheduleTarget}
        onClose={() => setDeleteScheduleTarget(null)}
        title="Delete Scheduled Export"
        description={`This will permanently delete "${deleteScheduleTarget?.name}". This action cannot be undone.`}
        danger
        onConfirm={async (pin) => {
          await api.delete(`/log-export-schedules/${deleteScheduleTarget.id}`, { data: { actionPin: pin } })
          toast.success('Schedule deleted')
          fetchSchedules()
          setDeleteScheduleTarget(null)
        }}
      />
    </div>
  )
}