// pages/BulkCommandPage.jsx — "run this one command across N devices and
// watch the results stream in live, retry the ones that failed."
//
// The backend for this (services/bulkCommand.js, routes/bulkCommand.js)
// was fully built: a bounded-concurrency SSH/WinRM fan-out with an SSE
// event stream keyed by runId, replaying everything so far to any client
// that connects mid-run or just after. It just had no frontend and wasn't
// even mounted in server.js. This page is the console: pick devices (by
// group or individually), type a command, confirm with the action PIN,
// and watch per-device rows flip from pending → running → success/failure
// as the stream arrives. Failed devices can be re-run in one click, which
// is just a fresh POST /run scoped to their ids — same pattern the backend
// comment describes as "stdlib-simple retry."
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  TerminalSquare, Search, Loader2, Play, RotateCcw, CheckCircle2, XCircle,
  Circle, ChevronDown, ChevronRight, Square, CheckSquare, ShieldAlert,
  X, Server, Wifi, WifiOff, HelpCircle, Copy, Check,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'

const STATUS_DOT = {
  online:  'bg-accent-green',
  offline: 'bg-slate-500',
  unknown: 'bg-amber-400',
  error:   'bg-red-400',
}

// ── Per-device result row in the live console ──────────────────────────────
function ResultRow({ id, name, ip, state }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const st = state?.status || 'pending'

  const cfg = {
    pending: { icon: Circle,       color: 'var(--text-faint)', label: 'Queued' },
    running: { icon: Loader2,      color: '#60a5fa', label: 'Running', spin: true },
    success: { icon: CheckCircle2, color: '#34d399', label: 'Success' },
    failure: { icon: XCircle,      color: '#f87171', label: 'Failed' },
  }[st]
  const Icon = cfg.icon
  const hasOutput = !!state?.output

  const copyOutput = (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(state.output || '').then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
      <div
        className={`flex items-center gap-3 px-3 py-2.5 ${hasOutput ? 'cursor-pointer hover:bg-white/[0.02]' : ''}`}
        onClick={() => hasOutput && setOpen(o => !o)}
      >
        {hasOutput
          ? (open ? <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />)
          : <span className="w-3" />}
        <Icon size={15} className={cfg.spin ? 'animate-spin' : ''} style={{ color: cfg.color }} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-body font-medium truncate" style={{ color: 'var(--text-primary)' }}>{name}</p>
          <p className="text-[11px] font-mono truncate" style={{ color: 'var(--text-faint)' }}>{ip}</p>
        </div>
        {state?.durationMs != null && (
          <span className="text-[11px] font-body shrink-0" style={{ color: 'var(--text-faint)' }}>{state.durationMs}ms</span>
        )}
        <span className="text-xs font-body font-semibold shrink-0 w-16 text-right" style={{ color: cfg.color }}>{cfg.label}</span>
      </div>
      {open && hasOutput && (
        <div className="px-3 pb-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="relative mt-2">
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all rounded-lg p-3 max-h-64 overflow-y-auto"
              style={{ background: 'var(--bg-input)', color: st === 'failure' ? '#fca5a5' : 'var(--text-secondary)' }}>
              {state.output}
            </pre>
            <button onClick={copyOutput} className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-white/10"
              style={{ color: 'var(--text-muted)' }} title="Copy output">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function BulkCommandPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const preselectDeviceId = searchParams.get('deviceId')

  const [devices, setDevices] = useState([])
  const [loadingDevices, setLoadingDevices] = useState(true)
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('all')
  const [selected, setSelected] = useState(new Set())

  const [command, setCommand] = useState('')
  const [pinOpen, setPinOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [runId, setRunId] = useState(null)
  const [runDevices, setRunDevices] = useState([])   // devices included in the active/last run
  const [results, setResults] = useState({})          // deviceId -> { status, output, durationMs }
  const [runStatus, setRunStatus] = useState(null)    // null | 'running' | 'done'
  const esRef = useRef(null)

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true)
    try {
      const { data } = await api.get('/bulk-command/devices')
      setDevices(data)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load devices')
    } finally { setLoadingDevices(false) }
  }, [])

  useEffect(() => { loadDevices() }, [loadDevices])
  useEffect(() => () => esRef.current?.close(), [])

  // ── Deep-link preselect: /bulk-command?deviceId=... (e.g. the "Run
  // command" quick action on a Capacity Forecast row) ────────────────────
  useEffect(() => {
    if (!preselectDeviceId || loadingDevices) return
    const match = devices.find(d => d.id === preselectDeviceId)
    if (match) {
      setSelected(prev => new Set(prev).add(match.id))
      toast.success(`${match.name} selected — type a command to run on it`)
    } else {
      toast.error('That device is not available here (wrong org, or it no longer exists)')
    }
    // Drop the query param once handled so it doesn't re-fire on refresh/tab switches.
    setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('deviceId'); return next }, { replace: true })
  }, [preselectDeviceId, loadingDevices, devices, setSearchParams])

  const groups = useMemo(() => {
    const map = new Map()
    for (const d of devices) map.set(d.group_id || 'ungrouped', d.group_name || 'Ungrouped')
    return [...map.entries()]
  }, [devices])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return devices.filter(d => {
      if (groupFilter !== 'all' && (d.group_id || 'ungrouped') !== groupFilter) return false
      if (!q) return true
      return d.name.toLowerCase().includes(q) || d.ip_address?.toLowerCase().includes(q)
    })
  }, [devices, search, groupFilter])

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const toggleAllFiltered = () => {
    const allSelected = filtered.length > 0 && filtered.every(d => selected.has(d.id))
    setSelected(prev => {
      const next = new Set(prev)
      filtered.forEach(d => allSelected ? next.delete(d.id) : next.add(d.id))
      return next
    })
  }

  // ── Kick off a run against a specific set of device ids (used both for
  // the initial submit and for "Retry failed") ──────────────────────────
  const runAgainst = async (deviceIds, actionPin) => {
    setSubmitting(true)
    try {
      const { data } = await api.post('/bulk-command/run', { actionPin, command, deviceIds })
      if (data.skipped?.length) {
        data.skipped.forEach(s => toast.error(`${s.deviceName || s.deviceId}: ${s.reason}`, { duration: 4000 }))
      }
      const included = devices.filter(d => deviceIds.includes(d.id) && !data.skipped?.some(s => s.deviceId === d.id))
      setRunDevices(included)
      setResults({})
      setRunId(data.runId)
      setRunStatus('running')
      setPinOpen(false); setPin(''); setPinError('')
      attachStream(data.runId)
      toast.success(`Running on ${data.total} device${data.total === 1 ? '' : 's'}…`)
    } catch (err) {
      setPinError(err.response?.data?.error || 'Failed to start run')
    } finally { setSubmitting(false) }
  }

  const attachStream = (id) => {
    esRef.current?.close()
    const token = localStorage.getItem('nc_token')
    const es = new EventSource(`${api.defaults.baseURL}/bulk-command/${id}/stream?token=${encodeURIComponent(token)}`)
    esRef.current = es
    es.onmessage = (e) => {
      let ev
      try { ev = JSON.parse(e.data) } catch { return }
      if (ev.type === 'device_start') {
        setResults(prev => ({ ...prev, [ev.deviceId]: { status: 'running' } }))
      } else if (ev.type === 'device_result') {
        setResults(prev => ({ ...prev, [ev.deviceId]: { status: ev.status, output: ev.output, durationMs: ev.durationMs } }))
      } else if (ev.type === 'done') {
        setRunStatus('done')
        es.close()
      } else if (ev.type === 'fatal') {
        toast.error(ev.message || 'Run failed')
        setRunStatus('done')
        es.close()
      }
    }
    es.onerror = () => { /* EventSource auto-retries; final 'done' event closes it cleanly on success */ }
  }

  const handleSubmit = () => {
    if (!command.trim()) { toast.error('Enter a command to run'); return }
    if (selected.size === 0) { toast.error('Select at least one device'); return }
    setPinOpen(true)
  }

  const confirmPin = () => {
    if (!pin.trim()) { setPinError('Action PIN is required'); return }
    runAgainst([...selected], pin)
  }

  const failedIds = Object.entries(results).filter(([, r]) => r.status === 'failure').map(([id]) => id)
  const retryFailed = () => {
    if (!failedIds.length) return
    setPin(''); setPinError(''); setPinOpen(true)
    // Stash which ids a retry should target — reuse selected state so the
    // same confirmPin/runAgainst path works for both first-run and retry.
    setSelected(new Set(failedIds))
  }

  const counts = useMemo(() => {
    const vals = Object.values(results)
    return {
      running: vals.filter(r => r.status === 'running').length,
      success: vals.filter(r => r.status === 'success').length,
      failure: vals.filter(r => r.status === 'failure').length,
    }
  }, [results])

  return (
    <div>
      <PageHeader
        icon={TerminalSquare}
        title="Bulk Command"
        description="Run one command across many devices at once and watch results stream in live."
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-5">
        {/* ── Left: device picker + command ── */}
        <div className="space-y-4">
          <div className="card p-0 overflow-hidden">
            <div className="p-4 pb-3 flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-faint)' }} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search devices…"
                  className="input-field pl-8 py-2 text-sm"
                />
              </div>
              <select
                value={groupFilter}
                onChange={e => setGroupFilter(e.target.value)}
                className="input-field py-2 text-sm w-36 shrink-0"
              >
                <option value="all">All groups</option>
                {groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>

            <div className="px-4 pb-2 flex items-center justify-between">
              <button onClick={toggleAllFiltered} className="flex items-center gap-1.5 text-xs font-body font-medium" style={{ color: 'var(--text-muted)' }}>
                {filtered.length > 0 && filtered.every(d => selected.has(d.id))
                  ? <CheckSquare size={13} /> : <Square size={13} />}
                Select all ({filtered.length})
              </button>
              <span className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>{selected.size} selected</span>
            </div>

            <div className="max-h-[360px] overflow-y-auto px-2 pb-2">
              {loadingDevices ? (
                <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
              ) : filtered.length === 0 ? (
                <p className="text-center text-xs font-body py-8" style={{ color: 'var(--text-muted)' }}>No devices match.</p>
              ) : filtered.map(d => (
                <div
                  key={d.id}
                  onClick={() => toggle(d.id)}
                  className="flex items-center gap-2.5 px-2 py-2 rounded-lg cursor-pointer hover:bg-white/[0.03]"
                >
                  {selected.has(d.id) ? <CheckSquare size={14} style={{ color: '#6c5ce7' }} /> : <Square size={14} style={{ color: 'var(--text-faint)' }} />}
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[d.status] || STATUS_DOT.unknown}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-body truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</p>
                    <p className="text-[11px] font-mono truncate" style={{ color: 'var(--text-faint)' }}>{d.ip_address} · {d.group_name || 'Ungrouped'}</p>
                  </div>
                  <span className="text-[10px] font-body uppercase shrink-0" style={{ color: 'var(--text-faint)' }}>{d.os_type}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <label className="label">Command</label>
            <textarea
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder="e.g. sudo apt update && sudo apt upgrade -y"
              rows={4}
              className="input-field font-mono text-sm resize-none"
            />
            <p className="text-[11px] font-body mt-1.5" style={{ color: 'var(--text-faint)' }}>
              Linux devices run this over SSH, Windows devices over WinRM — up to 8 at a time, 30s timeout per device.
            </p>
            <button
              onClick={handleSubmit}
              disabled={submitting || runStatus === 'running'}
              className="btn-primary w-full justify-center mt-4 flex items-center gap-2 disabled:opacity-40"
            >
              {runStatus === 'running' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {runStatus === 'running' ? 'Running…' : `Run on ${selected.size} device${selected.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>

        {/* ── Right: live console ── */}
        <div className="card p-0 overflow-hidden flex flex-col">
          <div className="p-4 flex items-center justify-between border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="text-sm font-display" style={{ color: 'var(--text-primary)' }}>Console</span>
            {runId && (
              <div className="flex items-center gap-2">
                {failedIds.length > 0 && runStatus === 'done' && (
                  <button onClick={retryFailed} className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5">
                    <RotateCcw size={12} /> Retry failed ({failedIds.length})
                  </button>
                )}
              </div>
            )}
          </div>

          {!runId ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 gap-2">
              <TerminalSquare size={26} style={{ color: 'var(--text-faint)' }} />
              <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>Select devices and run a command to see live results here.</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 p-4">
                <StatCard icon={Loader2} label="Running" value={counts.running} iconColor="text-blue-400" iconBg="bg-blue-400/10 border-blue-400/25" />
                <StatCard icon={CheckCircle2} label="Success" value={counts.success} iconColor="text-accent-green" iconBg="bg-accent-green/10 border-accent-green/25" />
                <StatCard icon={XCircle} label="Failed" value={counts.failure} iconColor="text-accent-red" iconBg="bg-accent-red/10 border-accent-red/25" />
              </div>
              <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-1.5">
                {runDevices.map(d => (
                  <ResultRow key={d.id} id={d.id} name={d.name} ip={d.ip_address} state={results[d.id]} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── PIN confirmation ── */}
      {pinOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => { setPinOpen(false); setPin(''); setPinError('') }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-md animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'rgba(108,92,231,0.25)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
              <div className="h-0.5 opacity-70 bg-[#6c5ce7]" />
              <div className="flex items-start justify-between p-6 pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#6c5ce7]/15 border border-[#6c5ce7]/25">
                    <ShieldAlert size={20} className="text-[#6c5ce7]" />
                  </div>
                  <div>
                    <h3 className="font-display text-base" style={{ color: 'var(--text-primary)' }}>Confirm Bulk Command</h3>
                    <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {selected.size} device{selected.size === 1 ? '' : 's'} · <span className="font-mono">{command.slice(0, 40)}{command.length > 40 ? '…' : ''}</span>
                    </p>
                  </div>
                </div>
                <button onClick={() => { setPinOpen(false); setPin(''); setPinError('') }} className="p-1 rounded-lg hover:text-accent-red" style={{ color: 'var(--text-muted)' }}>
                  <X size={16} />
                </button>
              </div>
              <div className="mx-6 mb-4 px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-xs font-body leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Security check:</span>{' '}
                  This runs arbitrary shell/PowerShell on every selected device and is fully audited per device.
                </p>
              </div>
              <div className="px-6 pb-6">
                <label className="label">Action PIN</label>
                <input
                  type="password"
                  autoFocus
                  value={pin}
                  onChange={e => { setPin(e.target.value); setPinError('') }}
                  onKeyDown={e => e.key === 'Enter' && confirmPin()}
                  placeholder="Enter your action PIN"
                  className={`input-field ${pinError ? 'border-accent-red/50' : ''}`}
                  autoComplete="off"
                />
                {pinError && <p className="text-xs text-accent-red mt-2 font-body">{pinError}</p>}
                <div className="flex gap-3 mt-5">
                  <button onClick={() => { setPinOpen(false); setPin(''); setPinError('') }} className="btn-ghost flex-1 justify-center" disabled={submitting}>Cancel</button>
                  <button onClick={confirmPin} disabled={submitting || !pin.trim()} className="btn-primary flex-1 justify-center flex items-center gap-2 disabled:opacity-40">
                    {submitting && <Loader2 size={14} className="animate-spin" />}
                    {submitting ? 'Starting…' : 'Confirm & Run'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}