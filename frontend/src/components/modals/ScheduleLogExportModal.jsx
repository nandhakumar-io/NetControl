// components/modals/ScheduleLogExportModal.jsx — create/edit a recurring
// audit log export.
//
// Talks to routes/scheduledJobs.js's logExportSchedulesRouter, mounted at
// /api/log-export-schedules. Mirrors ScheduleBackupModal's structure. The
// export can go to either a file destination (rendered CSV/TXT, written to
// local storage / S3 / a remote folder — same destinations backups use) or
// straight to the configured syslog server, one message per matching row.
import React, { useState, useEffect } from 'react'
import { X, Shield, Loader2, Clock, FileSpreadsheet, Radio } from 'lucide-react'
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
  { value: '0 1 * * *',   label: 'Daily at 1:00 AM' },
  { value: '0 1 * * 0',   label: 'Weekly, Sunday 1:00 AM' },
  { value: '0 1 1 * *',   label: 'Monthly, 1st at 1:00 AM' },
  { value: '0 * * * *',   label: 'Every hour' },
  { value: 'custom',      label: 'Custom cron expression' },
]

const FORMATS = [['csv', 'CSV'], ['txt', 'TXT']]
const RESULTS = ['all', 'success', 'failure', 'partial']

export default function ScheduleLogExportModal({ open, onClose, onSaved, destinations, syslogConfigured, editing }) {
  const isEditing = !!editing

  const [name, setName] = useState('')
  const [preset, setPreset] = useState('0 1 * * *')
  const [customCron, setCustomCron] = useState('')
  const [exportTarget, setExportTarget] = useState('file') // 'file' | 'syslog'
  const [format, setFormat] = useState('csv')
  const [destinationId, setDestinationId] = useState(null)
  const [resultFilter, setResultFilter] = useState('all')
  const [actionFilter, setActionFilter] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [pin, setPin] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const cronExpr = preset === 'custom' ? customCron.trim() : preset

  useEffect(() => {
    if (!open) return
    if (editing) {
      setName(editing.name)
      const knownPreset = CRON_PRESETS.find(p => p.value === editing.cron_expr)
      setPreset(knownPreset ? knownPreset.value : 'custom')
      setCustomCron(knownPreset ? '' : editing.cron_expr)
      setExportTarget(editing.export_target || 'file')
      setFormat(editing.format || 'csv')
      setDestinationId(editing.destination_id || null)
      const filters = typeof editing.filters === 'string' ? JSON.parse(editing.filters || '{}') : (editing.filters || {})
      setResultFilter(filters.result || 'all')
      setActionFilter(filters.action || '')
      setEnabled(!!editing.enabled)
    } else {
      setName(''); setPreset('0 1 * * *'); setCustomCron('')
      setExportTarget('file'); setFormat('csv'); setDestinationId(null)
      setResultFilter('all'); setActionFilter(''); setEnabled(true)
    }
    setPin(''); setError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  if (!open) return null

  const canSubmit = name.trim() && cronExpr && pin.trim() &&
    (exportTarget !== 'syslog' || syslogConfigured) && !saving

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSaving(true); setError('')
    try {
      const filters = {}
      if (resultFilter !== 'all') filters.result = resultFilter
      if (actionFilter.trim()) filters.action = actionFilter.trim()

      const payload = {
        name: name.trim(),
        cronExpr,
        exportTarget,
        format: exportTarget === 'syslog' ? 'csv' : format, // ignored server-side for syslog, kept non-null
        filters,
        destinationId: exportTarget === 'file' ? (destinationId || null) : null,
        enabled,
        actionPin: pin,
      }
      const { data } = isEditing
        ? await api.put(`/log-export-schedules/${editing.id}`, payload)
        : await api.post('/log-export-schedules', payload)
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
                {isEditing ? 'Edit Scheduled Log Export' : 'Schedule a Log Export'}
              </h3>
              <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>Runs automatically on a recurring cron schedule</p>
            </div>
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/5" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
          </div>

          <div className="px-6 pb-6 space-y-4 max-h-[70vh] overflow-y-auto">
            <Field label="Name">
              <input className="input-field" placeholder="e.g. Weekly audit export"
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

            <Field label="Export target">
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setExportTarget('file')}
                  className={`flex items-center justify-center gap-2 h-10 rounded-lg border text-sm font-body transition-colors ${
                    exportTarget === 'file' ? 'bg-brand-500/15 border-brand-500/30 text-brand-400' : 'border-white/8 hover:bg-surface-3'
                  }`} style={exportTarget === 'file' ? {} : { color: 'var(--text-secondary)' }}>
                  <FileSpreadsheet size={15} /> File
                </button>
                <button type="button" onClick={() => setExportTarget('syslog')}
                  className={`flex items-center justify-center gap-2 h-10 rounded-lg border text-sm font-body transition-colors ${
                    exportTarget === 'syslog' ? 'bg-accent-cyan/15 border-accent-cyan/30 text-accent-cyan' : 'border-white/8 hover:bg-surface-3'
                  }`} style={exportTarget === 'syslog' ? {} : { color: 'var(--text-secondary)' }}>
                  <Radio size={15} /> Syslog Server
                </button>
              </div>
              {exportTarget === 'syslog' && !syslogConfigured && (
                <p className="text-xs font-body px-1 text-accent-yellow">
                  Syslog forwarding isn't configured yet — set it up from the Syslog Sync badge above first.
                </p>
              )}
            </Field>

            {exportTarget === 'file' ? (
              <>
                <Field label="Format">
                  <select className="input-field" value={format} onChange={e => setFormat(e.target.value)}>
                    {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
                <Field label="Destination">
                  <select className="input-field" value={destinationId || ''} onChange={e => setDestinationId(e.target.value || null)}>
                    {(destinations || []).map(d => <option key={d.id ?? 'local'} value={d.id ?? ''}>{d.name}</option>)}
                  </select>
                </Field>
              </>
            ) : (
              <p className="text-xs font-body px-1" style={{ color: 'var(--text-muted)' }}>
                Each matching audit row is sent as its own RFC 5424 syslog message — no file is produced.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Result filter">
                <select className="input-field" value={resultFilter} onChange={e => setResultFilter(e.target.value)}>
                  {RESULTS.map(r => <option key={r} value={r}>{r === 'all' ? 'All results' : r[0].toUpperCase() + r.slice(1)}</option>)}
                </select>
              </Field>
              <Field label="Action filter (optional)">
                <input className="input-field" placeholder="e.g. wake" value={actionFilter} onChange={e => setActionFilter(e.target.value)} />
              </Field>
            </div>

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