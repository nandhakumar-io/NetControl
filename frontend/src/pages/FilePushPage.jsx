// pages/FilePushPage.jsx — Batch SCP file push as a full page
import React, { useState, useRef, useEffect } from 'react'
import {
  Upload, CheckCircle2, XCircle, Loader2, AlertCircle,
  FileText, Shield, RefreshCw, Layers, Monitor, FolderOpen,
  ChevronDown, ChevronUp, X
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'

// ─── Sub-components ──────────────────────────────────────────────────────────

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{hint}</p>}
    </div>
  )
}

function DropZone({ file, onFile }) {
  const inputRef = useRef(null)
  const [over, setOver] = useState(false)

  const handle = (f) => { if (f) onFile(f) }
  const onDrop = (e) => {
    e.preventDefault(); setOver(false)
    handle(e.dataTransfer.files[0])
  }

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`
        relative flex flex-col items-center justify-center gap-2 h-36 rounded-xl border-2 border-dashed
        cursor-pointer transition-all duration-200
        ${over
          ? 'border-brand-500/60 bg-brand-500/8'
          : file
            ? 'border-accent-green/40 bg-accent-green/6'
            : 'border-white/10 hover:border-brand-500/30 hover:bg-brand-500/5'
        }
      `}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={e => handle(e.target.files[0])}
      />
      {file ? (
        <>
          <FileText size={24} className="text-accent-green" />
          <p className="text-sm font-body font-medium" style={{ color: 'var(--text-primary)' }}>
            {file.name}
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {(file.size / 1024).toFixed(1)} KB · click to change
          </p>
          <button
            onClick={e => { e.stopPropagation(); onFile(null) }}
            className="absolute top-2 right-2 p-1 rounded-lg hover:bg-accent-red/10 text-slate-500 hover:text-accent-red transition-colors"
          >
            <X size={13} />
          </button>
        </>
      ) : (
        <>
          <Upload size={24} style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>
            Drop a file here or <span className="text-brand-400">browse</span>
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Max 50 MB</p>
        </>
      )}
    </div>
  )
}

function DeviceCheckbox({ device, checked, onChange }) {
  const statusDot = {
    online:  'bg-accent-green',
    offline: 'bg-slate-600',
    unknown: 'bg-accent-yellow',
  }[device.status] || 'bg-slate-600'

  return (
    <button
      onClick={() => onChange(device.id)}
      className={`
        flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all duration-150 text-left w-full
        ${checked
          ? 'border-brand-500/40 bg-brand-500/10'
          : 'border-white/6 bg-surface-2 hover:border-white/12 hover:bg-surface-3'
        }
      `}
    >
      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors
        ${checked ? 'bg-brand-500 border-brand-500' : 'border-white/20'}`}>
        {checked && <CheckCircle2 size={10} className="text-white" />}
      </div>
      <div className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-body font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {device.name}
        </p>
        <p className="text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>
          {device.ip_address} · {device.os_type}
        </p>
      </div>
    </button>
  )
}

function ResultRow({ r }) {
  const ok = r.result === 'success'
  return (
    <div className="flex items-start gap-3 py-3 border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
      {ok
        ? <CheckCircle2 size={16} className="text-accent-green mt-0.5 shrink-0" />
        : <XCircle size={16} className="text-accent-red mt-0.5 shrink-0" />
      }
      <div className="min-w-0 flex-1">
        <p className="text-sm font-body font-medium" style={{ color: 'var(--text-primary)' }}>
          {r.device}
        </p>
        <p className="text-xs font-mono mt-0.5 break-all" style={{ color: ok ? 'var(--text-muted)' : '#ef4444' }}>
          {r.details}
        </p>
      </div>
      <span className={`text-xs font-body px-2 py-0.5 rounded-full shrink-0 ${
        ok ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red'
      }`}>
        {ok ? 'success' : 'failed'}
      </span>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function FilePushPage() {
  const [devices, setDevices]     = useState([])
  const [groups, setGroups]       = useState([])
  const [loading, setLoading]     = useState(true)

  // form state
  const [file, setFile]             = useState(null)
  const [remotePath, setRemotePath] = useState('/tmp/')
  const [fileMode, setFileMode]     = useState('0644')
  const [targetMode, setTargetMode] = useState('devices') // 'devices' | 'group' | 'all'
  const [groupId, setGroupId]       = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [pin, setPin]               = useState('')
  const [searchQ, setSearchQ]       = useState('')

  // push state
  const [pushing, setPushing]       = useState(false)
  const [result, setResult]         = useState(null)

  // Load devices + groups
  useEffect(() => {
    Promise.all([
      api.get('/devices'),
      api.get('/groups'),
    ]).then(([d, g]) => {
      setDevices(d.data)
      setGroups(g.data)
    }).catch(() => {
      toast.error('Failed to load devices')
    }).finally(() => setLoading(false))
  }, [])

  const toggleDevice = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const filteredDevices = devices.filter(d =>
    d.name.toLowerCase().includes(searchQ.toLowerCase()) ||
    d.ip_address.includes(searchQ)
  )

  const resolvedIds = (() => {
    if (targetMode === 'devices') return [...selectedIds]
    if (targetMode === 'all')     return devices.map(d => d.id)
    return []
  })()

  const targetLabel = (() => {
    if (targetMode === 'group') {
      const g = groups.find(g => g.id === groupId)
      return g ? `All devices in "${g.name}"` : '—'
    }
    if (targetMode === 'all') return `All ${devices.length} devices`
    return `${resolvedIds.length} device${resolvedIds.length !== 1 ? 's' : ''} selected`
  })()

  const canSubmit =
    file &&
    remotePath.trim() &&
    pin.trim() &&
    (targetMode === 'group' ? !!groupId : resolvedIds.length > 0)

  const handlePush = async () => {
    if (!canSubmit) return
    setPushing(true)
    setResult(null)

    const form = new FormData()
    form.append('file', file)
    form.append('remotePath', remotePath.trim())
    form.append('actionPin', pin)
    form.append('fileMode', fileMode)

    if (targetMode === 'group') {
      form.append('groupId', groupId)
    } else {
      form.append('deviceIds', JSON.stringify(resolvedIds))
    }

    try {
      const { data } = await api.post('/file-push', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      })
      setResult(data)
      toast.success(`Push complete — ${data.pushed} succeeded, ${data.failed} failed`)
    } catch (err) {
      toast.error(err.response?.data?.error || 'File push failed')
    } finally {
      setPushing(false)
    }
  }

  const handleReset = () => {
    setFile(null)
    setRemotePath('/tmp/')
    setFileMode('0644')
    setTargetMode('devices')
    setGroupId('')
    setSelectedIds(new Set())
    setPin('')
    setResult(null)
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        icon={Upload}
        title="File Push"
        description="Transfer files to one or more devices over SCP/SFTP"
        actions={result && (
          <button onClick={handleReset} className="btn-ghost flex items-center gap-2">
            <RefreshCw size={14} /> New Push
          </button>
        )}
      />

      {/* ── Results panel ─────────────────────────────────────────────── */}
      {result && (
        <div className="card space-y-4">
          {/* Summary */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: result.overall === 'success' ? 'rgba(34,197,94,0.15)' : result.overall === 'failure' ? 'rgba(239,68,68,0.15)' : 'rgba(234,179,8,0.15)' }}>
              {result.overall === 'success'
                ? <CheckCircle2 size={18} className="text-accent-green" />
                : result.overall === 'failure'
                  ? <XCircle size={18} className="text-accent-red" />
                  : <AlertCircle size={18} className="text-accent-yellow" />
              }
            </div>
            <div>
              <h2 className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>
                Push {result.overall === 'success' ? 'Completed' : result.overall === 'failure' ? 'Failed' : 'Partially Completed'}
              </h2>
              <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                {result.file} → {result.remotePath}
              </p>
            </div>
            <div className="ml-auto flex gap-3">
              <div className="text-center">
                <p className="text-2xl font-display text-accent-green">{result.pushed}</p>
                <p className="text-xs text-slate-500">succeeded</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-display text-accent-red">{result.failed}</p>
                <p className="text-xs text-slate-500">failed</p>
              </div>
            </div>
          </div>

          {/* Per-device results */}
          <div className="rounded-xl overflow-hidden border" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="px-4 py-2.5" style={{ backgroundColor: 'var(--bg-surface-2)' }}>
              <p className="text-xs font-body font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Device Results
              </p>
            </div>
            <div className="px-4 divide-y" style={{ divideColor: 'var(--border-subtle)' }}>
              {result.results.map((r, i) => <ResultRow key={i} r={r} />)}
            </div>
          </div>
        </div>
      )}

      {/* ── Main form ─────────────────────────────────────────────────── */}
      {!result && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* LEFT: File + Options */}
          <div className="lg:col-span-1 space-y-5">
            <div className="card space-y-5">
              <h2 className="text-sm font-body font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                File
              </h2>

              <Field label="File to push">
                <DropZone file={file} onFile={setFile} />
              </Field>

              <Field
                label="Remote destination path"
                hint="Full path including filename on the remote device"
              >
                <input
                  className="input-field"
                  placeholder="/tmp/script.sh"
                  value={remotePath}
                  onChange={e => setRemotePath(e.target.value)}
                />
              </Field>

              <Field label="File permissions">
                <div className="flex gap-1.5 flex-wrap">
                  {[
                    ['0644', '0644 (Read-only)'],
                    ['0755', '0755 (Executable)'],
                    ['0600', '0600 (Private)'],
                  ].map(([val, lbl]) => (
                    <button
                      key={val}
                      onClick={() => setFileMode(val)}
                      className={`chip ${fileMode === val ? 'chip-selected' : ''}`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            {/* PIN + Action */}
            <div className="card space-y-4">
              <h2 className="text-sm font-body font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Authorise
              </h2>

              <Field label="Action PIN">
                <div className="relative">
                  <Shield size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-400" />
                  <input
                    type="password"
                    className="input-field pl-8"
                    placeholder="Enter your action PIN"
                    value={pin}
                    onChange={e => setPin(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && canSubmit && handlePush()}
                    autoComplete="off"
                  />
                </div>
              </Field>

              {/* Summary */}
              <div className="px-3 py-2.5 rounded-lg text-xs font-body space-y-1"
                style={{ backgroundColor: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
                <p style={{ color: 'var(--text-muted)' }}>Push summary</p>
                <p style={{ color: 'var(--text-secondary)' }}>
                  {file ? <span className="font-medium text-brand-400">{file.name}</span> : <span>No file selected</span>}
                </p>
                <p style={{ color: 'var(--text-secondary)' }}>→ <span className="font-mono">{remotePath || '—'}</span></p>
                <p style={{ color: 'var(--text-secondary)' }}>Targets: {targetLabel}</p>
                <p style={{ color: 'var(--text-secondary)' }}>Mode: <span className="font-mono">{fileMode}</span></p>
              </div>

              <div className="flex gap-2 p-3 rounded-lg"
                style={{ backgroundColor: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)' }}>
                <AlertCircle size={13} className="text-accent-yellow shrink-0 mt-0.5" />
                <p className="text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
                  Devices must have SSH/SFTP configured. Windows requires OpenSSH Server.
                </p>
              </div>

              <button
                onClick={handlePush}
                disabled={!canSubmit || pushing}
                className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pushing
                  ? <><Loader2 size={15} className="animate-spin" /> Pushing…</>
                  : <><Upload size={15} /> Push File</>
                }
              </button>
            </div>
          </div>

          {/* RIGHT: Target device selector */}
          <div className="lg:col-span-2 card space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-body font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Target Devices
              </h2>
              {/* Mode tabs */}
              <div className="flex gap-1 p-1 rounded-lg" style={{ backgroundColor: 'var(--bg-surface-2)' }}>
                {[
                  ['devices', 'Select devices'],
                  ['group',   'By group'],
                  ['all',     `All (${devices.length})`],
                ].map(([val, lbl]) => (
                  <button
                    key={val}
                    onClick={() => setTargetMode(val)}
                    className={`px-3 py-1.5 rounded-md text-xs font-body font-medium transition-all ${
                      targetMode === val
                        ? 'bg-brand-500 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {/* Group picker */}
            {targetMode === 'group' && (
              <div className="space-y-3">
                <select
                  className="input-field"
                  value={groupId}
                  onChange={e => setGroupId(e.target.value)}
                >
                  <option value="">Select a group…</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>{g.name} ({g.device_count ?? '?'} devices)</option>
                  ))}
                </select>
                {groupId && (
                  <p className="text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
                    File will be pushed to all devices in "{groups.find(g => g.id === groupId)?.name}"
                  </p>
                )}
              </div>
            )}

            {/* All devices notice */}
            {targetMode === 'all' && (
              <div className="flex gap-2.5 p-3 rounded-lg"
                style={{ backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                <AlertCircle size={14} className="text-accent-red shrink-0 mt-0.5" />
                <p className="text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
                  File will be pushed to <strong>all {devices.length} devices</strong>. Double-check your remote path before proceeding.
                </p>
              </div>
            )}

            {/* Device checklist */}
            {targetMode === 'devices' && (
              <>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Monitor size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input
                      className="input-field pl-8 py-2 text-sm"
                      placeholder="Search devices…"
                      value={searchQ}
                      onChange={e => setSearchQ(e.target.value)}
                    />
                  </div>
                  <button
                    onClick={() => {
                      if (selectedIds.size === filteredDevices.length) {
                        setSelectedIds(new Set())
                      } else {
                        setSelectedIds(new Set(filteredDevices.map(d => d.id)))
                      }
                    }}
                    className="btn-ghost text-xs px-3 py-2 whitespace-nowrap"
                  >
                    {selectedIds.size === filteredDevices.length && filteredDevices.length > 0
                      ? 'Deselect all'
                      : 'Select all'
                    }
                  </button>
                </div>

                {loading ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="h-14 rounded-lg bg-surface-3 animate-pulse" />
                    ))}
                  </div>
                ) : filteredDevices.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: 'var(--text-muted)' }}>
                    <Monitor size={28} className="opacity-30" />
                    <p className="text-sm font-body">No devices found</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-96 overflow-y-auto pr-1">
                    {filteredDevices.map(d => (
                      <DeviceCheckbox
                        key={d.id}
                        device={d}
                        checked={selectedIds.has(d.id)}
                        onChange={toggleDevice}
                      />
                    ))}
                  </div>
                )}

                {selectedIds.size > 0 && (
                  <p className="text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
                    {selectedIds.size} device{selectedIds.size !== 1 ? 's' : ''} selected
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
