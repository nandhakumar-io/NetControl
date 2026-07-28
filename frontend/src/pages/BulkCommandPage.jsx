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
  X, Server, Wifi, WifiOff, HelpCircle, Copy, Check, Clock, Star, Trash2,
  Download, AlertTriangle, Bookmark, Save, Pencil, Eye,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'
import { useHighlightParam } from '../hooks/useHighlightParam'

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

// Key used to persist the active/last bulk-command run's id across page
// navigation and reloads (see restoreRun in the component below).
export default function BulkCommandPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const preselectDeviceId = searchParams.get('deviceId')

  const [devices, setDevices] = useState([])
  const [loadingDevices, setLoadingDevices] = useState(true)
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('all')
  // Ad-hoc slice on top of the structural group filter — matches ANY of
  // the selected tags (OR), same semantics as the Devices page tag filter.
  const [tagFilter, setTagFilter] = useState(new Set())
  const [selected, setSelected] = useState(new Set())

  const [command, setCommand] = useState('')
  // Override for the 30s-per-device default — large or piped commands
  // (apt upgrade, multi-stage backups through gzip/ssh, etc.) can
  // legitimately need much longer than that. Bounds mirror the backend's
  // validation (5–3600s) so a bad value gets caught before the PIN dialog
  // rather than surfacing as a confusing 400 after confirming.
  const [timeoutSec, setTimeoutSec] = useState(30)
  const [history, setHistory] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [templates, setTemplates] = useState([])
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const highlightId = useHighlightParam(templates.length > 0)
  useEffect(() => {
    if (highlightId && templates.some(t => t.id === highlightId)) setTemplatesOpen(true)
  }, [highlightId, templates])
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [templateDescription, setTemplateDescription] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [templateSaveError, setTemplateSaveError] = useState('')
  const [pinOpen, setPinOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [dryRunOpen, setDryRunOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [pinTargetIds, setPinTargetIds] = useState(null) // ids the PIN dialog will actually run against (null = use `selected`)
  const [runId, setRunId] = useState(null)
  const [runDevices, setRunDevices] = useState([])   // devices included in the active/last run
  const [results, setResults] = useState({})          // deviceId -> { status, output, durationMs }
  const [runStatus, setRunStatus] = useState(null)    // null | 'running' | 'done'
  const [streamState, setStreamState] = useState('connected') // 'connected' | 'reconnecting' | 'stalled'
  const esRef = useRef(null)
  const errorCountRef = useRef(0)
  const lastMessageRef = useRef(0)

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true)
    try {
      const { data } = await api.get('/bulk-command/devices')
      setDevices(data)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load devices')
    } finally { setLoadingDevices(false) }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get('/bulk-command/history')
      setHistory(data)
    } catch {
      // Non-critical — the console still works fine with a blank textarea,
      // so just silently skip populating the dropdown rather than toasting.
    }
  }, [])

  const loadTemplates = useCallback(async () => {
    try {
      const { data } = await api.get('/bulk-command/templates')
      setTemplates(data)
    } catch {
      // Non-critical, same reasoning as loadHistory.
    }
  }, [])

  useEffect(() => { loadDevices(); loadHistory(); loadTemplates() }, [loadDevices, loadHistory, loadTemplates])
  useEffect(() => () => esRef.current?.close(), [])

  // ── Persist the active/last run across navigation ───────────────────────
  // Without this, leaving the page (even just to check another tab) and
  // coming back left the console completely blank — no way to tell if a
  // run was still going or see how it turned out, even though the backend
  // job/results were sitting right there in Redis the whole time (that's
  // what powers "Retry failed" and the SSE replay-on-reconnect). This just
  // remembers the runId locally and rebuilds everything else from the
  // backend on mount.
  const restoreRun = useCallback(async (id) => {
    try {
      const { data } = await api.get(`/bulk-command/${id}`)
      const { job, events } = data

      // Reconstruct results + progress purely from the replayed event log —
      // same source of truth the live SSE stream itself is built from.
      const restoredResults = {}
      let restoredCommand = job.command
      let restoredTimeoutSec = null
      for (const ev of events) {
        if (ev.type === 'start' && ev.timeoutMs) restoredTimeoutSec = Math.round(ev.timeoutMs / 1000)
        else if (ev.type === 'device_start') restoredResults[ev.deviceId] = { status: 'running' }
        else if (ev.type === 'device_result') restoredResults[ev.deviceId] = { status: ev.status, output: ev.output, durationMs: ev.durationMs }
      }

      // Prefer the live device list (fresher name/IP), but fall back to
      // whatever the run's own events said for a device that's since been
      // removed — so a completed run doesn't lose rows just because a
      // device was deleted afterward.
      const deviceIds = job.deviceIds?.length ? job.deviceIds : Object.keys(restoredResults)
      const eventNames = {}
      for (const ev of events) {
        if (ev.deviceId && ev.deviceName) eventNames[ev.deviceId] = ev.deviceName
      }
      const restoredDevices = deviceIds.map(devId => {
        const known = devices.find(d => d.id === devId)
        return known || { id: devId, name: eventNames[devId] || devId, ip_address: '—', os_type: null }
      })

      setCommand(restoredCommand)
      if (restoredTimeoutSec) setTimeoutSec(restoredTimeoutSec)
      setRunDevices(restoredDevices)
      setResults(restoredResults)
      setRunId(job.runId)
      setRunStatus(job.status === 'done' ? 'done' : 'running')
      if (job.status !== 'done') attachStream(job.runId)
    } catch (err) {
      // Job expired (30 min TTL) or otherwise gone — nothing to restore.
      // The server-side pointer (user_last_bulk_run) self-cleans on the
      // next GET /bulk-command/active, so there's nothing to do here.
    }
  }, [devices]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loadingDevices) return // wait for the device list so name/IP lookups resolve
    // Cross-browser resume pointer — replaces the old localStorage-only
    // nc_bulk_command_last_run_id, which meant switching browsers (or even
    // just a different profile) always showed a blank console even while
    // the run was still live and fully tracked server-side.
    api.get('/bulk-command/active')
      .then(({ data }) => { if (data.runId) restoreRun(data.runId) })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingDevices])

  const useHistoryCommand = (cmd) => {
    setCommand(cmd)
    setHistoryOpen(false)
  }

  const toggleFavorite = async (entry, e) => {
    e.stopPropagation()
    const next = !entry.is_favorite
    setHistory(prev => prev.map(h => h.id === entry.id ? { ...h, is_favorite: next } : h)) // optimistic
    try {
      await api.post(`/bulk-command/history/${entry.id}/favorite`, { favorite: next })
    } catch {
      setHistory(prev => prev.map(h => h.id === entry.id ? { ...h, is_favorite: !next } : h)) // revert
      toast.error('Failed to update favorite')
    }
  }

  const deleteHistoryEntry = async (entry, e) => {
    e.stopPropagation()
    const prev = history
    setHistory(prev.filter(h => h.id !== entry.id)) // optimistic
    try {
      await api.delete(`/bulk-command/history/${entry.id}`)
    } catch {
      setHistory(prev)
      toast.error('Failed to remove')
    }
  }

  // ── Templates: load command + saved device selection in one click ───────
  // Unlike "Recent" (command text only), a template restores the full
  // target list too — that's the whole point: no re-picking devices for a
  // routine op. Devices removed since the template was saved are silently
  // dropped by the backend; we surface that here so it's not a silent
  // surprise when the run kicks off with fewer devices than expected.
  const useTemplate = async (t) => {
    try {
      const { data } = await api.post(`/bulk-command/templates/${t.id}/use`)
      setCommand(data.command)
      setTimeoutSec(data.timeoutSec || 30)
      setSelected(new Set(data.deviceIds))
      setTemplatesOpen(false)
      if (data.missingCount > 0) {
        toast(`${data.missingCount} device${data.missingCount === 1 ? '' : 's'} from "${t.name}" no longer exist and were skipped`, { icon: '⚠️' })
      } else {
        toast.success(`Loaded "${t.name}" — ${data.deviceIds.length} device${data.deviceIds.length === 1 ? '' : 's'}`)
      }
      loadTemplates() // pick up bumped use_count/last_used_at ordering
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load template')
    }
  }

  const deleteTemplate = async (t, e) => {
    e.stopPropagation()
    if (!window.confirm(`Delete template "${t.name}"?`)) return
    const prev = templates
    setTemplates(prev.filter(x => x.id !== t.id)) // optimistic
    try {
      await api.delete(`/bulk-command/templates/${t.id}`)
    } catch {
      setTemplates(prev)
      toast.error('Failed to delete template')
    }
  }

  const openSaveTemplate = () => {
    if (!command.trim()) { toast.error('Type a command first'); return }
    if (selected.size === 0) { toast.error('Select at least one device first'); return }
    setTemplateName('')
    setTemplateDescription('')
    setTemplateSaveError('')
    setSaveTemplateOpen(true)
  }

  const saveTemplate = async () => {
    if (!templateName.trim()) { setTemplateSaveError('Name is required'); return }
    setSavingTemplate(true)
    setTemplateSaveError('')
    try {
      await api.post('/bulk-command/templates', {
        name: templateName.trim(),
        description: templateDescription.trim() || null,
        command,
        deviceIds: [...selected],
        timeoutSec,
      })
      toast.success(`Template "${templateName.trim()}" saved`)
      setSaveTemplateOpen(false)
      loadTemplates()
    } catch (err) {
      setTemplateSaveError(err.response?.data?.error || 'Failed to save template')
    } finally {
      setSavingTemplate(false)
    }
  }

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

  const allTags = useMemo(() => {
    const set = new Set()
    for (const d of devices) (d.tags || []).forEach(t => set.add(t))
    return [...set].sort()
  }, [devices])

  const toggleTagFilter = (tag) => setTagFilter(prev => {
    const next = new Set(prev)
    next.has(tag) ? next.delete(tag) : next.add(tag)
    return next
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return devices.filter(d => {
      if (groupFilter !== 'all' && (d.group_id || 'ungrouped') !== groupFilter) return false
      if (tagFilter.size > 0 && !(d.tags || []).some(t => tagFilter.has(t))) return false
      if (!q) return true
      return d.name.toLowerCase().includes(q) || d.ip_address?.toLowerCase().includes(q)
    })
  }, [devices, search, groupFilter, tagFilter])

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
      const { data } = await api.post('/bulk-command/run', { actionPin, command, deviceIds, timeoutSec })
      if (data.skipped?.length) {
        data.skipped.forEach(s => toast.error(`${s.deviceName || s.deviceId}: ${s.reason}`, { duration: 4000 }))
      }
      const included = devices.filter(d => deviceIds.includes(d.id) && !data.skipped?.some(s => s.deviceId === d.id))
      setRunDevices(included)
      setResults({})
      setRunId(data.runId)
      setRunStatus('running')
      setPinOpen(false); setPin(''); setPinError(''); setPinTargetIds(null)
      attachStream(data.runId)
      toast.success(`Running on ${data.total} device${data.total === 1 ? '' : 's'}…`)
      loadHistory() // pick up the just-run command (new entry, or bumped run_count/last_used_at)
    } catch (err) {
      setPinError(err.response?.data?.error || 'Failed to start run')
    } finally { setSubmitting(false) }
  }

  const attachStream = (id) => {
    esRef.current?.close()
    errorCountRef.current = 0
    lastMessageRef.current = Date.now()
    setStreamState('connected')
    const token = localStorage.getItem('nc_token')
    const es = new EventSource(`${api.defaults.baseURL}/bulk-command/${id}/stream?token=${encodeURIComponent(token)}`)
    esRef.current = es
    es.onopen = () => { errorCountRef.current = 0; setStreamState('connected') }
    // BUG FIX: the server sends a heartbeat every 20s to keep the
    // connection alive, but it used to be a raw SSE comment, which
    // EventSource never surfaces as an event. That meant the watchdog
    // below only saw real device_start/device_result events — so any
    // command that legitimately ran longer than 45s (this page allows up
    // to 3600s) looked identical to a dead connection, and clicking
    // Reconnect couldn't help because the connection was never actually
    // the problem. Now that the server sends a named `ping` event, treat
    // it exactly like a message: proof the stream (and the run) is alive.
    es.addEventListener('ping', () => {
      errorCountRef.current = 0
      lastMessageRef.current = Date.now()
      setStreamState('connected')
    })
    es.onmessage = (e) => {
      errorCountRef.current = 0
      lastMessageRef.current = Date.now()
      setStreamState('connected')
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
    // EventSource auto-retries on its own, so a single blip isn't worth
    // surfacing — but if it keeps failing, that's worth telling the person
    // about instead of leaving every row silently stuck on "Queued".
    es.onerror = () => {
      errorCountRef.current += 1
      if (errorCountRef.current >= 3) setStreamState('reconnecting')
      if (errorCountRef.current >= 8) { setStreamState('stalled'); es.close() }
    }
  }

  // Watchdog: if the run is still "running" but no event (not even a
  // keep-alive ping) has arrived in 45s, the connection is silently dead
  // (e.g. a proxy dropped it without firing onerror) — flag it instead of
  // leaving the console looking like it's just quietly working.
  useEffect(() => {
    if (runStatus !== 'running') return
    const t = setInterval(() => {
      if (Date.now() - lastMessageRef.current > 45000) setStreamState('stalled')
    }, 5000)
    return () => clearInterval(t)
  }, [runStatus])

  const reconnectStream = () => { if (runId) attachStream(runId) }

  const handleSubmit = () => {
    if (!command.trim()) { toast.error('Enter a command to run'); return }
    if (selected.size === 0) { toast.error('Select at least one device'); return }
    if (!Number.isFinite(timeoutSec) || timeoutSec < 5 || timeoutSec > 3600) {
      toast.error('Timeout must be between 5 and 3600 seconds'); return
    }
    setPinTargetIds(null) // run against the current picker selection, not a stale retry target
    setDryRunOpen(true)
  }

  // Dry run's "Continue" hands off to the exact same PIN-confirmation flow
  // a direct run would use — dry run is a review step in front of it, not
  // a separate execution path with its own risk of drifting out of sync.
  const confirmDryRun = () => {
    setDryRunOpen(false)
    setPinOpen(true)
  }

  const confirmPin = () => {
    if (!pin.trim()) { setPinError('Action PIN is required'); return }
    // pinTargetIds is set explicitly by retryFailed(); a normal run leaves
    // it null and falls back to whatever's checked in the device picker.
    runAgainst(pinTargetIds ?? [...selected], pin)
  }

  const failedIds = Object.entries(results).filter(([, r]) => r.status === 'failure').map(([id]) => id)
  const retryFailed = () => {
    if (!failedIds.length) return
    setPin(''); setPinError('')
    // BUG FIX: this used to call setSelected(new Set(failedIds)) to reuse
    // the device-picker's own selection state for the retry target. That
    // silently overwrote whatever the user had checked in the left panel —
    // canceling the retry dialog left their original selection gone with
    // no way back, and the picker's checkboxes would visually jump to only
    // the failed devices. Track the retry target separately instead so the
    // picker selection is never touched by a retry.
    setPinTargetIds(failedIds)
    setPinOpen(true)
  }

  // ── CSV export — entirely client-side, since the full result set (device,
  // status, duration, output) is already sitting in `results`/`runDevices`
  // by the time this is clickable. Useful for the compliance/audit trail
  // this app already leans on heavily elsewhere. ─────────────────────────
  const csvEscape = (val) => {
    const s = String(val ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const exportResultsCsv = () => {
    const rows = [['Device', 'IP Address', 'Status', 'Duration (ms)', 'Output']]
    for (const d of runDevices) {
      const r = results[d.id] || {}
      rows.push([d.name, d.ip_address, r.status || 'pending', r.durationMs ?? '', r.output || ''])
    }
    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    a.href = url; a.download = `netcontrol-bulk-command-${stamp}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  const counts = useMemo(() => {
    const vals = Object.values(results)
    return {
      running: vals.filter(r => r.status === 'running').length,
      success: vals.filter(r => r.status === 'success').length,
      failure: vals.filter(r => r.status === 'failure').length,
    }
  }, [results])

  // ── Dry-run preview: before the PIN dialog fires anything, show how many
  // of the target devices are actually online right now — a device that's
  // offline or unknown is going to fail/time out regardless of the command,
  // so surfacing this up front saves a wasted 30s-per-device run. ─────────
  const pinTargetDevices = useMemo(() => {
    const ids = pinTargetIds ?? [...selected]
    const idSet = new Set(ids)
    return devices.filter(d => idSet.has(d.id))
  }, [pinTargetIds, selected, devices])

  const pinTargetBreakdown = useMemo(() => {
    const b = { online: 0, offline: 0, unknown: 0, error: 0 }
    for (const d of pinTargetDevices) b[d.status] = (b[d.status] || 0) + 1
    return b
  }, [pinTargetDevices])

  return (
    <div className="page-shell page-stack pb-24 md:pb-[3.5rem]">
      <PageHeader
        icon={TerminalSquare}
        title="Bulk Command"
        description="Run one command across many devices at once and watch results stream in live."
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-5">
        {/* ── Left: device picker + command ── */}
        <div className="space-y-4">
          {templates.length > 0 && (
            <div className="card p-0 overflow-hidden">
              <button
                onClick={() => setTemplatesOpen(o => !o)}
                className="w-full flex items-center justify-between px-4 py-3"
              >
                <span className="flex items-center gap-2 text-sm font-display" style={{ color: 'var(--text-primary)' }}>
                  <Bookmark size={14} style={{ color: '#a78bfa' }} /> Templates
                  <span className="text-[11px] font-body px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-surface-3)', color: 'var(--text-faint)' }}>
                    {templates.length}
                  </span>
                </span>
                {templatesOpen ? <ChevronDown size={14} style={{ color: 'var(--text-faint)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-faint)' }} />}
              </button>
              {templatesOpen && (
                <div className="border-t max-h-56 overflow-y-auto" style={{ borderColor: 'var(--border-subtle)' }}>
                  {templates.map(t => (
                    <div key={t.id} id={`hl-${t.id}`}
                      onClick={() => useTemplate(t)}
                      className="flex items-start gap-2.5 px-4 py-2.5 cursor-pointer hover:bg-white/[0.03] border-b last:border-b-0"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-body truncate" style={{ color: 'var(--text-primary)' }}>{t.name}</p>
                        {t.description && (
                          <p className="text-[11px] font-body truncate" style={{ color: 'var(--text-muted)' }}>{t.description}</p>
                        )}
                        <p className="text-[11px] font-mono truncate mt-0.5" style={{ color: 'var(--text-faint)' }}>{t.command}</p>
                        <p className="text-[10px] font-body mt-0.5" style={{ color: 'var(--text-faint)' }}>
                          {t.device_ids.length} device{t.device_ids.length === 1 ? '' : 's'}
                          {t.use_count > 0 ? ` · used ${t.use_count}×` : ''}
                        </p>
                      </div>
                      <button onClick={(e) => deleteTemplate(t, e)} className="shrink-0 hover:text-accent-red mt-0.5" style={{ color: 'var(--text-faint)' }} title="Delete template">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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

            {allTags.length > 0 && (
              <div className="px-4 pb-3 flex items-center gap-1.5 flex-wrap">
                {allTags.map(tag => {
                  const active = tagFilter.has(tag)
                  return (
                    <button key={tag} onClick={() => toggleTagFilter(tag)}
                      className="text-[11px] font-mono px-2 py-1 rounded-lg transition-all"
                      style={{
                        background: active ? 'var(--brand-500, #a78bfa)' : 'var(--bg-surface-3)',
                        color: active ? '#fff' : 'var(--text-muted)',
                        border: `1px solid ${active ? 'transparent' : 'var(--border-subtle)'}`,
                      }}>
                      {tag}
                    </button>
                  )
                })}
              </div>
            )}

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

          <div className="card relative">
            <div className="flex items-center justify-between mb-1">
              <label className="label mb-0">Command</label>
              {history.length > 0 && (
                <button
                  onClick={() => setHistoryOpen(o => !o)}
                  className="flex items-center gap-1 text-[11px] font-body font-medium"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Clock size={11} /> Recent {historyOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </button>
              )}
            </div>
            {historyOpen && (
              <div className="mb-2 rounded-lg overflow-hidden max-h-48 overflow-y-auto"
                style={{ border: '1px solid var(--border-subtle)' }}>
                {history.map(h => (
                  <div key={h.id}
                    onClick={() => useHistoryCommand(h.command)}
                    className="flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-white/[0.03] border-b last:border-b-0"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <button onClick={(e) => toggleFavorite(h, e)} className="shrink-0" title={h.is_favorite ? 'Unfavorite' : 'Favorite'}>
                      <Star size={13} style={{ color: h.is_favorite ? '#fbbf24' : 'var(--text-faint)' }} fill={h.is_favorite ? '#fbbf24' : 'none'} />
                    </button>
                    <span className="text-[11px] font-mono truncate flex-1" style={{ color: 'var(--text-secondary)' }}>{h.command}</span>
                    <span className="text-[10px] font-body shrink-0" style={{ color: 'var(--text-faint)' }}>×{h.run_count}</span>
                    <button onClick={(e) => deleteHistoryEntry(h, e)} className="shrink-0 hover:text-accent-red" style={{ color: 'var(--text-faint)' }} title="Remove">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder="e.g. sudo apt update && sudo apt upgrade -y"
              rows={4}
              className="input-field font-mono text-sm resize-none"
            />
            <div className="flex items-center gap-2 mt-2">
              <label className="text-[11px] font-body shrink-0" style={{ color: 'var(--text-muted)' }}>
                Timeout per device
              </label>
              <input
                type="number"
                min={5}
                max={3600}
                step={5}
                value={timeoutSec}
                onChange={e => setTimeoutSec(parseInt(e.target.value, 10))}
                className="input-field font-mono text-xs h-7 w-20 py-0"
              />
              <span className="text-[11px] font-body" style={{ color: 'var(--text-faint)' }}>seconds (5–3600)</span>
            </div>
            <p className="text-[11px] font-body mt-1.5" style={{ color: 'var(--text-faint)' }}>
              Linux devices run this over SSH, Windows devices over WinRM — up to 8 at a time. Raise the timeout above for
              large or piped commands (upgrades, multi-stage backups, etc.) that legitimately take longer than the 30s default.
            </p>
            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={handleSubmit}
                disabled={submitting || runStatus === 'running'}
                className="btn-primary flex-1 justify-center flex items-center gap-2 disabled:opacity-40"
              >
                {runStatus === 'running' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {runStatus === 'running' ? 'Running…' : `Run on ${selected.size} device${selected.size === 1 ? '' : 's'}`}
              </button>
              <button
                onClick={openSaveTemplate}
                disabled={submitting || runStatus === 'running'}
                title="Save this command + device selection as a reusable template"
                className="btn-ghost px-3 flex items-center gap-1.5 disabled:opacity-40"
              >
                <Save size={14} />
              </button>
            </div>
          </div>
        </div>

        {/* ── Right: live console ── */}
        <div className="card p-0 overflow-hidden flex flex-col">
          <div className="p-4 flex items-center justify-between border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="text-sm font-display" style={{ color: 'var(--text-primary)' }}>Console</span>
            {runId && (
              <div className="flex items-center gap-2">
                {Object.keys(results).length > 0 && (
                  <button onClick={exportResultsCsv} className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5">
                    <Download size={12} /> Export CSV
                  </button>
                )}
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
              {streamState !== 'connected' && runStatus === 'running' && (
                <div className="mx-4 mt-3 px-3 py-2 rounded-lg flex items-center justify-between gap-3"
                  style={{
                    background: streamState === 'stalled' ? 'rgba(248,113,113,0.08)' : 'rgba(251,191,36,0.08)',
                    border: `1px solid ${streamState === 'stalled' ? 'rgba(248,113,113,0.25)' : 'rgba(251,191,36,0.25)'}`,
                  }}>
                  <span className="text-xs font-body flex items-center gap-2" style={{ color: streamState === 'stalled' ? '#fca5a5' : '#fbbf24' }}>
                    <Loader2 size={12} className={streamState === 'reconnecting' ? 'animate-spin' : ''} />
                    {streamState === 'stalled'
                      ? 'Live connection lost — the run may still be executing in the background.'
                      : 'Live connection interrupted — reconnecting…'}
                  </span>
                  {streamState === 'stalled' && (
                    <button onClick={reconnectStream} className="btn-ghost text-xs px-2.5 py-1 shrink-0">Reconnect</button>
                  )}
                </div>
              )}
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

      {/* ── Dry run: preview affected devices + exact command before the
          PIN gate ── Same card chrome as the PIN modal below (same
          overlay, border radius, accent bar, header layout) so the two
          read as one continuous confirmation flow rather than two
          different UI patterns bolted together. "Continue" hands off
          straight into the existing PIN modal — dry run never runs
          anything itself, it's purely a review step. ── */}
      {dryRunOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setDryRunOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-lg animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'rgba(56,189,248,0.25)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
              <div className="h-0.5 opacity-70 bg-sky-400" />
              <div className="flex items-start justify-between p-6 pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-sky-400/15 border border-sky-400/25">
                    <Eye size={20} className="text-sky-400" />
                  </div>
                  <div>
                    <h3 className="font-display text-base" style={{ color: 'var(--text-primary)' }}>Preview Run</h3>
                    <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      Nothing runs yet — review the command and target devices below.
                    </p>
                  </div>
                </div>
                <button onClick={() => setDryRunOpen(false)} className="p-1 rounded-lg hover:text-accent-red" style={{ color: 'var(--text-muted)' }}>
                  <X size={16} />
                </button>
              </div>

              <div className="mx-6 mb-3 px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-[10px] font-body font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--text-faint)' }}>Command</p>
                <p className="text-xs font-mono break-all" style={{ color: 'var(--text-primary)' }}>{command}</p>
                <p className="text-[11px] font-body mt-1.5" style={{ color: 'var(--text-faint)' }}>{timeoutSec}s timeout · up to 8 devices at a time</p>
              </div>

              {(pinTargetBreakdown.offline > 0 || pinTargetBreakdown.unknown > 0 || pinTargetBreakdown.error > 0) && (
                <div className="mx-6 mb-3 px-3 py-2.5 rounded-lg flex items-start gap-2"
                  style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)' }}>
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: '#fbbf24' }} />
                  <p className="text-xs font-body leading-relaxed" style={{ color: '#fbbf24' }}>
                    {pinTargetBreakdown.online} online, {pinTargetBreakdown.offline} offline, {pinTargetBreakdown.unknown + pinTargetBreakdown.error} unreachable/unknown —
                    devices that aren't online will very likely fail or time out.
                  </p>
                </div>
              )}

              <div className="mx-6 mb-4">
                <p className="text-[10px] font-body font-semibold uppercase tracking-widest mb-1.5" style={{ color: 'var(--text-faint)' }}>
                  {pinTargetDevices.length} target device{pinTargetDevices.length === 1 ? '' : 's'}
                </p>
                <div className="rounded-lg border max-h-52 overflow-y-auto divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                  {pinTargetDevices.map(d => (
                    <div key={d.id} className="flex items-center gap-2.5 px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[d.status] || STATUS_DOT.unknown}`} />
                      <span className="text-xs font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>{d.name}</span>
                      <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--text-faint)' }}>{d.ip_address}</span>
                      <span className="text-[10px] font-body uppercase tracking-wide shrink-0" style={{ color: 'var(--text-faint)' }}>{d.status}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="px-6 pb-6 flex gap-3">
                <button onClick={() => setDryRunOpen(false)} className="btn-ghost flex-1 justify-center">Cancel</button>
                <button onClick={confirmDryRun} className="btn-primary flex-1 justify-center flex items-center gap-2">
                  <ShieldAlert size={14} /> Continue to Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── PIN confirmation ── */}
      {pinOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => { setPinOpen(false); setPin(''); setPinError(''); setPinTargetIds(null) }}>
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
                      {(pinTargetIds ?? [...selected]).length} device{(pinTargetIds ?? [...selected]).length === 1 ? '' : 's'}
                      {pinTargetIds ? ' (retry)' : ''} · <span className="font-mono">{command.slice(0, 40)}{command.length > 40 ? '…' : ''}</span>
                      {' '}· {timeoutSec}s timeout
                    </p>
                  </div>
                </div>
                <button onClick={() => { setPinOpen(false); setPin(''); setPinError(''); setPinTargetIds(null) }} className="p-1 rounded-lg hover:text-accent-red" style={{ color: 'var(--text-muted)' }}>
                  <X size={16} />
                </button>
              </div>
              {(pinTargetBreakdown.offline > 0 || pinTargetBreakdown.unknown > 0 || pinTargetBreakdown.error > 0) && (
                <div className="mx-6 mb-3 px-3 py-2.5 rounded-lg flex items-start gap-2"
                  style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)' }}>
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: '#fbbf24' }} />
                  <p className="text-xs font-body leading-relaxed" style={{ color: '#fbbf24' }}>
                    {pinTargetBreakdown.online} online, {pinTargetBreakdown.offline} offline, {pinTargetBreakdown.unknown + pinTargetBreakdown.error} unreachable/unknown —
                    devices that aren't online will very likely fail or time out.
                  </p>
                </div>
              )}
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
                  <button onClick={() => { setPinOpen(false); setPin(''); setPinError(''); setPinTargetIds(null) }} className="btn-ghost flex-1 justify-center" disabled={submitting}>Cancel</button>
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

      {saveTemplateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => !savingTemplate && setSaveTemplateOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-md animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'rgba(167,139,250,0.25)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
              <div className="h-0.5 opacity-70 bg-[#a78bfa]" />
              <div className="flex items-start justify-between p-6 pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#a78bfa]/15 border border-[#a78bfa]/25">
                    <Bookmark size={18} className="text-[#a78bfa]" />
                  </div>
                  <div>
                    <h3 className="font-display text-base" style={{ color: 'var(--text-primary)' }}>Save as Template</h3>
                    <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {selected.size} device{selected.size === 1 ? '' : 's'} · <span className="font-mono">{command.slice(0, 40)}{command.length > 40 ? '…' : ''}</span>
                    </p>
                  </div>
                </div>
                <button onClick={() => setSaveTemplateOpen(false)} disabled={savingTemplate} className="p-1 rounded-lg hover:text-accent-red" style={{ color: 'var(--text-muted)' }}>
                  <X size={16} />
                </button>
              </div>
              <div className="px-6 pb-6 space-y-3">
                <div>
                  <label className="label">Name</label>
                  <input
                    autoFocus
                    value={templateName}
                    onChange={e => { setTemplateName(e.target.value); setTemplateSaveError('') }}
                    onKeyDown={e => e.key === 'Enter' && saveTemplate()}
                    placeholder="e.g. Patch Tuesday reboot — branch switches"
                    className={`input-field ${templateSaveError ? 'border-accent-red/50' : ''}`}
                  />
                </div>
                <div>
                  <label className="label">Description (optional)</label>
                  <input
                    value={templateDescription}
                    onChange={e => setTemplateDescription(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveTemplate()}
                    placeholder="What this is for, when to run it, etc."
                    className="input-field"
                  />
                </div>
                {templateSaveError && <p className="text-xs text-accent-red font-body">{templateSaveError}</p>}
                <p className="text-[11px] font-body" style={{ color: 'var(--text-faint)' }}>
                  Saves the current command, timeout, and the {selected.size} currently-selected device{selected.size === 1 ? '' : 's'} as a one-click preset.
                </p>
                <div className="flex gap-3 mt-2">
                  <button onClick={() => setSaveTemplateOpen(false)} className="btn-ghost flex-1 justify-center" disabled={savingTemplate}>Cancel</button>
                  <button onClick={saveTemplate} disabled={savingTemplate || !templateName.trim()} className="btn-primary flex-1 justify-center flex items-center gap-2 disabled:opacity-40">
                    {savingTemplate && <Loader2 size={14} className="animate-spin" />}
                    {savingTemplate ? 'Saving…' : 'Save Template'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Mobile sticky footer: selection summary + run ──────────────────
          On small screens the Run button lives inline in the left-column
          form, which can scroll off-screen once a device list gets long.
          This mirrors it as a fixed bottom bar (md:hidden — the inline
          button is already visible on desktop's wider layout) so the most
          important action is always reachable with a thumb. Sits above the
          safe-area inset so it doesn't collide with iOS/Android home
          indicators; page-shell above reserves matching pb-24 so page
          content never ends up hidden underneath it. */}
      <div
        className="md:hidden fixed bottom-0 inset-x-0 z-30 flex items-center gap-3 px-4 py-3 border-t"
        style={{
          background: 'var(--bg-card)',
          borderColor: 'var(--border-subtle)',
          paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <span className="text-xs font-body flex-1 min-w-0 truncate" style={{ color: 'var(--text-muted)' }}>
          {selected.size} device{selected.size === 1 ? '' : 's'} selected
        </span>
        <button
          onClick={handleSubmit}
          disabled={submitting || runStatus === 'running' || selected.size === 0}
          className="btn-primary flex items-center gap-2 px-4 disabled:opacity-40 shrink-0"
        >
          {runStatus === 'running' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {runStatus === 'running' ? 'Running…' : 'Run'}
        </button>
      </div>
    </div>
  )
}