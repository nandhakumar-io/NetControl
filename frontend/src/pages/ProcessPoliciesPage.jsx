// pages/ProcessPoliciesPage.jsx — restricted-program policies + violation feed
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  ShieldBan, Plus, Trash2, X, AlertOctagon, Skull, Bell,
  Loader2, Monitor, Layers, Globe2, RefreshCw, Cpu,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'

const timeAgo = ts => {
  if (!ts) return '—'
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function ScopeBadge({ policy }) {
  if (policy.device_id) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(56,189,248,0.12)', color: '#38bdf8' }}>
      <Monitor size={10} /> {policy.device_name || 'device'}
    </span>
  )
  if (policy.group_id) return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
      <Layers size={10} /> {policy.group_name || 'group'}
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(148,163,184,0.12)', color: '#94a3b8' }}>
      <Globe2 size={10} /> global
    </span>
  )
}

function ActionBadge({ action }) {
  const kill = action === 'kill'
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded"
      style={{ background: kill ? 'rgba(239,68,68,0.12)' : 'rgba(234,179,8,0.12)', color: kill ? '#ef4444' : '#eab308' }}>
      {kill ? <Skull size={10} /> : <Bell size={10} />} {kill ? 'Kill' : 'Alert'}
    </span>
  )
}

// ── Create policy modal ────────────────────────────────────────────────────────
function PolicyModal({ devices, groups, onClose, onSaved }) {
  const [processName, setProcessName] = useState('')
  const [matchType, setMatchType]     = useState('contains')
  const [action, setAction]           = useState('alert')
  const [scope, setScope]             = useState('global') // global|device|group
  const [deviceId, setDeviceId]       = useState('')
  const [groupId, setGroupId]         = useState('')
  const [osType, setOsType]           = useState('')
  const [saving, setSaving]           = useState(false)

  const submit = async () => {
    if (!processName.trim()) { toast.error('Process name is required'); return }
    if (scope === 'device' && !deviceId) { toast.error('Choose a device'); return }
    if (scope === 'group' && !groupId) { toast.error('Choose a group'); return }
    setSaving(true)
    try {
      await api.post('/process-policies', {
        process_name: processName.trim(),
        match_type: matchType,
        action,
        device_id: scope === 'device' ? deviceId : null,
        group_id: scope === 'group' ? groupId : null,
        os_type: osType || null,
        enabled: true,
      })
      toast.success('Restriction added')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to add restriction')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="glass rounded-2xl w-full max-w-md p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-display font-bold" style={{ color: 'var(--text-primary)' }}>Restrict a Program</h2>
          <button onClick={onClose} className="icon-btn"><X size={14} /></button>
        </div>

        <div>
          <label className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>Process name</label>
          <input value={processName} onChange={e => setProcessName(e.target.value)}
            placeholder="e.g. steam.exe, discord, bittorrent"
            className="input-field mt-1 text-sm w-full" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>Match</label>
            <select value={matchType} onChange={e => setMatchType(e.target.value)} className="input-field mt-1 text-sm w-full">
              <option value="contains">Contains</option>
              <option value="exact">Exact name</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>Action</label>
            <select value={action} onChange={e => setAction(e.target.value)} className="input-field mt-1 text-sm w-full">
              <option value="alert">Alert only</option>
              <option value="kill">Kill + alert</option>
            </select>
          </div>
        </div>

        <div>
          <label className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>Applies to</label>
          <div className="flex gap-1.5 mt-1">
            {['global', 'group', 'device'].map(s => (
              <button key={s} onClick={() => setScope(s)}
                className={`flex-1 text-xs py-1.5 rounded-lg capitalize font-body transition-all ${scope === s ? 'bg-brand-500/15 text-brand-400 border border-brand-500/25' : 'btn-ghost'}`}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {scope === 'device' && (
          <select value={deviceId} onChange={e => setDeviceId(e.target.value)} className="input-field text-sm w-full">
            <option value="">Select a device…</option>
            {devices.map(d => <option key={d.id} value={d.id}>{d.name} ({d.ip_address})</option>)}
          </select>
        )}
        {scope === 'group' && (
          <select value={groupId} onChange={e => setGroupId(e.target.value)} className="input-field text-sm w-full">
            <option value="">Select a group…</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}

        <div>
          <label className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>OS (optional)</label>
          <select value={osType} onChange={e => setOsType(e.target.value)} className="input-field mt-1 text-sm w-full">
            <option value="">Any</option>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
          </select>
        </div>

        {action === 'kill' && (
          <p className="text-[11px] font-body px-3 py-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}>
            The agent will forcibly terminate any matching process immediately upon detection, in addition to alerting admins.
          </p>
        )}

        <button onClick={submit} disabled={saving}
          className="w-full py-2 rounded-lg text-sm font-body font-semibold text-white transition-all"
          style={{ background: '#7c3aed', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Add restriction'}
        </button>
      </div>
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────────
export default function ProcessPoliciesPage() {
  const [policies, setPolicies]     = useState([])
  const [violations, setViolations] = useState([])
  const [devices, setDevices]       = useState([])
  const [groups, setGroups]         = useState([])
  const [loading, setLoading]       = useState(true)
  const [showModal, setShowModal]   = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true)
    try {
      const [p, v, d, g] = await Promise.all([
        api.get('/process-policies'),
        api.get('/process-policies/violations'),
        api.get('/devices'),
        api.get('/groups'),
      ])
      setPolicies(p.data || [])
      setViolations(v.data || [])
      setDevices(d.data || [])
      setGroups(g.data || [])
    } catch (e) {
      if (!quiet) toast.error('Failed to load process restrictions')
    } finally { setLoading(false); setRefreshing(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(() => load(true), 15000)
    return () => clearInterval(t)
  }, [load])

  const removePolicy = async (id) => {
    if (!confirm('Remove this restriction?')) return
    try {
      await api.delete(`/process-policies/${id}`)
      toast.success('Restriction removed')
      load(true)
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to remove') }
  }

  const killCount = useMemo(() => violations.filter(v => v.action_taken === 'kill').length, [violations])

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <Loader2 size={22} className="animate-spin" style={{ color: '#a78bfa' }} />
    </div>
  )

  return (
    <div className="p-5 space-y-5 animate-fade-in max-w-[1400px] mx-auto pb-10">
      <PageHeader
        icon={ShieldBan}
        title="Process Restrictions"
        description="Block or flag specific programs running on your agents"
        actions={
          <>
            <button onClick={() => load()} disabled={refreshing} className="icon-btn">
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setShowModal(true)}
              className="flex items-center gap-1.5 text-xs font-body font-semibold px-3 py-2 rounded-lg text-white"
              style={{ background: '#7c3aed' }}>
              <Plus size={13} /> Add Restriction
            </button>
          </>
        }
      />

      {/* Policies table */}
      <div className="glass rounded-2xl overflow-hidden">
        <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <ShieldBan size={13} style={{ color: '#a78bfa' }} />
          <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-primary)' }}>Active Restrictions</span>
          <span className="ml-auto text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>{policies.length} rule{policies.length !== 1 ? 's' : ''}</span>
        </div>

        {policies.length === 0 ? (
          <div className="p-10 flex flex-col items-center gap-2 opacity-50">
            <ShieldBan size={20} style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>No restrictions configured yet</p>
          </div>
        ) : (
          <div>
            {policies.map(p => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-2.5"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <span className="text-xs font-mono font-semibold flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{p.process_name}</span>
                <span className="text-[10px] font-mono uppercase" style={{ color: 'var(--text-faint)' }}>{p.match_type}</span>
                <ActionBadge action={p.action} />
                <ScopeBadge policy={p} />
                {p.os_type && <span className="text-[10px] font-mono uppercase" style={{ color: 'var(--text-faint)' }}>{p.os_type}</span>}
                <button onClick={() => removePolicy(p.id)} className="icon-btn text-red-400/70 hover:text-red-400">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Violations feed */}
      <div className="glass rounded-2xl overflow-hidden">
        <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <AlertOctagon size={13} style={{ color: '#f97316' }} />
          <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-primary)' }}>Recent Detections</span>
          <span className="ml-auto text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>
            {violations.length} total · {killCount} blocked
          </span>
        </div>

        {violations.length === 0 ? (
          <div className="p-10 flex flex-col items-center gap-2 opacity-50">
            <Cpu size={20} style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>No restricted programs detected yet</p>
          </div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            {violations.map(v => (
              <div key={v.id} className="flex items-center gap-3 px-4 py-2.5"
                style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <ActionBadge action={v.action_taken} />
                <span className="text-xs font-mono font-semibold flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{v.process_name}</span>
                {v.pid && <span className="text-[10px] font-mono" style={{ color: 'var(--text-faint)' }}>PID {v.pid}</span>}
                <span className="text-[11px] font-mono truncate max-w-[160px]" style={{ color: 'var(--text-secondary)' }}>{v.device_name}</span>
                {v.kill_result && v.kill_result !== 'not_attempted' && (
                  <span className="text-[10px] font-mono uppercase" style={{ color: v.kill_result === 'killed' ? '#22c55e' : '#ef4444' }}>{v.kill_result}</span>
                )}
                <span className="text-[10px] font-mono w-16 text-right shrink-0" style={{ color: 'var(--text-faint)' }}>{timeAgo(v.detected_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <PolicyModal devices={devices} groups={groups} onClose={() => setShowModal(false)} onSaved={() => load(true)} />
      )}
    </div>
  )
}