// components/modals/BulkCommandScheduleModal.jsx — create/edit form for a
// saved bulk command schedule (bulk_command_schedules table, wired to
// services/bulkCommandScheduler.js's cron engine on the backend). Mirrors
// ScheduleModal.jsx's cron-preset UX and BulkCommandPage.jsx's device
// picker, so this feels like the same app rather than a bolted-on form.
import React, { useState, useEffect, useMemo } from 'react'
import { X, CalendarClock, Loader2, Search, Square, CheckSquare } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import { getErrorMessage } from '../../lib/errors'

const EMPTY = { name: '', command: '', deviceIds: [], cronExpr: '', timeoutSec: 30, enabled: true }

const CRON_PRESETS = [
  { label: 'Every hour',        value: '0 * * * *' },
  { label: 'Daily 2:00 AM',     value: '0 2 * * *' },
  { label: 'Weekdays 8:00 AM',  value: '0 8 * * 1-5' },
  { label: 'Every Sunday midnight', value: '0 0 * * 0' },
  { label: 'Custom...',         value: 'custom' },
]

const STATUS_DOT = {
  online:  'bg-accent-green',
  offline: 'bg-slate-500',
  unknown: 'bg-amber-400',
  error:   'bg-red-400',
}

export default function BulkCommandScheduleModal({ open, onClose, onSaved, schedule, devices }) {
  const [form, setForm] = useState(EMPTY)
  const [loading, setLoading] = useState(false)
  const [customCron, setCustomCron] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!open) return
    if (schedule) {
      setForm({
        name: schedule.name, command: schedule.command,
        deviceIds: schedule.deviceIds || [], cronExpr: schedule.cronExpr,
        timeoutSec: schedule.timeoutSec || 30, enabled: schedule.enabled,
      })
      const known = CRON_PRESETS.find(p => p.value === schedule.cronExpr)
      setCustomCron(!known)
    } else {
      setForm(EMPTY)
      setCustomCron(false)
    }
    setSearch('')
  }, [open, schedule])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handlePreset = (val) => {
    if (val === 'custom') { setCustomCron(true); set('cronExpr', '') }
    else { setCustomCron(false); set('cronExpr', val) }
  }

  const filteredDevices = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return devices
    return devices.filter(d => d.name.toLowerCase().includes(q) || d.ip_address?.toLowerCase().includes(q))
  }, [devices, search])

  const selectedSet = useMemo(() => new Set(form.deviceIds), [form.deviceIds])

  const toggleDevice = (id) => {
    setForm(f => {
      const next = new Set(f.deviceIds)
      next.has(id) ? next.delete(id) : next.add(id)
      return { ...f, deviceIds: [...next] }
    })
  }

  const toggleAllFiltered = () => {
    const allSelected = filteredDevices.length > 0 && filteredDevices.every(d => selectedSet.has(d.id))
    setForm(f => {
      const next = new Set(f.deviceIds)
      filteredDevices.forEach(d => allSelected ? next.delete(d.id) : next.add(d.id))
      return { ...f, deviceIds: [...next] }
    })
  }

  const handleSubmit = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return }
    if (!form.command.trim()) { toast.error('Command is required'); return }
    if (!form.deviceIds.length) { toast.error('Select at least one device'); return }
    if (!form.cronExpr.trim()) { toast.error('A schedule time is required'); return }
    if (!Number.isFinite(form.timeoutSec) || form.timeoutSec < 5 || form.timeoutSec > 3600) {
      toast.error('Timeout must be between 5 and 3600 seconds'); return
    }
    setLoading(true)
    try {
      if (schedule) {
        await api.put(`/bulk-command-schedules/${schedule.id}`, form)
        toast.success('Schedule updated')
      } else {
        await api.post('/bulk-command-schedules', form)
        toast.success('Schedule created')
      }
      onSaved()
      onClose()
    } catch (err) {
      toast.error(getErrorMessage(err, 'Save failed'))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-xl animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="glass rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="h-0.5 bg-accent-purple opacity-60" />

          <div className="flex items-center justify-between px-6 py-5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-accent-purple/15 border border-accent-purple/25 flex items-center justify-center">
                <CalendarClock size={16} className="text-accent-purple" />
              </div>
              <h3 className="font-display" style={{ color: 'var(--text-primary)' }}>{schedule ? 'Edit Schedule' : 'New Command Schedule'}</h3>
            </div>
            <button onClick={onClose} className="p-1" style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
          </div>

          <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
            <div>
              <label className="label">Schedule Name</label>
              <input className="input-field" placeholder="e.g. Nightly disk cleanup"
                value={form.name} onChange={e => set('name', e.target.value)} />
            </div>

            <div>
              <label className="label">Command</label>
              <textarea rows={3} className="input-field font-mono text-sm resize-none"
                placeholder="e.g. sudo apt update && sudo apt upgrade -y"
                value={form.command} onChange={e => set('command', e.target.value)} />
            </div>

            <div>
              <label className="label">Devices ({form.deviceIds.length} selected)</label>
              <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
                <div className="p-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <div className="relative flex-1">
                    <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-faint)' }} />
                    <input value={search} onChange={e => setSearch(e.target.value)}
                      placeholder="Search devices…" className="input-field pl-7 py-1.5 text-xs" />
                  </div>
                  <button onClick={toggleAllFiltered} className="flex items-center gap-1 text-[11px] font-body font-medium shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {filteredDevices.length > 0 && filteredDevices.every(d => selectedSet.has(d.id))
                      ? <CheckSquare size={12} /> : <Square size={12} />}
                    Select all
                  </button>
                </div>
                <div className="max-h-40 overflow-y-auto p-1.5">
                  {filteredDevices.length === 0 ? (
                    <p className="text-center text-xs font-body py-4" style={{ color: 'var(--text-muted)' }}>No devices match.</p>
                  ) : filteredDevices.map(d => (
                    <div key={d.id} onClick={() => toggleDevice(d.id)}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-white/[0.03]">
                      {selectedSet.has(d.id) ? <CheckSquare size={13} style={{ color: '#6c5ce7' }} /> : <Square size={13} style={{ color: 'var(--text-faint)' }} />}
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[d.status] || STATUS_DOT.unknown}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-body truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</p>
                      </div>
                      <span className="text-[10px] font-body uppercase shrink-0" style={{ color: 'var(--text-faint)' }}>{d.os_type}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label className="label">Run Time</label>
              <div className="grid grid-cols-3 gap-2">
                {CRON_PRESETS.map(p => (
                  <button key={p.value} onClick={() => handlePreset(p.value)}
                    className={`text-xs py-2 px-2 rounded-lg font-body border transition-all ${
                      (p.value !== 'custom' && form.cronExpr === p.value) || (p.value === 'custom' && customCron)
                        ? 'bg-accent-purple/15 border-accent-purple/40 text-accent-purple' : ''
                    }`}
                    style={!((p.value !== 'custom' && form.cronExpr === p.value) || (p.value === 'custom' && customCron))
                      ? { background: 'var(--bg-surface-3)', borderColor: 'var(--border-mid)', color: 'var(--text-muted)' } : {}}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {customCron && (
                <div className="mt-2">
                  <input className="input-field" placeholder="0 8 * * 1-5"
                    value={form.cronExpr} onChange={e => set('cronExpr', e.target.value)} />
                  <p className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>minute hour day month weekday</p>
                </div>
              )}
              {!customCron && form.cronExpr && (
                <div className="mt-2 px-3 py-2 rounded-lg border" style={{ background: 'var(--bg-surface-3)', borderColor: 'var(--border-subtle)' }}>
                  <p className="text-xs font-mono text-accent-purple">{form.cronExpr}</p>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <label className="text-[11px] font-body shrink-0" style={{ color: 'var(--text-muted)' }}>Timeout per device</label>
              <input type="number" min={5} max={3600} step={5} value={form.timeoutSec}
                onChange={e => set('timeoutSec', parseInt(e.target.value, 10))}
                className="input-field font-mono text-xs h-7 w-20 py-0" />
              <span className="text-[11px] font-body" style={{ color: 'var(--text-faint)' }}>seconds (5–3600)</span>
            </div>

            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border" style={{ background: 'var(--bg-surface-3)', borderColor: 'var(--border-subtle)' }}>
              <span className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>Enable schedule immediately</span>
              <button onClick={() => set('enabled', !form.enabled)}
                className={`w-10 h-5 rounded-full transition-all duration-200 relative ${form.enabled ? 'bg-accent-purple' : 'bg-surface-5'}`}>
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${form.enabled ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
          </div>

          <div className="flex gap-3 px-6 pb-6">
            <button onClick={onClose} className="btn-ghost flex-1 justify-center" disabled={loading}>Cancel</button>
            <button onClick={handleSubmit}
              className="flex-1 justify-center flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg transition-all duration-200 text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30"
              disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : null}
              {loading ? 'Saving...' : schedule ? 'Save Changes' : 'Create Schedule'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}