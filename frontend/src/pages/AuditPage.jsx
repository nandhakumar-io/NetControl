import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import {
  ScrollText, Search, RefreshCw, Zap, Power, RotateCcw,
  Shield, ChevronLeft, ChevronRight, UserCheck,
  Plus, Pencil, Trash2, Clock, CheckCircle2, XCircle, AlertCircle,
  Radio, Download, FileSpreadsheet, FileText, ChevronDown, Settings2, MinusCircle,
  Calendar, X as XIcon
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import SnmpSettingsModal from '../components/modals/SnmpSettingsModal'
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

// ── Expandable cell ─────────────────────────────────────────────────────────
// Content stays truncated so the table stays tidy and never grows a row's
// height. If (and only if) it actually overflows its column, hovering (or
// focusing, for keyboard users) reveals the full value in a small floating
// card that sits *above* the layout — nothing ever reflows or pushes rows.
function ExpandableCell({ text, className = '', mono = false, sub = null }) {
  const ref = useRef(null)
  const [overflowing, setOverflowing] = useState(false)
  const [hovered, setHovered] = useState(false)

  useLayoutEffect(() => {
    setHovered(false)
    const el = ref.current
    if (!el) return
    setOverflowing(el.scrollWidth > el.clientWidth + 1)
  }, [text])

  if (text === null || text === undefined || text === '') {
    return <span className="text-sm" style={{ color: 'var(--text-faint)' }}>—</span>
  }

  return (
    <div
      className="relative min-w-0"
      onMouseEnter={() => overflowing && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        tabIndex={overflowing ? 0 : undefined}
        onFocus={() => overflowing && setHovered(true)}
        onBlur={() => setHovered(false)}
        className={[
          'text-sm truncate rounded outline-none',
          mono ? 'font-mono' : 'font-body',
          className,
          overflowing ? 'cursor-help underline decoration-dotted decoration-1 underline-offset-4 focus-visible:ring-2 focus-visible:ring-brand-400/50' : '',
        ].join(' ')}
        style={overflowing ? { textDecorationColor: 'var(--border-strong)' } : undefined}
      >
        <span ref={ref} className="block truncate">{text}</span>
      </div>
      {sub && (
        <p className="text-xs font-body truncate mt-0.5 capitalize" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </p>
      )}

      {/* Floating "expanded" card — only ever rendered on hover/focus, so it
          never affects the height of the row or the columns around it. */}
      {hovered && (
        <div
          role="tooltip"
          className="absolute left-0 top-full mt-1.5 z-30 w-max max-w-[22rem] rounded-lg px-3 py-2 animate-fade-in"
          style={{
            background: 'var(--bg-surface-1)',
            border: '1px solid var(--border-mid)',
            boxShadow: 'var(--glass-shadow)',
          }}
        >
          <p
            className={`text-sm break-words ${mono ? 'font-mono' : 'font-body'}`}
            style={{ color: 'var(--text-primary)' }}
          >
            {text}
          </p>
          {sub && (
            <p className="text-xs font-body capitalize mt-1 break-words" style={{ color: 'var(--text-muted)' }}>
              {sub}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Skeleton row ─────────────────────────────────────────────────────────────
function SkeletonRow({ gridCols, showSync }) {
  return (
    <div className="grid items-center gap-4 px-5 py-4 border-b animate-pulse"
      style={{ gridTemplateColumns: gridCols, borderColor: 'var(--border-subtle)' }}>
      <div className="h-3.5 rounded w-5/6" style={{background:"var(--bg-input)"}} />
      <div className="h-3.5 rounded w-3/4" style={{background:"var(--bg-input)"}} />
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-md shrink-0" style={{background:"var(--bg-input)"}} />
        <div className="h-3.5 rounded w-16" style={{background:"var(--bg-input)"}} />
      </div>
      <div className="h-3.5 rounded w-2/3" style={{background:"var(--bg-input)"}} />
      <div className="h-3.5 rounded w-4/5" style={{background:"var(--bg-input)"}} />
      <div className="h-5 rounded-full w-20" style={{background:"var(--bg-input)"}} />
      {showSync && <div className="h-3.5 rounded w-8" style={{background:"var(--bg-input)"}} />}
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

// ── SNMP sync badge ──────────────────────────────────────────────────────────
function SnmpBadge({ status, isAdmin, onOpenSettings }) {
  if (!status) return null
  const enabled = status.enabled

  return (
    <button
      onClick={onOpenSettings}
      disabled={!isAdmin}
      title={isAdmin ? 'Configure SNMP forwarding' : (enabled ? `Forwarding to ${status.host}` : 'SNMP forwarding disabled')}
      className={`flex items-center gap-1.5 px-3 h-9 rounded-lg border text-sm font-body transition-colors ${
        enabled
          ? 'bg-accent-cyan/10 border-accent-cyan/25 text-accent-cyan hover:bg-accent-cyan/15'
          : 'icon-btn !h-9'
      } ${isAdmin ? 'cursor-pointer' : 'cursor-default'}`}
    >
      {enabled ? <Radio size={16} /> : <MinusCircle size={16} className="text-brand-400" />}
      <span className="hidden sm:inline">{enabled ? 'SNMP Sync On' : 'SNMP Sync Off'}</span>
      {isAdmin && <Settings2 size={14} className="ml-0.5" style={{ color: 'var(--text-muted)' }} />}
    </button>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function AuditPage() {
  const [logs, setLogs]               = useState([])
  const [total, setTotal]             = useState(0)
  const [tallies, setTallies]         = useState({ success: 0, failure: 0, partial: 0, synced: 0 })
  const [loading, setLoading]         = useState(true)
  const [page, setPage]               = useState(1)
  const [search, setSearch]           = useState('')
  const [actionFilter, setActionFilter] = useState('all')
  const [resultFilter, setResultFilter] = useState('all')
  const [fromDate, setFromDate]       = useState('') // yyyy-mm-dd, inclusive
  const [toDate, setToDate]           = useState('') // yyyy-mm-dd, inclusive
  const [exportFormat, setExportFormat] = useState(null) // 'csv' | 'txt' | null while exporting
  const [snmpStatus, setSnmpStatus]   = useState(null)
  const [snmpModalOpen, setSnmpModalOpen] = useState(false)
  const { isAdmin } = usePermissions()
  const LIMIT = 25

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

  const fetchSnmpStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/audit/snmp/status')
      setSnmpStatus(data)
    } catch { /* non-critical — badge just stays hidden */ }
  }, [])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  useEffect(() => { fetchSnmpStatus() }, [fetchSnmpStatus])
  useEffect(() => { setPage(1) }, [search, actionFilter, resultFilter, fromDate, toDate])

  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  // The Sync column only earns its place once SNMP forwarding is (or has
  // ever been) relevant — otherwise it's a column of dashes wasting space.
  const showSync = !!(snmpStatus?.enabled || tallies.synced > 0)
  const gridCols = showSync
    ? '190px 160px 150px 1fr 150px 110px 76px'
    : '200px 175px 160px 1fr 160px 110px'

  const handleExport = async (format) => {
    setExportFormat(format)
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
      toast.success(`Audit log exported as ${format.toUpperCase()}`)
    } catch {
      toast.error('Export failed')
    } finally {
      setExportFormat(null)
    }
  }

  return (
    <div className="p-6 max-w-[1760px] mx-auto animate-fade-in">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <PageHeader
        icon={ScrollText}
        title="Audit Log"
        description="Complete record of all actions and authentication events"
        iconColor="text-accent-orange"
        iconBg="bg-accent-orange/15 border-accent-orange/25"
        actions={
          <>
            <SnmpBadge status={snmpStatus} isAdmin={isAdmin} onOpenSettings={() => setSnmpModalOpen(true)} />
            <ExportMenu onExport={handleExport} exporting={!!exportFormat} />
            <button onClick={() => { fetchLogs(); fetchSnmpStatus() }} className="btn-ghost" disabled={loading}>
              <RefreshCw size={16} className={`text-brand-400 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </>
        }
      />

      <SnmpSettingsModal
        open={snmpModalOpen}
        onClose={() => setSnmpModalOpen(false)}
        onSaved={fetchSnmpStatus}
      />

      {/* ── Security notice ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-brand-500/8 border border-brand-500/20 mb-6">
        <Shield size={18} className="text-brand-400 shrink-0" />
        <p className="text-sm font-body leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          All power actions are recorded with timestamp, user, source IP, and result.
          This log <span className="font-medium" style={{ color: 'var(--text-primary)' }}>cannot be modified or deleted</span> by normal users.
        </p>
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="glass rounded-xl border border-white/8 px-4 py-3.5 mb-5 space-y-3">

        {/* Row 1: search + date range, side by side since both are "narrow the
            time/entity window" controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] max-w-sm flex-1">
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
          <div className="flex items-center gap-1.5">
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
                className="p-1.5 rounded-md transition-colors"
                style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
              >
                <XIcon size={16} />
              </button>
            )}
          </div>

          {/* Count moves up here so it's not fighting the chips for space */}
          <div className="ml-auto flex items-center gap-3">
          {!loading && (
            <>
              <span className="flex items-center gap-1.5 text-sm text-accent-green font-body">
                <CheckCircle2 size={14} /> {tallies.success} ok
              </span>
              <span className="flex items-center gap-1.5 text-sm text-accent-red font-body">
                <XCircle size={14} /> {tallies.failure} failed
              </span>
              {snmpStatus?.enabled && (
                <span className="flex items-center gap-1.5 text-sm text-accent-cyan font-body">
                  <Radio size={14} /> {tallies.synced} synced
                </span>
              )}
              <span style={{ color: 'var(--text-faint)' }}>·</span>
            </>
          )}
            <span className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>{total} total events</span>
          </div>
        </div>

        {/* Row 2: categorical filters, each group clearly labeled so it
            doesn't read as one undifferentiated wall of chips */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-3 border-t border-white/6">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-body font-semibold uppercase tracking-widest mr-0.5" style={{ color: 'var(--text-muted)' }}>Action</span>
            {FILTER_ACTIONS.map(a => (
              <button key={a} onClick={() => setActionFilter(a)}
                className={`chip h-8 px-3 text-sm capitalize ${actionFilter === a ? 'chip-selected' : ''}`}>
                {a === 'all' ? 'All' : (ACTION_META[a]?.label ?? a)}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-body font-semibold uppercase tracking-widest mr-0.5" style={{ color: 'var(--text-muted)' }}>Result</span>
            {FILTER_RESULTS.map(r => (
              <button key={r} onClick={() => setResultFilter(r)}
                className={`chip h-8 px-3 text-sm capitalize ${resultFilter === r ? 'chip-selected' : ''}`}>
                {r === 'all' ? 'All' : r.charAt(0).toUpperCase() + r.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="glass rounded-xl border border-white/8 overflow-visible">

        {/* Table header */}
        <div
          className="grid items-center gap-4 px-5 py-3 border-b border-white/10 bg-surface-2/60"
          style={{ gridTemplateColumns: gridCols }}
        >
          {['Timestamp', 'User', 'Action', 'Target', 'Source IP', 'Result'].map(h => (
            <span key={h} className="text-xs font-body font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
              {h}
            </span>
          ))}
          {showSync && (
            <span className="text-xs font-body font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
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
          </div>

        ) : (
          <div className="divide-y divide-white/5">
            {logs.map((log, i) => {
              const meta       = getMeta(log.action)
              const ActionIcon = meta.icon
              // ── result comes from `result` column, not `status` ──
              const result     = log.result || 'unknown'
              const resMeta    = RESULT_META[result]
              const ResIcon    = resMeta?.icon ?? AlertCircle

              return (
                <div
                  key={log.id ?? i}
                  className="grid items-start gap-4 px-5 py-3.5 hover:bg-surface-3/40 transition-colors group"
                  style={{ gridTemplateColumns: gridCols }}
                >
                  {/* Timestamp */}
                  <div className="flex items-center gap-2 min-w-0">
                    <Clock size={14} className="text-brand-400 shrink-0" />
                    <ExpandableCell text={formatTime(log.timestamp)} mono className="text-slate-400" />
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
                  <ExpandableCell text={log.ip_source || '—'} mono className="text-slate-500" />

                  {/* Result */}
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

                  {/* Sync — SNMP trap forwarding status for this event */}
                  {showSync && (
                    log.snmp_synced === 1 || log.snmp_synced === true ? (
                      <span title="Forwarded to SNMP server" className="inline-flex items-center gap-1 text-accent-cyan">
                        <Radio size={16} />
                      </span>
                    ) : log.snmp_synced === 0 || log.snmp_synced === false ? (
                      <span title="SNMP forward failed" className="inline-flex items-center gap-1 text-accent-red">
                        <XCircle size={16} />
                      </span>
                    ) : (
                      <span title="Not forwarded (SNMP disabled or not yet attempted)" className="inline-flex items-center gap-1 text-brand-400/70">
                        <MinusCircle size={16} />
                      </span>
                    )
                  )}
                </div>
              )
            })}
          </div>
        )}
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
    </div>
  )
}
