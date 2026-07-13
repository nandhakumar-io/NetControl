// pages/RunbooksPage.jsx — reusable auto-remediation scripts.
//
// Fully built server-side (routes/runbooks.js, services/runbookRunner.js)
// but had zero frontend — no page, no nav entry, and critically, no way to
// actually attach a runbook to an alert rule (alert_rules.runbook_action_ids
// was write-only from the API's perspective with nothing in the UI ever
// populating it). This page covers CRUD + manual test-run + run history;
// the alert-rule wiring itself lives in AlertsPage.jsx's rule editor.
import React, { useState, useEffect, useCallback } from 'react'
import {
  Wrench, Plus, X, Loader2, Trash2, Pencil, Play, Clock,
  Terminal, CheckCircle2, XCircle, History,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import { usePermissions } from '../hooks/usePermissions'

const OS_LABEL = { any: 'Any OS', linux: 'Linux', windows: 'Windows' }
const fmtDateTime = (sec) => sec ? new Date(sec * 1000).toLocaleString() : '—'

export default function RunbooksPage() {
  const { can, isAdmin } = usePermissions()
  const canManage = can(32768) || isAdmin

  const [runbooks, setRunbooks] = useState([])
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [testingId, setTestingId] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rb, dv] = await Promise.all([api.get('/runbooks'), api.get('/devices')])
      setRunbooks(rb.data)
      setDevices(dv.data)
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load runbooks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const remove = async (rb) => {
    if (!window.confirm(`Delete runbook "${rb.name}"? Any alert rules using it will stop running it.`)) return
    try {
      await api.delete(`/runbooks/${rb.id}`)
      toast.success('Runbook deleted')
      load()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Delete failed')
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <PageHeader
        icon={Wrench}
        title="Runbooks"
        description="Reusable auto-remediation scripts alert rules can trigger automatically"
        actions={canManage ? (
          <button onClick={() => { setEditing(null); setShowForm(true) }} className="btn-primary">
            <Plus size={14} /> New Runbook
          </button>
        ) : null}
      />

      <div className="card">
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="animate-spin text-brand-400" size={24} /></div>
        ) : runbooks.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8">
            No runbooks yet. Create one to let alert rules automatically fix common problems —
            e.g. "restart nginx", "clear ARP cache", "flush DNS".
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {runbooks.map(rb => (
              <div key={rb.id} className="rounded-xl border border-white/10 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                      <Terminal size={13} className="text-brand-400 shrink-0" /> {rb.name}
                      <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded-full bg-white/5 text-slate-400">
                        {OS_LABEL[rb.os_type]}
                      </span>
                    </p>
                    {rb.description && <p className="text-xs text-slate-500 mt-0.5">{rb.description}</p>}
                    <code className="text-xs text-slate-400 mt-1 block truncate font-mono">{rb.command}</code>
                    <p className="text-xs text-slate-600 mt-1 flex items-center gap-1">
                      <Clock size={10} /> {rb.timeout_sec}s timeout
                      {rb.created_by_name ? ` · created by ${rb.created_by_name}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setHistoryFor(rb)} title="Run history" className="text-slate-500 hover:text-brand-400 p-1.5">
                      <History size={14} />
                    </button>
                    {canManage && (
                      <>
                        <button onClick={() => setTestingId(rb.id)} title="Test run" className="text-slate-500 hover:text-brand-400 p-1.5">
                          <Play size={14} />
                        </button>
                        <button onClick={() => { setEditing(rb); setShowForm(true) }} title="Edit" className="text-slate-500 hover:text-brand-400 p-1.5">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => remove(rb)} title="Delete" className="text-slate-500 hover:text-accent-red p-1.5">
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
      </div>

      {showForm && (
        <RunbookForm
          runbook={editing}
          onCancel={() => { setShowForm(false); setEditing(null) }}
          onSaved={() => { setShowForm(false); setEditing(null); load() }}
        />
      )}
      {testingId && (
        <TestRunModal runbookId={testingId} devices={devices} onClose={() => setTestingId(null)} />
      )}
      {historyFor && (
        <HistoryModal runbook={historyFor} onClose={() => setHistoryFor(null)} />
      )}
    </div>
  )
}

function RunbookForm({ runbook, onCancel, onSaved }) {
  const [name, setName] = useState(runbook?.name || '')
  const [description, setDescription] = useState(runbook?.description || '')
  const [osType, setOsType] = useState(runbook?.os_type || 'any')
  const [command, setCommand] = useState(runbook?.command || '')
  const [timeoutSec, setTimeoutSec] = useState(runbook?.timeout_sec || 30)
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim()) { toast.error('Name is required'); return }
    if (!command.trim()) { toast.error('Command is required'); return }
    setSaving(true)
    const payload = { name: name.trim(), description: description.trim() || null, os_type: osType, command, timeout_sec: Number(timeoutSec) }
    try {
      if (runbook) await api.put(`/runbooks/${runbook.id}`, payload)
      else await api.post('/runbooks', payload)
      toast.success(runbook ? 'Runbook updated' : 'Runbook created')
      onSaved()
    } catch (e2) {
      toast.error(e2.response?.data?.error || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="glass w-full max-w-lg rounded-2xl border border-white/10 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 sticky top-0 bg-inherit">
          <h2 className="font-display text-white text-sm flex items-center gap-2">
            <Wrench size={16} className="text-brand-400" /> {runbook ? 'Edit Runbook' : 'New Runbook'}
          </h2>
          <button onClick={onCancel} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>
        <form onSubmit={submit} className="p-5 flex flex-col gap-4">
          <div>
            <label className="label">Name</label>
            <input className="input-field" value={name} onChange={e => setName(e.target.value)} placeholder="Restart nginx" autoFocus />
          </div>
          <div>
            <label className="label">Description (optional)</label>
            <input className="input-field" value={description} onChange={e => setDescription(e.target.value)} placeholder="Restarts the nginx service when it stops responding" />
          </div>
          <div>
            <label className="label">Applies to</label>
            <select className="input-field" value={osType} onChange={e => setOsType(e.target.value)}>
              <option value="any">Any OS</option>
              <option value="linux">Linux only</option>
              <option value="windows">Windows only</option>
            </select>
          </div>
          <div>
            <label className="label">Command</label>
            <textarea className="input-field font-mono text-sm" rows={4} value={command} onChange={e => setCommand(e.target.value)}
              placeholder={osType === 'windows' ? 'Restart-Service -Name nginx -Force' : 'sudo systemctl restart nginx'} />
            <p className="text-xs text-slate-500 mt-1">Runs on the target device via the same SSH/WinRM connection used for remote actions.</p>
          </div>
          <div>
            <label className="label">Timeout (seconds, max 300)</label>
            <input type="number" min={1} max={300} className="input-field" value={timeoutSec} onChange={e => setTimeoutSec(e.target.value)} />
          </div>
          <div className="flex gap-2 mt-1">
            <button type="button" onClick={onCancel} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center">
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {runbook ? 'Save Changes' : 'Create Runbook'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function TestRunModal({ runbookId, devices, onClose }) {
  const [deviceId, setDeviceId] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)

  const run = async () => {
    if (!deviceId) { toast.error('Pick a device'); return }
    setRunning(true)
    setResult(null)
    try {
      const { data } = await api.post(`/runbooks/${runbookId}/test`, { deviceId })
      setResult(data)
    } catch (e) {
      toast.error(e.response?.data?.error || 'Test run failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="glass w-full max-w-md rounded-2xl border border-white/10">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <h2 className="font-display text-white text-sm flex items-center gap-2">
            <Play size={16} className="text-brand-400" /> Test Runbook
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <div>
            <label className="label">Device</label>
            <select className="input-field" value={deviceId} onChange={e => setDeviceId(e.target.value)}>
              <option value="">Select a device…</option>
              {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <button onClick={run} disabled={running || !deviceId} className="btn-primary w-full justify-center">
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Run Now
          </button>
          {result && (
            <div className={`rounded-lg p-3 border text-xs font-mono whitespace-pre-wrap ${
              result.result === 'success' ? 'border-accent-green/30 bg-accent-green/5 text-accent-green' : 'border-accent-red/30 bg-accent-red/5 text-accent-red'
            }`}>
              <p className="flex items-center gap-1.5 font-sans font-semibold mb-1">
                {result.result === 'success' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {result.result === 'success' ? 'Succeeded' : 'Failed'}
              </p>
              {result.output}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function HistoryModal({ runbook, onClose }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get(`/runbooks/${runbook.id}/history`).then(({ data }) => setRows(data)).catch(() => {}).finally(() => setLoading(false))
  }, [runbook.id])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="glass w-full max-w-lg rounded-2xl border border-white/10 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 sticky top-0 bg-inherit">
          <h2 className="font-display text-white text-sm flex items-center gap-2">
            <History size={16} className="text-brand-400" /> History — {runbook.name}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>
        <div className="p-5">
          {loading ? (
            <div className="flex justify-center py-6"><Loader2 className="animate-spin text-brand-400" size={20} /></div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">No runs yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map(r => (
                <div key={r.id} className="flex items-start justify-between gap-2 py-2 border-b last:border-0" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="min-w-0">
                    <p className="text-sm flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
                      {r.result === 'success' ? <CheckCircle2 size={13} className="text-accent-green" /> : <XCircle size={13} className="text-accent-red" />}
                      {r.device_name}
                    </p>
                    <p className="text-xs text-slate-500">{fmtDateTime(r.ran_at)}{r.triggered_by ? ` · ${r.triggered_by}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}