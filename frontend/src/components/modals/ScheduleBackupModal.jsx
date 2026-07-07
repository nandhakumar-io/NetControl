// components/modals/ScheduleBackupModal.jsx — create/edit a recurring backup
//
// Talks to routes/scheduledJobs.js's backupSchedulesRouter, mounted at
// /api/backup-schedules. Mirrors the source/destination fields from
// BackupsPage's one-off form, plus a cron expression with a handful of
// friendly presets (custom cron still accepted for anything more specific).
import React, { useState, useEffect, useMemo } from 'react'
import { X, Shield, Loader2, Clock, Server, HardDrive } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

function Field({ label, children, hint }) {
  return (
    <div className="space-y-1.5">
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-xs font-body px-1" style={{ color: 'var(--text-muted)' }}>{hint}</p>}
    </div>
  )
}

const CRON_PRESETS = [
  { value: '0 2 * * *',   label: 'Daily at 2:00 AM' },
  { value: '0 2 * * 0',   label: 'Weekly, Sunday 2:00 AM' },
  { value: '0 2 1 * *',   label: 'Monthly, 1st at 2:00 AM' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: 'custom',      label: 'Custom cron expression' },
]

const FORMATS = [['zip', 'ZIP'], ['tar', 'TAR'], ['tar.gz', 'TAR.GZ']]

export default function ScheduleBackupModal({ open, onClose, onSaved, devices, destinations, editing }) {
  const isEditing = !!editing

  const [name, setName] = useState('')
  const [preset, setPreset] = useState('0 2 * * *')
  const [customCron, setCustomCron] = useState('')
  const [deviceId, setDeviceId] = useState('local')
  const [disks, setDisks] = useState([])
  const [mount, setMount] = useState(null)
  const [sourcePath, setSourcePath] = useState('')
  const [format, setFormat] = useState('zip')
  const [label, setLabel] = useState('')
  const [destinationId, setDestinationId] = useState(null)
  const [enabled, setEnabled] = useState(true)
  const [pin, setPin] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isRemoteSource = deviceId !== 'local'
  const cronExpr = preset === 'custom' ? customCron.trim() : preset

  useEffect(() => {
    if (!open) return
    if (editing) {
      setName(editing.name)
      const knownPreset = CRON_PRESETS.find(p => p.value === editing.cron_expr)
      setPreset(knownPreset ? knownPreset.value : 'custom')
      setCustomCron(knownPreset ? '' : editing.cron_expr)
      setDeviceId(editing.source_device_id || 'local')
      setMount(editing.mount || null)
      setSourcePath(editing.source_path || '')
      setFormat(editing.format || 'zip')
      setLabel(editing.label || '')
      setDestinationId(editing.destination_id || null)
      setEnabled(!!editing.enabled)
    } else {
      setName(''); setPreset('0 2 * * *'); setCustomCron('')
      setDeviceId('local'); setMount(null); setSourcePath('')
      setFormat('zip'); setLabel(''); setDestinationId(null); setEnabled(true)
    }
    setPin(''); setError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  // Load disks/mounts whenever a remote device is picked, so the operator
  // can choose which mount the typed path lives under (mirrors BackupsPage).
  useEffect(() => {
    if (!open || !isRemoteSource) { setDisks([]); return }
    (async () => {
      try {
        const { data } = await api.get(`/backup/devices/${deviceId}/disks`)
        setDisks(data)
        if (!mount) setMount(data[0]?.mount ?? null)
      } catch { setDisks([]) }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deviceId])

  if (!open) return null

  const canSubmit = name.trim() && cronExpr && sourcePath.trim() && pin.trim() &&
    (!isRemoteSource || mount) && !saving

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSaving(true); setError('')
    try {
      const payload = {
        name: name.trim(),
        cronExpr,
        sourcePath: sourcePath.trim(),
        sourceDeviceId: isRemoteSource ? deviceId : null,
        mount: isRemoteSource ? mount : null,
        format,
        label: label.trim() || null,
        destinationId: destinationId || null,
        enabled,
        actionPin: pin,
      }
      const { data } = isEditing
        ? await api.put(`/backup-schedules/${editing.id}`, payload)
        : await api.post('/backup-schedules', payload)
      toast.success(`Schedule "${data.name}" ${isEditing ? 'updated' : 'created'}`)
      onSaved?.(data)
      onClose()
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || `Failed to ${isEditing ? 'update' : 'create'} schedule`)
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'rgba(108,92,231,0.25)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
          <div className="h-0.5 opacity-70 bg-[#6c5ce7]" />

          <div className="flex items-start justify-between p-6 pb-4">
            <div>
              <h3 className="text-lg font-heading font-bold" style={{ color: 'var(--text-primary)' }}>
                {isEditing ? 'Edit Scheduled Backup' : 'Schedule a Backup'}
              </h3>
              <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>Runs automatically on a recurring cron schedule</p>
            </div>
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
          </div>

          <div className="px-6 pb-6 space-y-4 max-h-[70vh] overflow-y-auto">
            <Field label="Name">
              <input className="input-field" placeholder="e.g. Nightly config backup"
                value={name} onChange={e => setName(e.target.value)} maxLength={100} />
            </Field>

            <Field label="Frequency">
              <div className="relative">
                <Clock size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-400 pointer-events-none" />
                <select className="input-field pl-8" value={preset} onChange={e => setPreset(e.target.value)}>
                  {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              {preset === 'custom' && (
                <input className="input-field font-mono text-xs mt-1.5" placeholder="e.g. 0 */4 * * *"
                  value={customCron} onChange={e => setCustomCron(e.target.value)} />
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Source device">
                <div className="relative">
                  <Server size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-400 pointer-events-none" />
                  <select className="input-field pl-8" value={deviceId} onChange={e => { setDeviceId(e.target.value); setMount(null) }}>
                    {(devices || []).map(d => (
                      <option key={d.id} value={d.id}>{d.name}{!d.sshCapable && !d.isLocal ? ' — no SSH' : ''}</option>
                    ))}
                  </select>
                </div>
              </Field>
              {isRemoteSource ? (
                <Field label="Mount">
                  <div className="relative">
                    <HardDrive size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-400 pointer-events-none" />
                    <select className="input-field pl-8 font-mono text-xs" value={mount || ''} onChange={e => setMount(e.target.value)}>
                      {disks.length === 0 && <option value="">Loading…</option>}
                      {disks.map(d => <option key={d.mount} value={d.mount}>{d.mount}</option>)}
                    </select>
                  </div>
                </Field>
              ) : (
                <Field label="Format">
                  <select className="input-field" value={format} onChange={e => setFormat(e.target.value)}>
                    {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
              )}
            </div>

            <Field label="Source path" hint="Absolute path to the file or folder on the chosen device">
              <input className="input-field font-mono text-sm" placeholder="/etc/netcontrol" value={sourcePath} onChange={e => setSourcePath(e.target.value)} />
            </Field>

            {isRemoteSource && (
              <Field label="Format">
                <select className="input-field" value={format} onChange={e => setFormat(e.target.value)}>
                  {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
            )}

            <Field label="Destination">
              <select className="input-field" value={destinationId || ''} onChange={e => setDestinationId(e.target.value || null)}>
                {(destinations || []).map(d => <option key={d.id ?? 'local'} value={d.id ?? ''}>{d.name}</option>)}
              </select>
            </Field>

            <Field label="Label (optional)">
              <input className="input-field" placeholder="e.g. lab-configs" value={label} onChange={e => setLabel(e.target.value)} maxLength={80} />
            </Field>

            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
              <span className="text-sm font-body" style={{ color: 'var(--text-primary)' }}>Enabled</span>
              <button onClick={() => setEnabled(v => !v)}
                className="relative w-10 h-5.5 rounded-full transition-colors shrink-0"
                style={{ background: enabled ? '#22c55e' : 'var(--border-subtle)' }}>
                <span className="absolute top-0.5 w-4.5 h-4.5 rounded-full bg-white transition-transform"
                  style={{ transform: enabled ? 'translateX(19px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <Field label="Action PIN">
              <div className="relative">
                <Shield size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-400" />
                <input type="password" className="input-field pl-8" value={pin} onChange={e => setPin(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()} autoComplete="off" />
              </div>
            </Field>

            {error && <p className="text-xs font-mono text-accent-red">{error}</p>}

            <button onClick={handleSubmit} disabled={!canSubmit}
              className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
              {saving ? <><Loader2 size={15} className="animate-spin" /> Saving…</> : (isEditing ? 'Save Changes' : 'Create Schedule')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}