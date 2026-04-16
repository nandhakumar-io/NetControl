import React, { useState, useEffect } from 'react'
import { X, Clock, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

const EMPTY = {
  name: '', action: 'wake', target_type: 'device',
  target_id: '', cron_expression: '', enabled: true, notes: ''
}

const CRON_PRESETS = [
  { label: 'Weekdays 8:00 AM',  value: '0 8 * * 1-5' },
  { label: 'Weekdays 6:00 PM',  value: '0 18 * * 1-5' },
  { label: 'Every day midnight', value: '0 0 * * *' },
  { label: 'Monday 9:00 AM',    value: '0 9 * * 1' },
  { label: 'Custom...',          value: 'custom' },
]

export default function ScheduleModal({ open, onClose, onSaved, schedule, devices, groups }) {
  const [form, setForm] = useState(EMPTY)
  const [loading, setLoading] = useState(false)
  const [customCron, setCustomCron] = useState(false)

  useEffect(() => {
    if (open) {
      if (schedule) {
        setForm({ ...EMPTY, ...schedule })
        const known = CRON_PRESETS.find(p => p.value === schedule.cron_expression)
        setCustomCron(!known || known.value === 'custom')
      } else {
        setForm(EMPTY)
        setCustomCron(false)
      }
    }
  }, [open, schedule])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handlePreset = (val) => {
    if (val === 'custom') { setCustomCron(true); set('cron_expression', '') }
    else { setCustomCron(false); set('cron_expression', val) }
  }

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.cron_expression.trim() || !form.target_id) {
      toast.error('Fill in all required fields')
      return
    }
    setLoading(true)
    try {
      if (schedule) {
        await api.put(`/schedules/${schedule.id}`, form)
        toast.success('Schedule updated')
      } else {
        await api.post('/schedules', form)
        toast.success('Schedule created')
      }
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  const targets = form.target_type === 'device' ? devices : groups

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="glass rounded-2xl border border-white/10 overflow-hidden">
          <div className="h-0.5 bg-accent-purple opacity-60" />

          <div className="flex items-center justify-between px-6 py-5 border-b border-white/6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-accent-purple/15 border border-accent-purple/25 flex items-center justify-center">
                <Clock size={16} className="text-accent-purple" />
              </div>
              <h3 className="font-display text-white">{schedule ? 'Edit Schedule' : 'New Schedule'}</h3>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1"><X size={16} /></button>
          </div>

          <div className="p-6 grid grid-cols-2 gap-4 max-h-[70vh] overflow-y-auto">
            <div className="col-span-2">
              <label className="label">Schedule Name</label>
              <input className="input-field" placeholder="e.g. LAB1 Morning Boot"
                value={form.name} onChange={e => set('name', e.target.value)} />
            </div>

            <div>
              <label className="label">Action</label>
              <select className="input-field" value={form.action} onChange={e => set('action', e.target.value)}>
                <option value="wake">Wake On LAN</option>
                <option value="shutdown">Shutdown</option>
                <option value="restart">Restart</option>
              </select>
            </div>

            <div>
              <label className="label">Target Type</label>
              <select className="input-field" value={form.target_type} onChange={e => { set('target_type', e.target.value); set('target_id', '') }}>
                <option value="device">Single Device</option>
                <option value="group">Lab / Group</option>
              </select>
            </div>

            <div className="col-span-2">
              <label className="label">Target {form.target_type === 'device' ? 'Device' : 'Group'}</label>
              <select className="input-field" value={form.target_id} onChange={e => set('target_id', e.target.value)}>
                <option value="">Select...</option>
                {targets?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>

            <div className="col-span-2">
              <label className="label">Time Preset</label>
              <div className="grid grid-cols-3 gap-2">
                {CRON_PRESETS.map(p => (
                  <button
                    key={p.value}
                    onClick={() => handlePreset(p.value)}
                    className={`text-xs py-2 px-2 rounded-lg font-body border transition-all ${
                      (p.value !== 'custom' && form.cron_expression === p.value) || (p.value === 'custom' && customCron)
                        ? 'bg-accent-purple/15 border-accent-purple/40 text-accent-purple'
                        : 'bg-surface-3 border-white/8 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {customCron && (
              <div className="col-span-2">
                <label className="label">Cron Expression</label>
                <input className="input-field" placeholder="0 8 * * 1-5"
                  value={form.cron_expression} onChange={e => set('cron_expression', e.target.value)} />
                <p className="text-xs text-slate-500 mt-1 font-mono">minute hour day month weekday</p>
              </div>
            )}

            {!customCron && form.cron_expression && (
              <div className="col-span-2 px-3 py-2 rounded-lg bg-surface-3 border border-white/6">
                <p className="text-xs font-mono text-accent-purple">{form.cron_expression}</p>
              </div>
            )}

            <div className="col-span-2">
              <label className="label">Notes (optional)</label>
              <textarea rows={2} className="input-field resize-none" placeholder="Any notes..."
                value={form.notes} onChange={e => set('notes', e.target.value)} />
            </div>

            <div className="col-span-2 flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface-3 border border-white/6">
              <span className="text-sm font-body text-slate-300">Enable schedule immediately</span>
              <button
                onClick={() => set('enabled', !form.enabled)}
                className={`w-10 h-5 rounded-full transition-all duration-200 relative ${form.enabled ? 'bg-accent-purple' : 'bg-surface-5'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${form.enabled ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
          </div>

          <div className="flex gap-3 px-6 pb-6">
            <button onClick={onClose} className="btn-ghost flex-1 justify-center" disabled={loading}>Cancel</button>
            <button onClick={handleSubmit}
              className="flex-1 justify-center flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg transition-all duration-200 text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30"
              disabled={loading}
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : null}
              {loading ? 'Saving...' : schedule ? 'Save Changes' : 'Create Schedule'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
