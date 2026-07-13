import React, { useState, useEffect, useCallback } from 'react'
import {
  Waypoints, RefreshCw, Loader2, Plus, X, Play, Trash2, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, HelpCircle, Globe, Terminal, Plug, Clock, Settings2,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'

// ── Status presentation ───────────────────────────────────────────────────────
const STATUS_CFG = {
  unknown:   { color: '#94a3b8', icon: HelpCircle,   label: 'Not Yet Run' },
  healthy:   { color: '#34d399', icon: CheckCircle2, label: 'Healthy' },
  unhealthy: { color: '#f87171', icon: XCircle,      label: 'Unhealthy' },
}
const TYPE_CFG = {
  http:        { icon: Globe,    label: 'HTTP' },
  tcp:         { icon: Plug,     label: 'TCP' },
  ssh_command: { icon: Terminal, label: 'SSH Command' },
}

function StatusPill({ status }) {
  const c = STATUS_CFG[status] || STATUS_CFG.unknown
  const Icon = c.icon
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-body font-semibold"
      style={{ color: c.color, background: `${c.color}18`, border: `1px solid ${c.color}35` }}>
      <Icon size={11} /> {c.label}
    </span>
  )
}

function timeAgo(ts) {
  if (!ts) return 'never'
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Results sparkline-ish history strip ───────────────────────────────────────
function ResultsStrip({ checkId }) {
  const [results, setResults] = useState(null)
  useEffect(() => {
    let cancelled = false
    api.get(`/synthetic-checks/${checkId}/results?limit=50`)
      .then(({ data }) => { if (!cancelled) setResults(data) })
      .catch(() => { if (!cancelled) setResults([]) })
    return () => { cancelled = true }
  }, [checkId])

  if (results === null) return <div className="py-4 flex justify-center"><Loader2 size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
  if (!results.length) return <p className="text-xs font-body py-2" style={{ color: 'var(--text-muted)' }}>No runs recorded yet.</p>

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-[2px] h-8">
        {results.map((r, i) => (
          <div key={i} title={`${new Date(r.ts * 1000).toLocaleString()} — ${r.message}`}
            className="flex-1 rounded-sm min-w-[3px]"
            style={{ height: '100%', background: r.success ? '#34d39970' : '#f8717190' }} />
        ))}
      </div>
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {[...results].reverse().slice(0, 15).map((r, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px] font-mono">
            {r.success ? <CheckCircle2 size={11} style={{ color: '#34d399' }} /> : <XCircle size={11} style={{ color: '#f87171' }} />}
            <span style={{ color: 'var(--text-muted)' }}>{new Date(r.ts * 1000).toLocaleTimeString()}</span>
            {r.latency_ms != null && <span style={{ color: 'var(--text-faint)' }}>{r.latency_ms}ms</span>}
            <span className="truncate" style={{ color: 'var(--text-primary)' }}>{r.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── One check row ─────────────────────────────────────────────────────────────
function CheckRow({ check, onChanged }) {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const TypeIcon = (TYPE_CFG[check.check_type] || {}).icon || Globe

  const runNow = async (e) => {
    e.stopPropagation()
    setRunning(true)
    try {
      await api.post(`/synthetic-checks/${check.id}/run`)
      toast.success(`Ran "${check.name}"`)
      onChanged()
    } catch (err) { toast.error(err.response?.data?.error || 'Run failed') }
    finally { setRunning(false) }
  }

  const toggleEnabled = async (e) => {
    e.stopPropagation()
    try {
      await api.put(`/synthetic-checks/${check.id}`, { enabled: !check.enabled })
      onChanged()
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to update') }
  }

  const remove = async (e) => {
    e.stopPropagation()
    if (!confirm(`Delete check "${check.name}"?`)) return
    try {
      await api.delete(`/synthetic-checks/${check.id}`)
      toast.success('Check deleted')
      onChanged()
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to delete') }
  }

  return (
    <div className="card p-0 overflow-hidden" style={{ opacity: check.enabled ? 1 : 0.55 }}>
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.02]" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />}
        <TypeIcon size={14} style={{ color: 'var(--text-muted)' }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-body font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{check.name}</span>
            <StatusPill status={check.status} />
          </div>
          <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {check.device_name} ({check.device_ip}) · every {check.interval_seconds}s · last run {timeAgo(check.last_run_at)}
            {check.consecutive_failures > 0 && ` · ${check.consecutive_failures} consecutive failure${check.consecutive_failures === 1 ? '' : 's'}`}
          </p>
          {check.last_message && (
            <p className="text-[11px] font-mono mt-0.5 truncate" style={{ color: check.status === 'unhealthy' ? '#f87171' : 'var(--text-faint)' }}>
              {check.last_message}
            </p>
          )}
        </div>
        <button onClick={runNow} disabled={running} className="icon-btn shrink-0" title="Run now">
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
        </button>
        <input type="checkbox" checked={!!check.enabled} onChange={toggleEnabled} onClick={e => e.stopPropagation()} title="Enabled" />
        <button onClick={remove} className="icon-btn shrink-0" title="Delete check"><Trash2 size={13} /></button>
      </div>
      {open && (
        <div className="px-4 pb-3 pt-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <ResultsStrip checkId={check.id} />
        </div>
      )}
    </div>
  )
}

// ── Create check form ─────────────────────────────────────────────────────────
function CreateCheckModal({ devices, onClose, onCreated }) {
  const [deviceId, setDeviceId] = useState(devices[0]?.id || '')
  const [name, setName] = useState('')
  const [checkType, setCheckType] = useState('http')
  const [interval, setInterval_] = useState(60)
  const [timeout_, setTimeout_] = useState(5000)
  const [threshold, setThreshold] = useState(2)
  // http config
  const [url, setUrl] = useState('')
  const [expectStatus, setExpectStatus] = useState(200)
  const [expectBody, setExpectBody] = useState('')
  // tcp config
  const [port, setPort] = useState('')
  // ssh config
  const [command, setCommand] = useState('')
  const [expectOutput, setExpectOutput] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!deviceId) { toast.error('Pick a device'); return }
    if (!name.trim()) { toast.error('Name is required'); return }

    let config = {}
    if (checkType === 'http') {
      config = { ...(url.trim() ? { url: url.trim() } : {}), expect_status: Number(expectStatus) || 200, ...(expectBody.trim() ? { expect_body_contains: expectBody.trim() } : {}) }
    } else if (checkType === 'tcp') {
      if (!port) { toast.error('Port is required for a TCP check'); return }
      config = { port: Number(port) }
    } else if (checkType === 'ssh_command') {
      if (!command.trim()) { toast.error('Command is required for an SSH check'); return }
      config = { command: command.trim(), ...(expectOutput.trim() ? { expect_output_contains: expectOutput.trim() } : {}) }
    }

    setSaving(true)
    try {
      await api.post('/synthetic-checks', {
        device_id: deviceId, name: name.trim(), check_type: checkType, config,
        interval_seconds: Number(interval), timeout_ms: Number(timeout_), failure_threshold: Number(threshold),
      })
      toast.success('Check created')
      onCreated()
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to create check') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl p-6 animate-slide-up"
        style={{ background: 'var(--bg-card)', border: '1px solid rgba(124,92,245,0.3)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-base flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Waypoints size={16} /> New Health Check
          </h3>
          <button onClick={onClose} className="icon-btn"><X size={14} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Device</label>
            <select className="input-field w-full" value={deviceId} onChange={e => setDeviceId(e.target.value)}>
              {devices.map(d => <option key={d.id} value={d.id}>{d.name} ({d.ip_address})</option>)}
            </select>
          </div>
          <div>
            <label className="label">Name</label>
            <input className="input-field w-full" placeholder="e.g. 'Web UI health'" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Check type</label>
            <select className="input-field w-full" value={checkType} onChange={e => setCheckType(e.target.value)}>
              <option value="http">HTTP — request returns expected status/body</option>
              <option value="tcp">TCP — port accepts connections</option>
              <option value="ssh_command">SSH Command — output matches expected</option>
            </select>
          </div>

          {checkType === 'http' && (
            <div className="space-y-2 p-3 rounded-lg" style={{ background: 'var(--bg-input)' }}>
              <input className="input-field w-full text-xs" placeholder="URL (optional — defaults to http://<device ip>/)" value={url} onChange={e => setUrl(e.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <input className="input-field text-xs" type="number" placeholder="Expected status" value={expectStatus} onChange={e => setExpectStatus(e.target.value)} />
                <input className="input-field text-xs" placeholder="Body must contain (optional)" value={expectBody} onChange={e => setExpectBody(e.target.value)} />
              </div>
            </div>
          )}
          {checkType === 'tcp' && (
            <div className="p-3 rounded-lg" style={{ background: 'var(--bg-input)' }}>
              <input className="input-field w-full text-xs" type="number" placeholder="Port, e.g. 5432" value={port} onChange={e => setPort(e.target.value)} />
            </div>
          )}
          {checkType === 'ssh_command' && (
            <div className="space-y-2 p-3 rounded-lg" style={{ background: 'var(--bg-input)' }}>
              <input className="input-field w-full text-xs font-mono" placeholder="Command, e.g. systemctl is-active nginx" value={command} onChange={e => setCommand(e.target.value)} />
              <input className="input-field w-full text-xs" placeholder="Output must contain (optional), e.g. active" value={expectOutput} onChange={e => setExpectOutput(e.target.value)} />
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="label">Interval (s)</label>
              <input className="input-field w-full text-xs" type="number" min="10" value={interval} onChange={e => setInterval_(e.target.value)} />
            </div>
            <div>
              <label className="label">Timeout (ms)</label>
              <input className="input-field w-full text-xs" type="number" min="500" value={timeout_} onChange={e => setTimeout_(e.target.value)} />
            </div>
            <div>
              <label className="label">Fail threshold</label>
              <input className="input-field w-full text-xs" type="number" min="1" value={threshold} onChange={e => setThreshold(e.target.value)} />
            </div>
          </div>
          <p className="text-[11px] font-body" style={{ color: 'var(--text-faint)' }}>
            An alert only fires once this check fails {threshold || 2} times in a row — avoids paging on a single blip.
          </p>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="btn-ghost text-xs px-3 py-1.5">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary text-xs px-4 py-1.5">
            {saving ? <Loader2 size={12} className="animate-spin" /> : 'Create Check'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SyntheticChecksPage() {
  const [checks, setChecks] = useState([])
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, d] = await Promise.all([api.get('/synthetic-checks'), api.get('/devices')])
      setChecks(c.data)
      setDevices(d.data)
    } catch { toast.error('Failed to load health checks') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const unhealthyCount = checks.filter(c => c.status === 'unhealthy').length

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4 animate-fade-in pb-10">
      <PageHeader icon={Waypoints} title="Health Checks"
        description="Scripted HTTP/TCP/SSH checks — proves the actual service is working, not just that the device answers a ping."
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => setShowCreate(true)} className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5">
              <Plus size={12} /> New Check
            </button>
            <button onClick={load} className="icon-btn"><RefreshCw size={13} /></button>
          </div>
        }
      />

      {unhealthyCount > 0 && (
        <div className="px-4 py-2.5 rounded-lg text-xs font-body flex items-center gap-2"
          style={{ background: '#f8717118', border: '1px solid #f8717140', color: '#f87171' }}>
          <XCircle size={13} /> {unhealthyCount} check{unhealthyCount === 1 ? ' is' : 's are'} currently unhealthy
        </div>
      )}

      {loading ? (
        <div className="py-16 flex justify-center"><Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
      ) : checks.length === 0 ? (
        <div className="card py-12 text-center">
          <Waypoints size={28} className="mx-auto mb-3" style={{ color: 'var(--text-faint)' }} />
          <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>
            No health checks configured yet — reachability polling alone won't catch a service that's up but broken.
          </p>
          <button onClick={() => setShowCreate(true)} className="btn-primary text-xs px-4 py-1.5 mt-4">Create your first check</button>
        </div>
      ) : (
        <div className="space-y-2">
          {checks.map(c => <CheckRow key={c.id} check={c} onChanged={load} />)}
        </div>
      )}

      {showCreate && (
        <CreateCheckModal devices={devices} onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load() }} />
      )}
    </div>
  )
}