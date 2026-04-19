import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Layers, Plus, Pencil, Trash2, Monitor, Zap, Power,
  RotateCcw, X, Loader2, ChevronDown, ChevronRight,
  Server, RefreshCw, Search, Users, Wifi, WifiOff
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'
import { useThemeStore } from '../store/themeStore'

// ── Group form modal ──────────────────────────────────────────────────────────
function GroupFormModal({ open, onClose, onSaved, group }) {
  const [name, setName]       = useState('')
  const [desc, setDesc]       = useState('')
  const [loading, setLoading] = useState(false)
  const isLight = useThemeStore(s => s.theme === 'light')

  useEffect(() => {
    if (open) { setName(group?.name || ''); setDesc(group?.description || '') }
  }, [open, group])

  const submit = async () => {
    if (!name.trim()) { toast.error('Name is required'); return }
    setLoading(true)
    try {
      if (group) await api.put(`/groups/${group.id}`, { name, description: desc })
      else       await api.post('/groups', { name, description: desc })
      toast.success(group ? 'Group updated' : 'Group created')
      onSaved(); onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    } finally { setLoading(false) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="rounded-2xl overflow-hidden"
          style={{ background: isLight ? '#fff' : 'var(--bg-surface-1)',
                   border: '1px solid var(--border-mid)',
                   boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>

          {/* Accent bar */}
          <div style={{ height: 2, background: 'linear-gradient(90deg, #a855f7, #818cf8)' }} />

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4"
            style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)' }}>
                <Layers size={15} className="text-accent-purple" />
              </div>
              <h3 className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>
                {group ? 'Edit Group' : 'New Lab / Group'}
              </h3>
            </div>
            <button onClick={onClose} style={{ color: 'var(--text-muted)' }} className="p-1">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="p-6 space-y-4">
            <div>
              <label className="label">Group Name</label>
              <input className="input-field" placeholder="e.g. Computer Lab 1"
                value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()} autoFocus />
            </div>
            <div>
              <label className="label">Description <span style={{ color: 'var(--text-faint)' }}>(optional)</span></label>
              <textarea rows={2} className="input-field resize-none"
                placeholder="Room number, purpose, or any notes…"
                value={desc} onChange={e => setDesc(e.target.value)} />
            </div>
          </div>

          {/* Footer */}
          <div className="flex gap-3 px-6 pb-6">
            <button onClick={onClose} className="btn-ghost flex-1 justify-center" disabled={loading}>Cancel</button>
            <button onClick={submit} disabled={loading}
              className="flex-1 justify-center flex items-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{ background: '#a855f7', color: '#fff' }}>
              {loading ? <Loader2 size={13} className="animate-spin" /> : null}
              {loading ? 'Saving…' : group ? 'Save Changes' : 'Create Group'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Device chip ───────────────────────────────────────────────────────────────
function DeviceChip({ device }) {
  const isOnline = device.status === 'online'
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono"
      style={{
        background: isOnline ? 'rgba(34,197,94,0.08)' : 'var(--bg-surface-3)',
        border: `1px solid ${isOnline ? 'rgba(34,197,94,0.2)' : 'var(--border-subtle)'}`,
        color: isOnline ? '#22c55e' : 'var(--text-muted)',
      }}>
      <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-accent-green' : 'bg-slate-600'}`} />
      {device.name}
    </span>
  )
}

// ── Group card ────────────────────────────────────────────────────────────────
function GroupCard({ group, devices, onEdit, onDelete, onAction, isLight }) {
  const [expanded, setExpanded] = useState(false)
  const online  = devices.filter(d => d.status === 'online').length
  const offline = devices.length - online
  const pct     = devices.length ? Math.round((online / devices.length) * 100) : 0

  const healthColor = pct === 100 ? '#22c55e' : pct >= 50 ? '#fbbf24' : pct > 0 ? '#fb923c' : '#64748b'

  return (
    <div className="rounded-2xl overflow-hidden transition-all duration-200"
      style={{
        background: 'var(--bg-surface-2)',
        border: `1px solid ${online > 0 ? 'rgba(34,197,94,0.15)' : 'var(--border-subtle)'}`,
        boxShadow: 'var(--shadow-card)',
      }}>

      {/* Health bar */}
      <div className="h-1" style={{ background: 'var(--border-subtle)' }}>
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: healthColor }} />
      </div>

      <div className="p-5">
        {/* Header row */}
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'rgba(168,85,247,0.12)', border: '1px solid rgba(168,85,247,0.25)' }}>
              <Layers size={18} className="text-accent-purple" />
            </div>
            <div className="min-w-0">
              <h3 className="font-display text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>
                {group.name}
              </h3>
              {group.description && (
                <p className="text-[11px] mt-0.5 truncate max-w-[200px]" style={{ color: 'var(--text-muted)' }}>
                  {group.description}
                </p>
              )}
            </div>
          </div>

          <div className="flex gap-1 shrink-0">
            <button onClick={() => onEdit(group)} title="Edit group"
              className="p-1.5 rounded-lg transition-all"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={e => { e.currentTarget.style.color = isLight ? '#6c5ce7' : '#818cf8'; e.currentTarget.style.background = isLight ? 'rgba(108,92,231,0.1)' : 'rgba(129,140,248,0.1)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}>
              <Pencil size={13} />
            </button>
            <button onClick={() => onDelete(group)} title="Delete group"
              className="p-1.5 rounded-lg transition-all"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.background = 'rgba(239,68,68,0.1)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}>
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {[
            { value: devices.length, label: 'Total',   color: 'var(--text-primary)',  bg: 'var(--bg-surface-3)',      border: 'var(--border-subtle)' },
            { value: online,         label: 'Online',  color: '#22c55e',              bg: 'rgba(34,197,94,0.08)',     border: 'rgba(34,197,94,0.2)'  },
            { value: offline,        label: 'Offline', color: 'var(--text-muted)',    bg: 'var(--bg-surface-3)',      border: 'var(--border-subtle)' },
          ].map(({ value, label, color, bg, border }) => (
            <div key={label} className="rounded-xl py-2.5 text-center"
              style={{ background: bg, border: `1px solid ${border}` }}>
              <p className="text-xl font-mono font-bold" style={{ color }}>{value}</p>
              <p className="text-[10px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: 'var(--text-faint)' }}>{label}</p>
            </div>
          ))}
        </div>

        {/* Device chips */}
        {devices.length > 0 && (
          <div className="mb-4">
            <div className="flex flex-wrap gap-1.5">
              {devices.slice(0, expanded ? undefined : 5).map(d => <DeviceChip key={d.id} device={d} />)}
              {!expanded && devices.length > 5 && (
                <button onClick={() => setExpanded(true)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold transition-all"
                  style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                  +{devices.length - 5} more <ChevronDown size={9} />
                </button>
              )}
              {expanded && devices.length > 5 && (
                <button onClick={() => setExpanded(false)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold transition-all"
                  style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                  Collapse <ChevronDown size={9} style={{ transform: 'rotate(180deg)' }} />
                </button>
              )}
            </div>
          </div>
        )}

        {devices.length === 0 && (
          <div className="mb-4 py-3 rounded-xl text-center"
            style={{ background: 'var(--bg-surface-3)', border: '1px dashed var(--border-subtle)' }}>
            <p className="text-xs" style={{ color: 'var(--text-faint)' }}>No devices in this group</p>
          </div>
        )}

        {/* Action buttons */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { type: 'wake',     label: 'Wake All',  icon: <Zap size={12} />,       color: '#22c55e', bg: 'rgba(34,197,94,0.08)',   border: 'rgba(34,197,94,0.2)',   hbg: 'rgba(34,197,94,0.18)'  },
            { type: 'shutdown', label: 'Shut Down', icon: <Power size={12} />,     color: '#f87171', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.2)',   hbg: 'rgba(239,68,68,0.18)'  },
            { type: 'restart',  label: 'Restart',   icon: <RotateCcw size={12} />, color: '#fbbf24', bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.2)',  hbg: 'rgba(251,191,36,0.18)' },
          ].map(({ type, label, icon, color, bg, border, hbg }) => (
            <button key={type}
              onClick={() => onAction({ type, group })}
              disabled={devices.length === 0}
              className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: bg, border: `1px solid ${border}`, color }}
              onMouseEnter={e => { if (devices.length > 0) e.currentTarget.style.background = hbg }}
              onMouseLeave={e => { e.currentTarget.style.background = bg }}>
              {icon} {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function GroupsPage() {
  const [groups,  setGroups]  = useState([])
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch]   = useState('')
  const [groupModal,    setGroupModal]    = useState(null)
  const [deleteTarget,  setDeleteTarget]  = useState(null)
  const [actionModal,   setActionModal]   = useState(null)
  const isLight = useThemeStore(s => s.theme === 'light')

  const fetchAll = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    else setRefreshing(true)
    try {
      const [g, d] = await Promise.all([api.get('/groups'), api.get('/devices')])
      setGroups(g.data)
      setDevices(d.data)
    } catch { toast.error('Failed to load') }
    finally { setLoading(false); setRefreshing(false) }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleDelete = async () => {
    try {
      await api.delete(`/groups/${deleteTarget.id}`)
      toast.success('Group deleted')
      setDeleteTarget(null)
      fetchAll(true)
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed') }
  }

  const executeAction = async (pin) => {
    const { type, group } = actionModal
    await api.post(`/actions/${type}`, { groupId: group.id, actionPin: pin })
    toast.success(`${type} sent to ${group.name}`)
  }

  const getGroupDevices = useCallback((id) => devices.filter(d => d.group_id === id), [devices])

  // Filtered groups
  const filteredGroups = useMemo(() => {
    if (!search) return groups
    const q = search.toLowerCase()
    return groups.filter(g =>
      g.name.toLowerCase().includes(q) ||
      (g.description||'').toLowerCase().includes(q) ||
      devices.some(d => d.group_id === g.id && d.name.toLowerCase().includes(q))
    )
  }, [groups, devices, search])

  // Summary stats
  const totalDevices  = devices.length
  const onlineDevices = devices.filter(d => d.status === 'online').length
  const unassigned    = devices.filter(d => !d.group_id)

  // Skeleton
  if (loading) return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="h-20 rounded-2xl animate-pulse mb-6" style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }} />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-64 rounded-2xl animate-pulse" style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }} />
        ))}
      </div>
    </div>
  )

  return (
    <div className="p-6 max-w-[1400px] mx-auto animate-fade-in">

      <PageHeader
        icon={Layers}
        title="Labs & Groups"
        description="Organise machines into labs for bulk control and monitoring"
        iconBg="bg-accent-purple/15 border border-accent-purple/25"
        iconColor="text-accent-purple"
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => fetchAll(true)} title="Refresh"
              className="p-2 rounded-xl transition-all"
              style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setGroupModal('add')}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all"
              style={{ background: '#a855f7', color: '#fff' }}
              onMouseEnter={e => e.currentTarget.style.background = '#9333ea'}
              onMouseLeave={e => e.currentTarget.style.background = '#a855f7'}>
              <Plus size={14} /> New Group
            </button>
          </div>
        }
      />

      {/* Summary bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Groups',          value: groups.length,   color: '#a855f7', bg: 'rgba(168,85,247,0.1)',  border: 'rgba(168,85,247,0.2)'  },
          { label: 'Total Devices',   value: totalDevices,    color: 'var(--text-primary)', bg: 'var(--bg-surface-2)', border: 'var(--border-subtle)' },
          { label: 'Online',          value: onlineDevices,   color: '#22c55e', bg: 'rgba(34,197,94,0.08)',  border: 'rgba(34,197,94,0.2)'   },
          { label: 'Unassigned',      value: unassigned.length, color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.2)'  },
        ].map(({ label, value, color, bg, border }) => (
          <div key={label} className="rounded-2xl p-4"
            style={{ background: bg, border: `1px solid ${border}` }}>
            <p className="text-2xl font-mono font-bold" style={{ color }}>{value}</p>
            <p className="text-xs font-semibold uppercase tracking-wider mt-1" style={{ color: 'var(--text-faint)' }}>{label}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      {groups.length > 0 && (
        <div className="relative max-w-sm mb-5">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-faint)' }} />
          <input className="input-field pl-8 h-9 text-xs" placeholder="Search groups or devices…"
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      )}

      {/* Empty state */}
      {groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: 'var(--bg-surface-2)', border: '1px dashed var(--border-mid)' }}>
            <Layers size={28} className="text-accent-purple opacity-60" />
          </div>
          <p className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>No groups yet</p>
          <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
            Create a lab group to control multiple machines at once
          </p>
          <button onClick={() => setGroupModal('add')}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold"
            style={{ background: '#a855f7', color: '#fff' }}>
            <Plus size={14} /> Create your first group
          </button>
        </div>

      ) : filteredGroups.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <Search size={22} style={{ color: 'var(--text-muted)', opacity: 0.4 }} className="mb-2" />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No groups match "{search}"</p>
          <button onClick={() => setSearch('')} className="text-xs mt-2" style={{ color: isLight ? '#6c5ce7' : '#818cf8' }}>Clear search</button>
        </div>

      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredGroups.map(group => (
            <GroupCard
              key={group.id}
              group={group}
              devices={getGroupDevices(group.id)}
              onEdit={setGroupModal}
              onDelete={setDeleteTarget}
              onAction={setActionModal}
              isLight={isLight}
            />
          ))}
        </div>
      )}

      {/* Unassigned devices */}
      {unassigned.length > 0 && (
        <div className="mt-8">
          <div className="h-px mb-5" style={{ background: 'var(--border-subtle)' }} />
          <div className="flex items-center gap-2 mb-3">
            <Monitor size={13} style={{ color: 'var(--text-faint)' }} />
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
              Unassigned Devices
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-surface-3)', color: 'var(--text-faint)' }}>
              {unassigned.length}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {unassigned.map(d => (
              <span key={d.id} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-mono"
                style={{
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                }}>
                <span className={`w-1.5 h-1.5 rounded-full ${d.status === 'online' ? 'bg-accent-green' : 'bg-slate-600'}`} />
                {d.name}
                <span style={{ color: 'var(--text-faint)' }}>·</span>
                <span style={{ color: 'var(--text-faint)' }}>{d.ip_address}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Modals */}
      <GroupFormModal
        open={!!groupModal}
        onClose={() => setGroupModal(null)}
        onSaved={() => fetchAll(true)}
        group={groupModal !== 'add' ? groupModal : null}
      />

      <ActionConfirmModal
        open={!!actionModal}
        onClose={() => setActionModal(null)}
        onConfirm={executeAction}
        title={actionModal ? `${actionModal.type.charAt(0).toUpperCase() + actionModal.type.slice(1)} — ${actionModal.group?.name}` : ''}
        description={`This will ${actionModal?.type} all devices in this group. Enter your action PIN.`}
        danger={actionModal?.type !== 'wake'}
      />

      <ActionConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={`Delete "${deleteTarget?.name}"`}
        description="Devices will become unassigned. This cannot be undone."
        danger
      />
    </div>
  )
}
