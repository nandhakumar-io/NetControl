import React, { useState, useEffect, useCallback } from 'react'
import {
  ScrollText, Search, RefreshCw, Zap, Power, RotateCcw,
  Shield, ChevronLeft, ChevronRight, Monitor, UserCheck,
  Plus, Pencil, Trash2, Clock, CheckCircle2, XCircle, AlertCircle
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
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
const FILTER_RESULTS = ['all', 'success', 'failure']

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
    icon: Shield, color: 'text-slate-400', bg: 'bg-surface-4 border-white/10', label: action || '—',
  }
}

// ── Skeleton row ─────────────────────────────────────────────────────────────
function SkeletonRow() {
  return (
    <div className="grid items-center gap-4 px-5 py-3.5 border-b border-white/5 animate-pulse"
      style={{ gridTemplateColumns: '160px 110px 130px 1fr 140px 90px' }}>
      <div className="h-3 bg-surface-4 rounded w-5/6" />
      <div className="h-3 bg-surface-4 rounded w-3/4" />
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-md bg-surface-4 shrink-0" />
        <div className="h-3 bg-surface-4 rounded w-16" />
      </div>
      <div className="h-3 bg-surface-4 rounded w-2/3" />
      <div className="h-3 bg-surface-4 rounded w-4/5" />
      <div className="h-5 bg-surface-4 rounded-full w-20" />
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function AuditPage() {
  const [logs, setLogs]               = useState([])
  const [total, setTotal]             = useState(0)
  const [loading, setLoading]         = useState(true)
  const [page, setPage]               = useState(1)
  const [search, setSearch]           = useState('')
  const [actionFilter, setActionFilter] = useState('all')
  const [resultFilter, setResultFilter] = useState('all')
  const LIMIT = 25

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page, limit: LIMIT })
      if (search)                       params.set('search', search)
      if (actionFilter !== 'all')       params.set('action', actionFilter)
      // backend column is `result`, not `status`
      if (resultFilter !== 'all')       params.set('result', resultFilter)

      const { data } = await api.get(`/audit?${params}`)
      setLogs(data.logs ?? data)
      setTotal(data.total ?? (Array.isArray(data) ? data.length : 0))
    } catch {
      toast.error('Failed to load audit log')
    } finally {
      setLoading(false)
    }
  }, [page, search, actionFilter, resultFilter])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  useEffect(() => { setPage(1) }, [search, actionFilter, resultFilter])

  const totalPages = Math.max(1, Math.ceil(total / LIMIT))

  // Summary counts from current page (rough indicators)
  const successCount = logs.filter(l => l.result === 'success').length
  const failureCount = logs.filter(l => l.result === 'failure').length

  return (
    <div className="p-6 max-w-[1400px] mx-auto animate-fade-in">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <PageHeader
        icon={ScrollText}
        title="Audit Log"
        description="Complete record of all actions and authentication events"
        iconColor="text-accent-orange"
        iconBg="bg-accent-orange/15 border-accent-orange/25"
        actions={
          <button onClick={fetchLogs} className="btn-ghost" disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        }
      />

      {/* ── Security notice ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-brand-500/8 border border-brand-500/20 mb-6">
        <Shield size={15} className="text-brand-400 shrink-0" />
        <p className="text-xs text-slate-300 font-body leading-relaxed">
          All power actions are recorded with timestamp, user, source IP, and result.
          This log <span className="text-slate-200 font-medium">cannot be modified or deleted</span> by normal users.
        </p>
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 mb-5">

        {/* Search */}
        <div className="relative min-w-[200px] max-w-xs flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            className="input-field pl-8 h-9 text-sm"
            placeholder="Search user, device…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Action filter */}
        <div className="flex flex-wrap gap-1.5">
          {FILTER_ACTIONS.map(a => (
            <button key={a} onClick={() => setActionFilter(a)}
              className={`chip h-8 px-3 text-xs capitalize ${actionFilter === a ? 'chip-selected' : ''}`}>
              {a === 'all' ? 'All Actions' : (ACTION_META[a]?.label ?? a)}
            </button>
          ))}
        </div>

        {/* Result filter */}
        <div className="flex gap-1.5">
          {FILTER_RESULTS.map(r => (
            <button key={r} onClick={() => setResultFilter(r)}
              className={`chip h-8 px-3 text-xs capitalize ${resultFilter === r ? 'chip-selected' : ''}`}>
              {r === 'all' ? 'All Results' : r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>

        {/* Spacer + count */}
        <div className="ml-auto flex items-center gap-3">
          {!loading && (
            <>
              <span className="flex items-center gap-1 text-xs text-accent-green font-body">
                <CheckCircle2 size={11} /> {successCount} ok
              </span>
              <span className="flex items-center gap-1 text-xs text-accent-red font-body">
                <XCircle size={11} /> {failureCount} failed
              </span>
              <span className="text-slate-700">·</span>
            </>
          )}
          <span className="text-xs text-slate-500 font-body">{total} total events</span>
        </div>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="glass rounded-xl border border-white/8 overflow-hidden">

        {/* Table header */}
        <div
          className="grid items-center gap-4 px-5 py-3 border-b border-white/10 bg-surface-2/60"
          style={{ gridTemplateColumns: '160px 110px 130px 1fr 140px 90px' }}
        >
          {['Timestamp', 'User', 'Action', 'Target', 'Source IP', 'Result'].map(h => (
            <span key={h} className="text-[10px] font-body font-semibold text-slate-500 uppercase tracking-widest">
              {h}
            </span>
          ))}
        </div>

        {/* Rows */}
        {loading ? (
          <div>{Array.from({ length: 10 }).map((_, i) => <SkeletonRow key={i} />)}</div>

        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-12 h-12 rounded-2xl bg-surface-3 border border-white/6 flex items-center justify-center">
              <ScrollText size={20} className="text-slate-600" />
            </div>
            <p className="text-slate-400 font-body text-sm">No audit events found</p>
            <p className="text-slate-600 font-body text-xs">Try adjusting your filters</p>
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
                  className="grid items-center gap-4 px-5 py-3 hover:bg-surface-3/40 transition-colors group"
                  style={{ gridTemplateColumns: '160px 110px 130px 1fr 140px 90px' }}
                >
                  {/* Timestamp */}
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Clock size={10} className="text-slate-600 shrink-0" />
                    <span className="text-[11px] font-mono text-slate-400 truncate">
                      {formatTime(log.timestamp)}
                    </span>
                  </div>

                  {/* User */}
                  <div className="min-w-0">
                    <p className="text-xs font-body font-medium text-slate-200 truncate">
                      {log.username || '—'}
                    </p>
                    {log.user_id && (
                      <p className="text-[10px] font-mono text-slate-600 truncate">{log.user_id.slice(0, 8)}…</p>
                    )}
                  </div>

                  {/* Action badge */}
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-6 h-6 rounded-md border flex items-center justify-center shrink-0 ${meta.bg}`}>
                      <ActionIcon size={11} className={meta.color} />
                    </span>
                    <span className={`text-xs font-body font-medium truncate ${meta.color}`}>
                      {meta.label}
                    </span>
                  </div>

                  {/* Target */}
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-slate-300 truncate">
                      {getTarget(log)}
                    </p>
                    {getTargetSub(log) && (
                      <p className="text-[10px] font-body text-slate-600 capitalize truncate">
                        {getTargetSub(log)}
                      </p>
                    )}
                    {log.details && (
                      <p className="text-[10px] font-body text-slate-600 truncate" title={log.details}>
                        {log.details}
                      </p>
                    )}
                  </div>

                  {/* Source IP — column is `ip_source` in DB ── */}
                  <span className="text-xs font-mono text-slate-500 truncate">
                    {log.ip_source || '—'}
                  </span>

                  {/* Result */}
                  {resMeta ? (
                    <span className={`inline-flex items-center gap-1 w-fit px-2 py-0.5 rounded-md text-[11px] font-body font-medium border ${resMeta.cls}`}>
                      <ResIcon size={10} />
                      {resMeta.label}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 w-fit px-2 py-0.5 rounded-md text-[11px] font-body font-medium border text-slate-500 bg-surface-4 border-white/10">
                      <AlertCircle size={10} />
                      {result}
                    </span>
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
          <p className="text-xs text-slate-500 font-body">
            Page <span className="text-slate-300">{page}</span> of {totalPages} · {total} events
          </p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-ghost py-1.5 px-3 disabled:opacity-30 text-xs"
            >
              <ChevronLeft size={13} /> Prev
            </button>

            {/* Page number pills */}
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const pg = Math.max(1, Math.min(totalPages - 4, page - 2)) + i
              return (
                <button
                  key={pg}
                  onClick={() => setPage(pg)}
                  className={`w-8 h-8 rounded-lg text-xs font-body transition-all ${
                    pg === page
                      ? 'bg-brand-500/20 text-brand-400 border border-brand-500/30'
                      : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'
                  }`}
                >
                  {pg}
                </button>
              )
            })}

            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="btn-ghost py-1.5 px-3 disabled:opacity-30 text-xs"
            >
              Next <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
