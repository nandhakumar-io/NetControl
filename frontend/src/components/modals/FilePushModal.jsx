// components/modals/FilePushModal.jsx
// Batch SCP file push — select devices or a group, choose file, set remote path, confirm with PIN
import React, { useState, useRef, useCallback } from 'react'
import {
  Upload, X, FolderOpen, CheckCircle2, XCircle,
  Loader2, AlertCircle, ChevronDown, FileText, Shield
} from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

// ─── tiny sub-components ────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
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
        relative flex flex-col items-center justify-center gap-2 h-28 rounded-xl border-2 border-dashed
        cursor-pointer transition-all duration-200
        ${over
          ? 'border-brand-500/60 bg-brand-500/8'
          : file
            ? 'border-accent-green/40 bg-accent-green/6'
            : 'border-white/10 hover:border-brand-500/30 hover:bg-brand-500/5'
        }
      `}
      style={!over && !file ? { borderColor: 'var(--border-subtle)' } : {}}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={e => handle(e.target.files[0])}
      />
      {file ? (
        <>
          <FileText size={20} className="text-accent-green" />
          <p className="text-sm font-body font-medium" style={{ color: 'var(--text-primary)' }}>
            {file.name}
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {(file.size / 1024).toFixed(1)} KB · click to change
          </p>
        </>
      ) : (
        <>
          <Upload size={20} style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>
            Drop a file here or <span className="text-brand-400">browse</span>
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Max 50 MB</p>
        </>
      )}
    </div>
  )
}

function ResultRow({ r }) {
  const ok = r.result === 'success'
  return (
    <div className="flex items-start gap-2.5 py-2 border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
      {ok
        ? <CheckCircle2 size={14} className="text-accent-green mt-0.5 shrink-0" />
        : <XCircle size={14} className="text-accent-red mt-0.5 shrink-0" />
      }
      <div className="min-w-0">
        <p className="text-sm font-body font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {r.device}
        </p>
        <p className="text-xs font-mono mt-0.5 break-all" style={{ color: ok ? 'var(--text-muted)' : '#ef4444' }}>
          {r.details}
        </p>
      </div>
    </div>
  )
}

// ─── Main modal ──────────────────────────────────────────────────────────────

export default function FilePushModal({ open, onClose, devices, groups, selectedIds }) {
  const [file, setFile]             = useState(null)
  const [remotePath, setRemotePath] = useState('/tmp/')
  const [fileMode, setFileMode]     = useState('0644')
  const [targetMode, setTargetMode] = useState('selected') // 'selected' | 'group' | 'all'
  const [groupId, setGroupId]       = useState('')
  const [pin, setPin]               = useState('')
  const [step, setStep]             = useState('form')    // 'form' | 'pushing' | 'results'
  const [pushResult, setPushResult] = useState(null)

  const reset = () => {
    setFile(null); setRemotePath('/tmp/'); setFileMode('0644')
    setTargetMode('selected'); setGroupId(''); setPin('')
    setStep('form'); setPushResult(null)
  }

  const handleClose = () => { reset(); onClose() }

  // Which device IDs will be pushed to
  const resolvedDeviceIds = (() => {
    if (targetMode === 'selected') return [...selectedIds]
    if (targetMode === 'all')      return devices.map(d => d.id)
    return [] // group — pass groupId instead
  })()

  const targetLabel = (() => {
    if (targetMode === 'group') {
      const g = groups.find(g => g.id === groupId)
      return g ? `All devices in "${g.name}"` : 'Select a group'
    }
    if (targetMode === 'all') return `All ${devices.length} devices`
    return `${resolvedDeviceIds.length} selected device${resolvedDeviceIds.length !== 1 ? 's' : ''}`
  })()

  const canSubmit =
    file &&
    remotePath.trim() &&
    pin.trim() &&
    (targetMode === 'group' ? !!groupId : resolvedDeviceIds.length > 0)

  const handlePush = async () => {
    if (!canSubmit) return
    setStep('pushing')

    const form = new FormData()
    form.append('file', file)
    form.append('remotePath', remotePath.trim())
    form.append('actionPin', pin)
    form.append('fileMode', fileMode)

    if (targetMode === 'group') {
      form.append('groupId', groupId)
    } else {
      form.append('deviceIds', JSON.stringify(resolvedDeviceIds))
    }

    try {
      const { data } = await api.post('/file-push', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000, // 2 min — large files / many devices
      })
      setPushResult(data)
      setStep('results')
    } catch (err) {
      toast.error(err.response?.data?.error || 'File push failed')
      setStep('form')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Panel */}
      <div
        className="relative w-full max-w-lg rounded-2xl border shadow-2xl animate-slide-up flex flex-col max-h-[90vh]"
        style={{
          backgroundColor: 'var(--bg-surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="w-8 h-8 rounded-lg bg-brand-500/15 border border-brand-500/25 flex items-center justify-center">
            <Upload size={15} className="text-brand-400" />
          </div>
          <div>
            <h2 className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>
              {step === 'results' ? 'Push Complete' : 'Batch File Push'}
            </h2>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {step === 'results'
                ? `${pushResult?.pushed} succeeded · ${pushResult?.failed} failed`
                : 'Transfer a file to multiple devices via SCP/SFTP'
              }
            </p>
          </div>
          <button
            onClick={handleClose}
            className="ml-auto p-1.5 rounded-lg transition-all hover:bg-accent-red/10 hover:text-accent-red"
            style={{ color: 'var(--text-muted)' }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ── FORM ─────────────────────────────────────────────────────── */}
          {step === 'form' && (
            <>
              {/* File drop zone */}
              <Field label="File to push">
                <DropZone file={file} onFile={setFile} />
              </Field>

              {/* Remote path */}
              <Field label="Remote destination path">
                <input
                  className="input-field"
                  placeholder="/tmp/script.sh"
                  value={remotePath}
                  onChange={e => setRemotePath(e.target.value)}
                />
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  Full path including filename on the remote device
                </p>
              </Field>

              {/* File mode */}
              <Field label="File permissions">
                <div className="flex gap-1.5 flex-wrap">
                  {[['0644', 'Read-only (0644)'], ['0755', 'Executable (0755)'], ['0600', 'Private (0600)']].map(([val, lbl]) => (
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

              {/* Target selector */}
              <Field label="Target devices">
                <div className="flex gap-1.5 mb-2 flex-wrap">
                  {[
                    ['selected', `Selected (${[...selectedIds].length})`],
                    ['group', 'By group'],
                    ['all', `All (${devices.length})`],
                  ].map(([val, lbl]) => (
                    <button
                      key={val}
                      onClick={() => setTargetMode(val)}
                      disabled={val === 'selected' && selectedIds.size === 0}
                      className={`chip ${targetMode === val ? 'chip-selected' : ''} disabled:opacity-40 disabled:cursor-not-allowed`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>

                {targetMode === 'group' && (
                  <select
                    className="input-field"
                    value={groupId}
                    onChange={e => setGroupId(e.target.value)}
                  >
                    <option value="">Select a group…</option>
                    {groups.map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                )}

                {/* Summary line */}
                {(targetMode !== 'group' || groupId) && (
                  <p className="text-xs mt-1.5 font-body" style={{ color: 'var(--text-secondary)' }}>
                    → {targetLabel}
                  </p>
                )}
              </Field>

              {/* PIN */}
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

              {/* Warning */}
              <div className="flex gap-2.5 p-3 rounded-lg" style={{ backgroundColor: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)' }}>
                <AlertCircle size={14} className="text-accent-yellow shrink-0 mt-0.5" />
                <p className="text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
                  Devices must have SSH/SFTP access configured. Windows devices need OpenSSH Server installed.
                </p>
              </div>
            </>
          )}

          {/* ── PUSHING ──────────────────────────────────────────────────── */}
          {step === 'pushing' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 size={32} className="text-brand-400 animate-spin" />
              <div className="text-center">
                <p className="text-sm font-body font-medium" style={{ color: 'var(--text-primary)' }}>
                  Pushing {file?.name}…
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {targetLabel}
                </p>
              </div>
            </div>
          )}

          {/* ── RESULTS ──────────────────────────────────────────────────── */}
          {step === 'results' && pushResult && (
            <>
              {/* Summary pills */}
              <div className="flex gap-2">
                <div className="flex-1 text-center py-2.5 rounded-lg" style={{ backgroundColor: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)' }}>
                  <p className="text-xl font-display text-accent-green">{pushResult.pushed}</p>
                  <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>succeeded</p>
                </div>
                <div className="flex-1 text-center py-2.5 rounded-lg" style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
                  <p className="text-xl font-display text-accent-red">{pushResult.failed}</p>
                  <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>failed</p>
                </div>
              </div>

              <p className="text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                {file?.name} → {pushResult.remotePath}
              </p>

              {/* Per-device results */}
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
                <div className="px-4 py-2.5" style={{ backgroundColor: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border-subtle)' }}>
                  <p className="text-xs font-body font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    Device results
                  </p>
                </div>
                <div className="px-4 max-h-56 overflow-y-auto">
                  {pushResult.results.map((r, i) => (
                    <ResultRow key={i} r={r} />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
          {step === 'results' ? (
            <>
              <button onClick={reset} className="btn-ghost">
                Push Another
              </button>
              <button onClick={handleClose} className="btn-primary">
                Done
              </button>
            </>
          ) : (
            <>
              <button onClick={handleClose} className="btn-ghost" disabled={step === 'pushing'}>
                Cancel
              </button>
              <button
                onClick={handlePush}
                disabled={!canSubmit || step === 'pushing'}
                className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {step === 'pushing'
                  ? <><Loader2 size={14} className="animate-spin" /> Pushing…</>
                  : <><Upload size={14} /> Push File</>
                }
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
