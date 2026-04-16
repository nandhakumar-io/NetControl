import React, { useState, useEffect, useCallback } from 'react'
import { Clock, Plus, Pencil, Trash2, Play, Pause, Zap, Power, RotateCcw, Monitor, Layers } from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import ScheduleModal from '../components/modals/ScheduleModal'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'

const ACTION_META = {
  wake:     { icon: Zap,       color: 'text-accent-green',  bg: 'bg-accent-green/10 border-accent-green/20',  label: 'Wake' },
  shutdown: { icon: Power,     color: 'text-accent-red',    bg: 'bg-accent-red/10 border-accent-red/20',      label: 'Shutdown' },
  restart:  { icon: RotateCcw, color: 'text-accent-yellow', bg: 'bg-accent-yellow/10 border-accent-yellow/20', label: 'Restart' },
}

function CronBadge({ expr }) {
  const parts = expr.split(' ')
  const readable = (() => {
    if (expr === '0 8 * * 1-5') return 'Weekdays 8:00 AM'
    if (expr === '0 18 * * 1-5') return 'Weekdays 6:00 PM'
    if (expr === '0 0 * * *') return 'Daily midnight'
    if (expr === '0 9 * * 1') return 'Mon 9:00 AM'
    return expr
  })()
  return (
    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-purple/10 border border-accent-purple/20">
      <Clock size={11} className="text-accent-purple" />
      <span className="text-xs font-mono text-accent-purple">{readable}</span>
    </span>
  )
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState([])
  const [devices, setDevices]     = useState([])
  const [groups, setGroups]       = useState([])
  const [loading, setLoading]     = useState(true)
  const [schedModal, setSchedModal]   = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const fetchAll = useCallback(async () => {
    try {
      const [s, d, g] = await Promise.all([
        api.get('/schedules'),
        api.get('/devices'),
        api.get('/groups'),
      ])
      setSchedules(s.data)
      setDevices(d.data)
      setGroups(g.data)
    } catch { toast.error('Failed to load') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const toggleEnabled = async (schedule) => {
    try {
      await api.put(`/schedules/${schedule.id}`, { ...schedule, enabled: !schedule.enabled })
      toast.success(schedule.enabled ? 'Schedule paused' : 'Schedule enabled')
      fetchAll()
    } catch (err) { toast.error(err.response?.data?.error || 'Update failed') }
  }

  const handleDelete = async () => {
    try {
      await api.delete(`/schedules/${deleteTarget.id}`)
      toast.success('Schedule deleted')
      setDeleteTarget(null)
      fetchAll()
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed') }
  }

  const getTargetName = (schedule) => {
    if (schedule.target_type === 'device') {
      return devices.find(d => d.id === schedule.target_id)?.name || 'Unknown device'
    }
    return groups.find(g => g.id === schedule.target_id)?.name || 'Unknown group'
  }

  const enabled  = schedules.filter(s => s.enabled)
  const disabled = schedules.filter(s => !s.enabled)

  return (
    <div className="p-6 max-w-[1400px] mx-auto animate-fade-in">
      <PageHeader
        icon={Clock}
        title="Schedules"
        description="Automate power on/off at specific times"
        iconColor="text-accent-purple"
        iconBg="bg-accent-purple/15 border-accent-purple/25"
        actions={
          <button onClick={() => setSchedModal('add')}
            className="flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30 transition-all">
            <Plus size={14} /> New Schedule
          </button>
        }
      />

      {/* Summary chips */}
      {!loading && (
        <div className="flex gap-3 mb-6">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg glass border border-white/8">
            <span className="status-dot-online" />
            <span className="text-xs font-body text-slate-300">{enabled.length} active</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg glass border border-white/8">
            <span className="w-2 h-2 rounded-full bg-slate-600" />
            <span className="text-xs font-body text-slate-400">{disabled.length} paused</span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="glass rounded-xl border border-white/8 p-4 animate-pulse h-20" />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-surface-3 border border-white/6 flex items-center justify-center mb-4">
            <Clock size={28} className="text-slate-600" />
          </div>
          <p className="text-slate-400 font-body font-medium">No schedules yet</p>
          <p className="text-sm text-slate-600 font-body mt-1">Automate boots and shutdowns to save energy</p>
          <button onClick={() => setSchedModal('add')}
            className="mt-4 flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30 transition-all">
            <Plus size={14} /> Create Schedule
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map(schedule => {
            const meta = ACTION_META[schedule.action] || ACTION_META.wake
            const ActionIcon = meta.icon
            const targetName = getTargetName(schedule)

            return (
              <div key={schedule.id}
                className={`glass rounded-xl border transition-all duration-200 p-4 ${
                  schedule.enabled
                    ? 'border-white/10 hover:border-white/15'
                    : 'border-white/5 opacity-60'
                }`}
              >
                <div className="flex items-center gap-4">
                  {/* Action icon */}
                  <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${meta.bg}`}>
                    <ActionIcon size={16} className={meta.color} />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-body font-medium text-slate-200">{schedule.name}</p>
                      {schedule.notes && (
                        <span className="text-xs text-slate-500 font-body">· {schedule.notes}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                      <span className={`text-xs font-body font-medium ${meta.color}`}>{meta.label}</span>
                      <span className="text-slate-600">·</span>
                      <span className="flex items-center gap-1 text-xs text-slate-400 font-body">
                        {schedule.target_type === 'device'
                          ? <Monitor size={11} className="text-slate-500" />
                          : <Layers size={11} className="text-slate-500" />
                        }
                        {targetName}
                      </span>
                      <span className="text-slate-600">·</span>
                      <CronBadge expr={schedule.cron_expression} />
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Enabled toggle */}
                    <button
                      onClick={() => toggleEnabled(schedule)}
                      title={schedule.enabled ? 'Pause schedule' : 'Enable schedule'}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-body font-medium border transition-all ${
                        schedule.enabled
                          ? 'bg-accent-green/10 border-accent-green/20 text-accent-green hover:bg-accent-green/20'
                          : 'bg-surface-3 border-white/8 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {schedule.enabled
                        ? <><Pause size={11} /> Active</>
                        : <><Play size={11} /> Paused</>
                      }
                    </button>

                    <button onClick={() => setSchedModal(schedule)}
                      className="p-1.5 rounded-lg hover:bg-surface-4 text-slate-500 hover:text-slate-300 transition-all">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => setDeleteTarget(schedule)}
                      className="p-1.5 rounded-lg hover:bg-accent-red/10 text-slate-500 hover:text-accent-red transition-all">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ScheduleModal
        open={!!schedModal}
        onClose={() => setSchedModal(null)}
        onSaved={fetchAll}
        schedule={schedModal !== 'add' ? schedModal : null}
        devices={devices}
        groups={groups}
      />

      <ActionConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={`Delete schedule "${deleteTarget?.name}"`}
        description="This schedule will be removed and will no longer run."
        danger
      />
    </div>
  )
}
