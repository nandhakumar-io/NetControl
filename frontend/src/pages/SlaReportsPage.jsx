// pages/SlaReportsPage.jsx — Uptime/SLA PDF reports.
//
// Talks to:
//   GET  /api/sla-reports/preview     — compute uptime data without saving a PDF
//   POST /api/sla-reports/generate    — render + store a PDF
//   GET  /api/sla-reports             — list previously generated reports
//   GET  /api/sla-reports/:id/download
//   DELETE /api/sla-reports/:id       — admin only
//   GET/POST/PUT/PATCH/DELETE /api/sla-report-schedules — automatic monthly generation
import React, { useState, useEffect, useCallback } from 'react'
import {
  FileBarChart2, Download, Trash2, RefreshCw, Loader2, Calendar,
  Clock, Plus, X, Play, PauseCircle, PlayCircle, Pencil, Mail,
  TrendingUp, Server, ShieldCheck, ShieldAlert,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'
import { usePermissions } from '../hooks/usePermissions'

const nowSec = () => Math.floor(Date.now() / 1000)
const fmtDate = (sec) => sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '—'
const fmtDateTime = (sec) => sec ? new Date(sec * 1000).toLocaleString() : '—'

const PRESETS = [
  { key: 'last_30d',   label: 'Last 30 days',   span: 30 * 86400 },
  { key: 'last_90d',   label: 'Last 90 days',   span: 90 * 86400 },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'custom',     label: 'Custom range' },
]

function computeRange(presetKey, customFrom, customTo) {
  const now = new Date()
  if (presetKey === 'this_month') {
    const from = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000)
    return { from, to: nowSec() }
  }
  if (presetKey === 'last_month') {
    const from = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) / 1000)
    const to = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000)
    return { from, to }
  }
  if (presetKey === 'custom') {
    const from = customFrom ? Math.floor(new Date(customFrom).getTime() / 1000) : null
    const to = customTo ? Math.floor(new Date(customTo).getTime() / 1000) : null
    return { from, to }
  }
  const preset = PRESETS.find(p => p.key === presetKey)
  return { from: nowSec() - (preset?.span || 30 * 86400), to: nowSec() }
}

function slaBand(pct) {
  if (pct === null || pct === undefined) return { label: 'No data', color: 'text-slate-400' }
  if (pct >= 99.9) return { label: 'Excellent', color: 'text-accent-green' }
  if (pct >= 99.0) return { label: 'Good', color: 'text-brand-400' }
  if (pct >= 95.0) return { label: 'At risk', color: 'text-accent-amber' }
  return { label: 'Breach', color: 'text-accent-red' }
}

const CRON_PRESETS = [
  ['0 6 1 * *', '1st of month, 06:00'],
  ['0 0 1 * *', '1st of month, midnight'],
  ['0 6 1 1,4,7,10 *', 'Quarterly (1st of Jan/Apr/Jul/Oct)'],
]

export default function SlaReportsPage() {
  const { can, isAdmin } = usePermissions()
  const canView = can(16384) || isAdmin

  const [devices, setDevices] = useState([])
  const [groups, setGroups] = useState([])
  const [scope, setScope] = useState('org')
  const [scopeId, setScopeId] = useState('')
  const [presetKey, setPresetKey] = useState('last_30d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  const [preview, setPreview] = useState(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [generating, setGenerating] = useState(false)

  const [reports, setReports] = useState([])
  const [loadingReports, setLoadingReports] = useState(true)

  const [schedules, setSchedules] = useState([])
  const [showScheduleModal, setShowScheduleModal] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(null)

  const loadReports = useCallback(async () => {
    setLoadingReports(true)
    try {
      const { data } = await api.get('/sla-reports')
      setReports(data)
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load reports')
    } finally {
      setLoadingReports(false)
    }
  }, [])

  const loadSchedules = useCallback(async () => {
    try {
      const { data } = await api.get('/sla-report-schedules')
      setSchedules(data)
    } catch { /* non-fatal — schedules panel just stays empty */ }
  }, [])

  useEffect(() => {
    if (!canView) return
    Promise.all([api.get('/devices'), api.get('/groups')])
      .then(([d, g]) => { setDevices(d.data); setGroups(g.data) })
      .catch(() => {})
    loadReports()
    loadSchedules()
  }, [canView, loadReports, loadSchedules])

  const runPreview = useCallback(async () => {
    const { from, to } = computeRange(presetKey, customFrom, customTo)
    if (!from || !to || to <= from) { toast.error('Pick a valid date range'); return }
    if (scope !== 'org' && !scopeId) { toast.error(`Pick a ${scope} first`); return }

    setLoadingPreview(true)
    try {
      const { data } = await api.get('/sla-reports/preview', {
        params: { scope, scopeId: scope === 'org' ? undefined : scopeId, from, to },
      })
      setPreview(data)
    } catch (e) {
      toast.error(e.response?.data?.error || 'Preview failed')
      setPreview(null)
    } finally {
      setLoadingPreview(false)
    }
  }, [scope, scopeId, presetKey, customFrom, customTo])

  useEffect(() => { if (canView) runPreview() }, [canView]) // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    const { from, to } = computeRange(presetKey, customFrom, customTo)
    if (!from || !to || to <= from) { toast.error('Pick a valid date range'); return }
    if (scope !== 'org' && !scopeId) { toast.error(`Pick a ${scope} first`); return }

    setGenerating(true)
    try {
      await api.post('/sla-reports/generate', {
        scope, scopeId: scope === 'org' ? null : scopeId, periodStart: from, periodEnd: to,
      })
      toast.success('SLA report generated')
      loadReports()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to generate report')
    } finally {
      setGenerating(false)
    }
  }

  const download = async (report) => {
    const toastId = toast.loading(`Preparing ${report.file_name}…`)
    try {
      const res = await api.get(`/sla-reports/${report.id}/download`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = report.file_name
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      toast.success(`Downloaded ${report.file_name}`, { id: toastId })
    } catch (e) {
      toast.error(e.response?.data?.error || 'Download failed', { id: toastId })
    }
  }

  const deleteReport = async (report) => {
    if (!window.confirm(`Delete report for ${report.scope_name}? This cannot be undone.`)) return
    try {
      await api.delete(`/sla-reports/${report.id}`)
      toast.success('Report deleted')
      loadReports()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Delete failed')
    }
  }

  const toggleSchedule = async (s) => {
    try {
      await api.patch(`/sla-report-schedules/${s.id}/toggle`)
      loadSchedules()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to toggle schedule') }
  }

  const runScheduleNow = async (s) => {
    try {
      toast.loading('Running schedule…', { id: 'sla-run' })
      const { data } = await api.post(`/sla-report-schedules/${s.id}/run-now`)
      toast.dismiss('sla-run')
      if (data.ok) { toast.success('Report generated'); loadReports(); loadSchedules() }
      else toast.error(data.last_error || 'Run failed')
    } catch (e) {
      toast.dismiss('sla-run')
      toast.error(e.response?.data?.error || 'Run failed')
    }
  }

  const deleteSchedule = async (s) => {
    if (!window.confirm(`Delete schedule "${s.name}"?`)) return
    try {
      await api.delete(`/sla-report-schedules/${s.id}`)
      toast.success('Schedule deleted')
      loadSchedules()
    } catch (e) { toast.error(e.response?.data?.error || 'Delete failed') }
  }

  if (!canView) {
    return (
      <div className="p-6">
        <PageHeader icon={FileBarChart2} title="SLA Reports" description="You don't have permission to view this page." />
      </div>
    )
  }

  const band = slaBand(preview?.avgUptimePct)

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <PageHeader
        icon={FileBarChart2}
        title="SLA Reports"
        description="Uptime reporting for clients and internal review"
        actions={
          <button onClick={() => { setEditingSchedule(null); setShowScheduleModal(true) }} className="btn-secondary">
            <Clock size={14} /> Schedules ({schedules.length})
          </button>
        }
      />

      {/* ── Scope + period controls ── */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="label">Scope</label>
            <select className="input-field" value={scope} onChange={e => { setScope(e.target.value); setScopeId('') }}>
              <option value="org">All devices</option>
              <option value="group">Group</option>
              <option value="device">Device</option>
            </select>
          </div>
          {scope !== 'org' && (
            <div>
              <label className="label">{scope === 'group' ? 'Group' : 'Device'}</label>
              <select className="input-field" value={scopeId} onChange={e => setScopeId(e.target.value)}>
                <option value="">Select…</option>
                {(scope === 'group' ? groups : devices).map(item => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label">Period</label>
            <select className="input-field" value={presetKey} onChange={e => setPresetKey(e.target.value)}>
              {PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
        </div>

        {presetKey === 'custom' && (
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="label">From</label>
              <input type="date" className="input-field" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
            </div>
            <div>
              <label className="label">To</label>
              <input type="date" className="input-field" value={customTo} onChange={e => setCustomTo(e.target.value)} />
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={runPreview} disabled={loadingPreview} className="btn-secondary">
            {loadingPreview ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Preview
          </button>
          <button onClick={generate} disabled={generating || !preview} className="btn-primary">
            {generating ? <Loader2 size={14} className="animate-spin" /> : <FileBarChart2 size={14} />}
            Generate PDF Report
          </button>
        </div>
      </div>

      {/* ── Preview summary ── */}
      {preview && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <StatCard icon={Server} label="Devices covered" value={preview.deviceCount}
            iconBg="bg-brand-500/15 border-brand-500/25" iconColor="text-brand-400" />
          <StatCard icon={TrendingUp} label="Average uptime"
            value={preview.avgUptimePct !== null ? `${preview.avgUptimePct.toFixed(3)}%` : 'n/a'}
            sub={band.label} accent={band.color}
            iconBg="bg-brand-500/15 border-brand-500/25" iconColor="text-brand-400" />
          <StatCard icon={Calendar} label="Period"
            value={`${fmtDate(preview.periodStart)} → ${fmtDate(preview.periodEnd)}`}
            iconBg="bg-brand-500/15 border-brand-500/25" iconColor="text-brand-400" />
        </div>
      )}

      {preview && preview.devices?.length > 0 && (
        <div className="card mb-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-2">Device</th>
                <th className="pb-2">Uptime %</th>
                <th className="pb-2">Incidents</th>
                <th className="pb-2">SLA</th>
              </tr>
            </thead>
            <tbody>
              {preview.devices.map(d => {
                const b = slaBand(d.uptimePct)
                return (
                  <tr key={d.deviceId} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="py-2">{d.name}</td>
                    <td className="py-2">{d.uptimePct !== null ? `${d.uptimePct.toFixed(3)}%` : 'n/a'}</td>
                    <td className="py-2">{d.incidents}</td>
                    <td className={`py-2 font-semibold ${b.color}`}>{b.label}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Generated reports history ── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>Generated Reports</h3>
          <button onClick={loadReports} className="text-xs text-slate-500 hover:text-slate-300">
            <RefreshCw size={12} className={loadingReports ? 'animate-spin' : ''} />
          </button>
        </div>
        {reports.length === 0 ? (
          <p className="text-sm text-slate-500 py-6 text-center">No reports generated yet.</p>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {reports.map(r => (
              <div key={r.id} className="flex items-center justify-between py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{r.scope_name}</p>
                  <p className="text-xs text-slate-500">
                    {fmtDate(r.period_start)} → {fmtDate(r.period_end)} · {r.device_count} device(s) ·
                    {' '}{r.avg_uptime_pct !== null ? `${Number(r.avg_uptime_pct).toFixed(3)}%` : 'n/a'} avg uptime ·
                    {' '}generated {fmtDateTime(r.created_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => download(r)} className="btn-secondary text-xs px-3 py-1.5">
                    <Download size={12} /> Download
                  </button>
                  {isAdmin && (
                    <button onClick={() => deleteReport(r)} className="text-slate-500 hover:text-accent-red p-1.5">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showScheduleModal && (
        <ScheduleListModal
          schedules={schedules}
          devices={devices}
          groups={groups}
          isAdmin={isAdmin}
          onClose={() => setShowScheduleModal(false)}
          onToggle={toggleSchedule}
          onRunNow={runScheduleNow}
          onDelete={deleteSchedule}
          onEdit={(s) => { setEditingSchedule(s); }}
          onCreated={() => { loadSchedules(); }}
          editingSchedule={editingSchedule}
          setEditingSchedule={setEditingSchedule}
        />
      )}
    </div>
  )
}

// ── Schedule management modal (list + inline create/edit form) ──────────────
function ScheduleListModal({
  schedules, devices, groups, isAdmin, onClose, onToggle, onRunNow, onDelete,
  editingSchedule, setEditingSchedule, onCreated,
}) {
  const [showForm, setShowForm] = useState(false)
  const editing = editingSchedule

  useEffect(() => { if (editingSchedule) setShowForm(true) }, [editingSchedule])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="glass w-full max-w-2xl rounded-2xl border border-white/10 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 sticky top-0 bg-inherit">
          <h2 className="font-display text-white text-sm flex items-center gap-2">
            <Clock size={16} className="text-brand-400" /> Automatic Monthly SLA Reports
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>

        <div className="p-5">
          {!showForm ? (
            <>
              {isAdmin && (
                <button onClick={() => { setEditingSchedule(null); setShowForm(true) }} className="btn-primary w-full justify-center mb-4">
                  <Plus size={14} /> New Schedule
                </button>
              )}
              {schedules.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-6">
                  No schedules yet. Reports are currently on-demand only — add a schedule to have them generate automatically.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {schedules.map(s => (
                    <div key={s.id} className="rounded-xl border border-white/10 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white truncate">{s.name}</p>
                          <p className="text-xs text-slate-500">
                            {CRON_PRESETS.find(([c]) => c === s.cron_expr)?.[1] || s.cron_expr} ·
                            {' '}{s.scope_type === 'org' ? 'All devices' : s.scope_type}
                            {s.period_mode === 'trailing_days' ? ` · trailing ${s.period_days}d` : ' · previous calendar month'}
                            {s.email_recipients ? ' · emails on completion' : ''}
                          </p>
                          {s.last_run && (
                            <p className={`text-xs mt-1 ${s.last_status === 'failure' ? 'text-accent-red' : 'text-slate-500'}`}>
                              Last run: {fmtDateTime(s.last_run)} — {s.last_status}
                              {s.last_status === 'failure' && s.last_error ? `: ${s.last_error}` : ''}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => onRunNow(s)} title="Run now" className="text-slate-500 hover:text-brand-400 p-1.5">
                            <Play size={14} />
                          </button>
                          {isAdmin && (
                            <>
                              <button onClick={() => onToggle(s)} title={s.enabled ? 'Disable' : 'Enable'} className="text-slate-500 hover:text-brand-400 p-1.5">
                                {s.enabled ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
                              </button>
                              <button onClick={() => setEditingSchedule(s)} title="Edit" className="text-slate-500 hover:text-brand-400 p-1.5">
                                <Pencil size={14} />
                              </button>
                              <button onClick={() => onDelete(s)} title="Delete" className="text-slate-500 hover:text-accent-red p-1.5">
                                <Trash2 size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <ScheduleForm
              schedule={editing}
              devices={devices}
              groups={groups}
              onCancel={() => { setShowForm(false); setEditingSchedule(null) }}
              onSaved={() => { setShowForm(false); setEditingSchedule(null); onCreated() }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ScheduleForm({ schedule, devices, groups, onCancel, onSaved }) {
  const [name, setName] = useState(schedule?.name || '')
  const [cronExpr, setCronExpr] = useState(schedule?.cron_expr || CRON_PRESETS[0][0])
  const [scope, setScope] = useState(schedule?.scope_type || 'org')
  const [scopeId, setScopeId] = useState(schedule?.scope_id || '')
  const [periodMode, setPeriodMode] = useState(schedule?.period_mode || 'previous_calendar_month')
  const [periodDays, setPeriodDays] = useState(schedule?.period_days || 30)
  const [emailRecipients, setEmailRecipients] = useState(schedule?.email_recipients || '')
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim()) { toast.error('Name is required'); return }
    if (scope !== 'org' && !scopeId) { toast.error(`Pick a ${scope}`); return }

    setSaving(true)
    const payload = {
      name: name.trim(), cronExpr, scope, scopeId: scope === 'org' ? null : scopeId,
      periodMode, periodDays: periodMode === 'trailing_days' ? Number(periodDays) : undefined,
      emailRecipients: emailRecipients.trim() || null, enabled: schedule ? schedule.enabled : true,
    }
    try {
      if (schedule) await api.put(`/sla-report-schedules/${schedule.id}`, payload)
      else await api.post('/sla-report-schedules', payload)
      toast.success(schedule ? 'Schedule updated' : 'Schedule created')
      onSaved()
    } catch (e2) {
      toast.error(e2.response?.data?.error || e2.response?.data?.errors?.[0]?.msg || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label className="label">Name</label>
        <input className="input-field" value={name} onChange={e => setName(e.target.value)} placeholder="Monthly client report" autoFocus />
      </div>

      <div>
        <label className="label">Run schedule</label>
        <select className="input-field" value={cronExpr} onChange={e => setCronExpr(e.target.value)}>
          {CRON_PRESETS.map(([c, label]) => <option key={c} value={c}>{label}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Scope</label>
          <select className="input-field" value={scope} onChange={e => { setScope(e.target.value); setScopeId('') }}>
            <option value="org">All devices</option>
            <option value="group">Group</option>
            <option value="device">Device</option>
          </select>
        </div>
        {scope !== 'org' && (
          <div>
            <label className="label">{scope === 'group' ? 'Group' : 'Device'}</label>
            <select className="input-field" value={scopeId} onChange={e => setScopeId(e.target.value)}>
              <option value="">Select…</option>
              {(scope === 'group' ? groups : devices).map(item => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Report period</label>
          <select className="input-field" value={periodMode} onChange={e => setPeriodMode(e.target.value)}>
            <option value="previous_calendar_month">Previous calendar month</option>
            <option value="trailing_days">Trailing N days</option>
          </select>
        </div>
        {periodMode === 'trailing_days' && (
          <div>
            <label className="label">Days</label>
            <input type="number" min={1} max={366} className="input-field" value={periodDays} onChange={e => setPeriodDays(e.target.value)} />
          </div>
        )}
      </div>

      <div>
        <label className="label flex items-center gap-1"><Mail size={12} /> Email recipients (optional)</label>
        <input className="input-field" value={emailRecipients} onChange={e => setEmailRecipients(e.target.value)}
          placeholder="client@example.com, ops@example.com" />
        <p className="text-xs text-slate-500 mt-1">Leave blank to only store the report — no email sent.</p>
      </div>

      <div className="flex gap-2 mt-1">
        <button type="button" onClick={onCancel} className="btn-secondary flex-1 justify-center">Cancel</button>
        <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center">
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          {schedule ? 'Save Changes' : 'Create Schedule'}
        </button>
      </div>
    </form>
  )
}