// pages/BulkCommandSchedulesPage.jsx — CRUD console for saved, cron-driven
// bulk commands (bulk_command_schedules table). The backend for this
// (services/bulkCommandScheduler.js + routes/bulkCommandSchedules.js) was
// fully built and wired into poller.js's cron engine already; it just had
// no frontend. This is the list/create/edit/run-now/delete surface, styled
// to match SchedulesPage.jsx (the device power-schedule equivalent) and
// reusing BulkCommandPage's device picker conventions.
import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarClock, Plus, Pencil, Trash2, Play, Pause, PlayCircle,
  CheckCircle2, XCircle, AlertTriangle, Clock, Server, Loader2,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import BulkCommandScheduleModal from '../components/modals/BulkCommandScheduleModal'

function CronBadge({ expr }) {
  const readable = (() => {
    if (expr === '0 * * * *') return 'Every hour'
    if (expr === '0 2 * * *') return 'Daily 2:00 AM'
    if (expr === '0 8 * * 1-5') return 'Weekdays 8:00 AM'
    if (expr === '0 0 * * 0') return 'Sundays midnight'
    return expr
  })()
  return (
    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent-purple/10 border border-accent-purple/20">
      <Clock size={11} className="text-accent-purple" />
      <span className="text-xs font-mono text-accent-purple">{readable}</span>
    </span>
  )
}

const STATUS_META = {
  success: { icon: CheckCircle2, color: 'text-accent-green', label: 'Last run: success' },
  partial: { icon: AlertTriangle, color: 'text-accent-yellow', label: 'Last run: partial' },
  failure: { icon: XCircle, color: 'text-accent-red', label: 'Last run: failed' },
}

function fmtTime(unixSec) {
  if (!unixSec) return null
  return new Date(unixSec * 1000).toLocaleString()
}

export default function BulkCommandSchedulesPage() {
  const navigate = useNavigate()
  const [schedules, setSchedules] = useState([])
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalTarget, setModalTarget] = useState(null) // 'add' | schedule object | null
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [runningId, setRunningId] = useState(null)

  const fetchAll = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        api.get('/bulk-command-schedules'),
        api.get('/bulk-command/devices'),
      ])
      setSchedules(s.data)
      setDevices(d.data)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load schedules')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const toggleEnabled = async (schedule) => {
    try {
      await api.post(`/bulk-command-schedules/${schedule.id}/toggle`, { enabled: !schedule.enabled })
      toast.success(schedule.enabled ? 'Schedule paused' : 'Schedule enabled')
      fetchAll()
    } catch (err) { toast.error(err.response?.data?.error || 'Update failed') }
  }

  const runNow = async (schedule) => {
    setRunningId(schedule.id)
    try {
      await api.post(`/bulk-command-schedules/${schedule.id}/run-now`)
      toast.success(`Running "${schedule.name}" now — check Bulk Command for live output`)
      setTimeout(fetchAll, 2500) // give the run a moment to update last_run/last_status
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to start run')
    } finally {
      setRunningId(null)
    }
  }

  const handleDelete = async () => {
    try {
      await api.delete(`/bulk-command-schedules/${deleteTarget.id}`)
      toast.success('Schedule deleted')
      setDeleteTarget(null)
      fetchAll()
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed') }
  }

  const deviceName = (id) => devices.find(d => d.id === id)?.name || 'Unknown device'

  const enabled = schedules.filter(s => s.enabled)
  const disabled = schedules.filter(s => !s.enabled)

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto animate-fade-in">
      <PageHeader
        icon={CalendarClock}
        title="Command Schedules"
        description="Run saved bulk commands automatically on a cron schedule"
        iconColor="text-accent-purple"
        iconBg="bg-accent-purple/15 border-accent-purple/25"
        actions={
          <button onClick={() => setModalTarget('add')}
            className="flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30 transition-all">
            <Plus size={14} /> New Schedule
          </button>
        }
      />

      {!loading && schedules.length > 0 && (
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
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="glass rounded-xl border border-white/8 p-4 animate-pulse h-24" />
          ))}
        </div>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-accent-purple/15 border border-accent-purple/25 flex items-center justify-center mb-4">
            <CalendarClock size={28} className="text-accent-purple" />
          </div>
          <p className="text-slate-400 font-body font-medium">No command schedules yet</p>
          <p className="text-sm text-slate-600 font-body mt-1">Automate a saved command to run across your devices on a cron cadence</p>
          <button onClick={() => setModalTarget('add')}
            className="mt-4 flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30 transition-all">
            <Plus size={14} /> Create Schedule
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map(schedule => {
            const statusMeta = STATUS_META[schedule.lastStatus]
            const StatusIcon = statusMeta?.icon

            return (
              <div key={schedule.id}
                className={`glass rounded-xl border transition-all duration-200 p-4 ${
                  schedule.enabled ? 'border-white/10 hover:border-white/15' : 'border-white/5 opacity-60'
                }`}
              >
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 bg-accent-purple/10 border-accent-purple/20">
                    <CalendarClock size={16} className="text-accent-purple" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-body font-medium text-slate-200">{schedule.name}</p>
                    </div>
                    <p className="text-xs font-mono mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{schedule.command}</p>
                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      <span className="flex items-center gap-1 text-xs text-slate-400 font-body">
                        <Server size={11} className="text-slate-500" />
                        {schedule.deviceIds.length} device{schedule.deviceIds.length === 1 ? '' : 's'}
                      </span>
                      <span className="text-slate-600">·</span>
                      <CronBadge expr={schedule.cronExpr} />
                      {statusMeta && (
                        <>
                          <span className="text-slate-600">·</span>
                          <span className={`flex items-center gap-1 text-xs font-body ${statusMeta.color}`}>
                            <StatusIcon size={11} />
                            {statusMeta.label}{schedule.lastRun ? ` — ${fmtTime(schedule.lastRun)}` : ''}
                          </span>
                        </>
                      )}
                      {schedule.consecutiveFailures > 1 && (
                        <>
                          <span className="text-slate-600">·</span>
                          <span className="text-xs font-body text-accent-red">{schedule.consecutiveFailures} runs in a row failed</span>
                        </>
                      )}
                    </div>
                    {schedule.lastError && (
                      <p className="text-[11px] font-mono mt-1.5 text-accent-red/80 truncate">{schedule.lastError}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => runNow(schedule)}
                      disabled={runningId === schedule.id}
                      title="Run now"
                      className="p-1.5 rounded-lg hover:bg-accent-green/10 text-slate-500 hover:text-accent-green transition-all disabled:opacity-40"
                    >
                      {runningId === schedule.id ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
                    </button>

                    <button
                      onClick={() => toggleEnabled(schedule)}
                      title={schedule.enabled ? 'Pause schedule' : 'Enable schedule'}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-body font-medium border transition-all ${
                        schedule.enabled
                          ? 'bg-accent-green/10 border-accent-green/20 text-accent-green hover:bg-accent-green/20'
                          : 'bg-surface-3 border-white/8 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {schedule.enabled ? <><Pause size={11} /> Active</> : <><Play size={11} /> Paused</>}
                    </button>

                    <button onClick={() => setModalTarget(schedule)}
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

      <BulkCommandScheduleModal
        open={!!modalTarget}
        onClose={() => setModalTarget(null)}
        onSaved={fetchAll}
        schedule={modalTarget !== 'add' ? modalTarget : null}
        devices={devices}
      />

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setDeleteTarget(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-md animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'rgba(239,68,68,0.25)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
              <div className="h-0.5 opacity-70 bg-accent-red" />
              <div className="p-6">
                <h3 className="font-display text-base" style={{ color: 'var(--text-primary)' }}>Delete schedule "{deleteTarget.name}"?</h3>
                <p className="text-xs font-body mt-1.5" style={{ color: 'var(--text-muted)' }}>
                  This schedule will be removed and will no longer run.
                </p>
                <div className="flex gap-3 mt-5">
                  <button onClick={() => setDeleteTarget(null)} className="btn-ghost flex-1 justify-center">Cancel</button>
                  <button onClick={handleDelete}
                    className="flex-1 justify-center flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg transition-all duration-200 text-sm bg-accent-red/20 hover:bg-accent-red/30 text-accent-red border border-accent-red/30">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}