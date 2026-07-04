import React, { useState, useEffect, useCallback } from 'react'
import {
  ShieldCheck, RefreshCw, Loader2, ChevronDown, ChevronRight, Lock,
  CheckCircle2, AlertTriangle, XCircle, HelpCircle, Play, Anchor,
  Package, Server as ServerIcon, Flame, Plus, Minus, Clock,
  FileText, Trash2, FolderPlus, WifiOff,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import { usePermissions } from '../hooks/usePermissions'

// ── Status presentation ───────────────────────────────────────────────────────
const STATUS_CFG = {
  unconfigured: { color: '#64748b', icon: HelpCircle,   label: 'Not Configured' },
  pending:      { color: '#94a3b8', icon: Clock,        label: 'Pending First Check' },
  clean:        { color: '#34d399', icon: CheckCircle2, label: 'Clean' },
  drift:        { color: '#fbbf24', icon: AlertTriangle,label: 'Drift Detected' },
  error:        { color: '#f87171', icon: XCircle,      label: 'Check Failed' },
  unreachable:  { color: '#f87171', icon: WifiOff,      label: 'Unreachable' },
}

function deviceStatus(d) {
  if (!d.enabled) return 'unconfigured'
  if (!d.latest_status) return 'pending'
  if (d.latest_status === 'error' && d.latest_unreachable) return 'unreachable'
  return d.latest_status
}

function StatusPill({ status }) {
  const c = STATUS_CFG[status] || STATUS_CFG.unconfigured
  const Icon = c.icon
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-body font-bold px-2 py-0.5 rounded-full"
      style={{ background: `${c.color}18`, border: `1px solid ${c.color}40`, color: c.color }}>
      <Icon size={11} /> {c.label}
    </span>
  )
}

function OsBadge({ type }) {
  const label = type === 'windows' ? 'WIN' : type === 'linux' ? 'LNX' : 'UNK'
  const style = type === 'windows'
    ? 'bg-sky-400/10 text-sky-400'
    : type === 'linux' ? 'bg-emerald-400/10 text-emerald-400' : 'bg-slate-400/10 text-slate-400'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold shrink-0 ${style}`}>{label}</span>
}

function timeAgo(ts) {
  if (!ts) return 'never'
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Diff viewer — one category's added/removed lists ─────────────────────────
function DiffCategory({ icon: Icon, label, added = [], removed = [] }) {
  if (!added.length && !removed.length) return null
  return (
    <div className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} style={{ color: 'var(--text-muted)' }} />
        <span className="text-[11px] font-body font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <div className="space-y-1 font-mono text-[11px]">
        {added.map((x, i) => (
          <div key={`a${i}`} className="flex items-center gap-1.5" style={{ color: '#34d399' }}>
            <Plus size={10} className="shrink-0" /> <span className="truncate">{x}</span>
          </div>
        ))}
        {removed.map((x, i) => (
          <div key={`r${i}`} className="flex items-center gap-1.5" style={{ color: '#f87171' }}>
            <Minus size={10} className="shrink-0" /> <span className="truncate">{x}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function FileDiffCard({ path, status, added = [], removed = [] }) {
  const statusColor = status === 'added' ? '#34d399' : status === 'removed' ? '#f87171' : '#fbbf24'
  return (
    <div className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <FileText size={12} style={{ color: 'var(--text-muted)' }} />
        <span className="text-[11px] font-mono font-bold truncate" style={{ color: 'var(--text-primary)' }}>{path}</span>
        <span className="text-[10px] font-body font-semibold px-1.5 py-0.5 rounded uppercase" style={{ color: statusColor, background: `${statusColor}18` }}>
          {status}
        </span>
      </div>
      <div className="space-y-1 font-mono text-[11px] max-h-40 overflow-y-auto">
        {added.map((x, i) => (
          <div key={`a${i}`} className="flex items-center gap-1.5" style={{ color: '#34d399' }}>
            <Plus size={10} className="shrink-0" /> <span className="truncate">{x}</span>
          </div>
        ))}
        {removed.map((x, i) => (
          <div key={`r${i}`} className="flex items-center gap-1.5" style={{ color: '#f87171' }}>
            <Minus size={10} className="shrink-0" /> <span className="truncate">{x}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DiffView({ diff }) {
  if (!diff) return <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>No changes.</p>
  const fileEntries = Object.entries(diff.files || {})
  const hasAny = ['packages', 'services', 'firewall_rules'].some(k => (diff[k]?.added?.length || diff[k]?.removed?.length)) || fileEntries.length > 0
  if (!hasAny) return <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>No changes.</p>
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <DiffCategory icon={Package}     label="Packages"       {...diff.packages} />
        <DiffCategory icon={ServerIcon}  label="Services"       {...diff.services} />
        <DiffCategory icon={Flame}       label="Firewall Rules" {...diff.firewall_rules} />
      </div>
      {fileEntries.length > 0 && (
        <div>
          <span className="text-[11px] font-body font-bold uppercase tracking-wider mb-1.5 block" style={{ color: 'var(--text-muted)' }}>
            Watched Files
          </span>
          <div className="grid gap-2 sm:grid-cols-2">
            {fileEntries.map(([path, d]) => <FileDiffCard key={path} path={path} {...d} />)}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Snapshot history row ──────────────────────────────────────────────────────
function SnapshotRow({ snap }) {
  const [open, setOpen] = useState(false)
  const snapStatus = snap.status === 'error' && snap.unreachable ? 'unreachable' : snap.status
  const c = STATUS_CFG[snapStatus] || STATUS_CFG.pending
  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-white/[0.02]" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />}
        <StatusPill status={snapStatus} />
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
          {new Date(snap.taken_at * 1000).toLocaleString()}
        </span>
        {snap.error && <span className="text-[11px] font-body truncate" style={{ color: c.color }}>{snap.error}</span>}
      </div>
      {open && (
        <div className="px-4 pb-3">
          {snap.status === 'drift' ? <DiffView diff={snap.diff} /> : (
            <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
              {snap.status === 'error' ? snap.error : 'Matched the baseline — no drift.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Per-device expandable card ────────────────────────────────────────────────
function DeviceCard({ d, expanded, onToggleExpand, onChanged }) {
  const [snapshots, setSnapshots] = useState([])
  const [loadingSnaps, setLoadingSnaps] = useState(false)
  const [running, setRunning] = useState(false)
  const [settingBaseline, setSettingBaseline] = useState(false)
  const [interval_, setInterval_] = useState(d.check_interval_hours || 24)
  const [savingConfig, setSavingConfig] = useState(false)
  const [confirmBaseline, setConfirmBaseline] = useState(false)
  const [watchedFiles, setWatchedFiles] = useState([])
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [addingFile, setAddingFile] = useState(false)

  const status = deviceStatus(d)

  const loadSnapshots = useCallback(async () => {
    setLoadingSnaps(true)
    try {
      const { data } = await api.get(`/compliance/${d.device_id}/snapshots`)
      setSnapshots(data)
    } catch { toast.error('Failed to load snapshot history') }
    finally { setLoadingSnaps(false) }
  }, [d.device_id])

  const loadWatchedFiles = useCallback(async () => {
    setLoadingFiles(true)
    try {
      const { data } = await api.get(`/compliance/${d.device_id}/files`)
      setWatchedFiles(data)
    } catch { toast.error('Failed to load watched files') }
    finally { setLoadingFiles(false) }
  }, [d.device_id])

  useEffect(() => { if (expanded) { loadSnapshots(); loadWatchedFiles() } }, [expanded, loadSnapshots, loadWatchedFiles])

  const addWatchedFile = async () => {
    const path = newFilePath.trim()
    if (!path) return
    setAddingFile(true)
    try {
      await api.post(`/compliance/${d.device_id}/files`, { file_path: path })
      toast.success('Now watching that file')
      setNewFilePath('')
      loadWatchedFiles()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to add watched file') }
    finally { setAddingFile(false) }
  }

  const removeWatchedFile = async (id) => {
    try {
      await api.delete(`/compliance/${d.device_id}/files/${id}`)
      toast.success('Stopped watching that file')
      loadWatchedFiles()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to remove watched file') }
  }

  const toggleEnabled = async () => {
    setSavingConfig(true)
    try {
      await api.put(`/compliance/${d.device_id}/config`, { enabled: !d.enabled, check_interval_hours: interval_ })
      toast.success(!d.enabled ? 'Compliance checking enabled' : 'Compliance checking disabled')
      onChanged()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to update config') }
    finally { setSavingConfig(false) }
  }

  const saveInterval = async (val) => {
    setInterval_(val)
    try {
      await api.put(`/compliance/${d.device_id}/config`, { enabled: !!d.enabled, check_interval_hours: Number(val) })
      onChanged()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to update interval') }
  }

  const runNow = async () => {
    setRunning(true)
    try {
      const { data } = await api.post(`/compliance/${d.device_id}/snapshot`)
      toast[data.status === 'drift' ? 'error' : data.status === 'error' ? 'error' : 'success'](
        data.status === 'drift' ? 'Drift detected against baseline'
          : data.status === 'error' ? `Check failed: ${data.error}`
          : 'Clean — matches baseline'
      )
      onChanged()
      if (expanded) loadSnapshots()
    } catch (e) { toast.error(e.response?.data?.error || 'Snapshot failed') }
    finally { setRunning(false) }
  }

  const doSetBaseline = async () => {
    setSettingBaseline(true)
    try {
      await api.post(`/compliance/${d.device_id}/baseline`)
      toast.success('Baseline updated to current state')
      setConfirmBaseline(false)
      onChanged()
      if (expanded) loadSnapshots()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to set baseline') }
    finally { setSettingBaseline(false) }
  }

  return (
    <div className="glass rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 cursor-pointer" onClick={onToggleExpand}>
        {expanded ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
        <OsBadge type={d.os_type} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-body font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{d.device_name}</p>
            <StatusPill status={status} />
          </div>
          <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {d.ip_address} · last checked {timeAgo(d.last_checked_at)}
            {d.baseline_created_at ? ` · baseline set ${timeAgo(d.baseline_created_at)}` : ' · no baseline yet'}
          </p>
        </div>
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <button onClick={runNow} disabled={running} className="icon-btn" title="Run check now">
            {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          </button>
          <button onClick={() => setConfirmBaseline(true)} disabled={settingBaseline} className="icon-btn" title="Set current state as baseline">
            {settingBaseline ? <Loader2 size={12} className="animate-spin" /> : <Anchor size={12} />}
          </button>
          <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Enable periodic checking">
            <input type="checkbox" checked={!!d.enabled} onChange={toggleEnabled} disabled={savingConfig} />
          </label>
        </div>
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center justify-between px-5 py-3" style={{ background: 'var(--bg-input)' }}>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>Check every</span>
              <select className="input-field text-xs py-1 w-24" value={interval_} onChange={e => saveInterval(e.target.value)}>
                {[1, 6, 12, 24, 48, 72, 168].map(h => <option key={h} value={h}>{h}h</option>)}
              </select>
            </div>
            <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
              {snapshots.length} snapshot{snapshots.length !== 1 ? 's' : ''} recorded
            </p>
          </div>

          {status === 'drift' && d.latest_diff && (
            <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <p className="text-[11px] font-body font-bold uppercase tracking-wider mb-2" style={{ color: '#fbbf24' }}>
                Latest drift
              </p>
              <DiffView diff={d.latest_diff} />
            </div>
          )}

          <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-1.5 mb-2">
              <FileText size={12} style={{ color: 'var(--text-muted)' }} />
              <span className="text-[11px] font-body font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Watched Files
              </span>
            </div>
            <p className="text-[11px] font-body mb-2" style={{ color: 'var(--text-muted)' }}>
              Specify a file path on this device (e.g. <code>/etc/nginx/nginx.conf</code>) to track its exact contents alongside packages/services/firewall rules.
            </p>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                className="input-field text-xs py-1.5 flex-1 font-mono"
                placeholder={d.os_type === 'windows' ? 'C:\\path\\to\\file.conf' : '/etc/path/to/file.conf'}
                value={newFilePath}
                onChange={e => setNewFilePath(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addWatchedFile()}
              />
              <button onClick={addWatchedFile} disabled={addingFile || !newFilePath.trim()} className="btn-primary text-xs px-3 py-1.5">
                {addingFile ? <Loader2 size={12} className="animate-spin" /> : <FolderPlus size={12} />} Watch
              </button>
            </div>
            {loadingFiles ? (
              <div className="py-2 flex justify-center"><Loader2 size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
            ) : watchedFiles.length === 0 ? (
              <p className="text-[11px] font-body py-1" style={{ color: 'var(--text-muted)' }}>No files being watched yet.</p>
            ) : (
              <div className="space-y-1">
                {watchedFiles.map(f => (
                  <div key={f.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--bg-input)' }}>
                    <span className="text-[11px] font-mono truncate" style={{ color: 'var(--text-primary)' }}>{f.file_path}</span>
                    <button onClick={() => removeWatchedFile(f.id)} className="icon-btn shrink-0" title="Stop watching this file">
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {loadingSnaps ? (
            <div className="py-8 flex justify-center"><Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
          ) : snapshots.length === 0 ? (
            <div className="py-8 text-center text-xs font-body" style={{ color: 'var(--text-muted)' }}>
              No snapshots yet — run a check or wait for the next scheduled one.
            </div>
          ) : snapshots.map(s => <SnapshotRow key={s.id} snap={s} />)}
        </div>
      )}

      {confirmBaseline && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setConfirmBaseline(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-sm rounded-2xl p-6 animate-slide-up"
            style={{ background: 'var(--bg-card)', border: '1px solid rgba(124,92,245,0.3)' }} onClick={e => e.stopPropagation()}>
            <h3 className="font-display text-base mb-1" style={{ color: 'var(--text-primary)' }}>
              Set baseline for "{d.device_name}"?
            </h3>
            <p className="text-sm font-body mb-5" style={{ color: 'var(--text-muted)' }}>
              Collects the device's current packages, services, and firewall rules right now and makes that the new "known good" state. Any existing drift warning will clear.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmBaseline(false)} className="btn-ghost flex-1 justify-center">Cancel</button>
              <button onClick={doSetBaseline} disabled={settingBaseline} className="btn-primary flex-1 justify-center">
                {settingBaseline ? <Loader2 size={14} className="animate-spin" /> : <Anchor size={14} />} Set Baseline
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CompliancePage() {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [filter, setFilter] = useState('all')

  const { can } = usePermissions()
  const canManageCompliance = can(2048)

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/compliance')
      setDevices(data)
    } catch { toast.error('Failed to load compliance status') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = devices.filter(d => filter === 'all' || deviceStatus(d) === filter)
  const counts = devices.reduce((acc, d) => {
    const s = deviceStatus(d)
    acc[s] = (acc[s] || 0) + 1
    return acc
  }, {})

  if (!canManageCompliance) return (
    <div className="p-6 flex flex-col items-center justify-center min-h-[60vh]">
      <Lock size={36} style={{ color: 'var(--text-muted)' }} className="mb-3" />
      <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>Compliance management access required</p>
    </div>
  )

  return (
    <div className="p-6 max-w-[1400px] mx-auto animate-fade-in pb-10">
      <PageHeader icon={ShieldCheck} title="Config Compliance"
        description="Detect drift in installed packages, running services, and firewall rules — did someone change something on that box?"
        actions={<button onClick={load} className="icon-btn"><RefreshCw size={13} /></button>}
      />

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2 mb-4">
        {['all', 'drift', 'clean', 'pending', 'unconfigured', 'error'].map(key => {
          const c = key === 'all' ? { color: '#a78bfa', label: 'All' } : STATUS_CFG[key]
          const count = key === 'all' ? devices.length : (counts[key] || 0)
          return (
            <button key={key} onClick={() => setFilter(key)}
              className="text-[11px] font-body font-semibold px-2.5 py-1 rounded-full transition-all"
              style={{
                background: filter === key ? `${c.color}22` : 'var(--bg-input)',
                border: `1px solid ${filter === key ? `${c.color}60` : 'var(--border-subtle)'}`,
                color: filter === key ? c.color : 'var(--text-muted)',
              }}>
              {c.label} {count > 0 && `(${count})`}
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="py-16 flex justify-center"><Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
      ) : filtered.length === 0 ? (
        <div className="glass rounded-2xl py-16 flex flex-col items-center gap-3">
          <ShieldCheck size={28} style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>
            {devices.length === 0 ? 'No devices to check yet' : 'No devices match this filter'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(d => (
            <DeviceCard key={d.device_id} d={d}
              expanded={expandedId === d.device_id}
              onToggleExpand={() => setExpandedId(expandedId === d.device_id ? null : d.device_id)}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  )
}