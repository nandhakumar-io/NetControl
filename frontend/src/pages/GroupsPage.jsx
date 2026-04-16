import React, { useState, useEffect, useCallback } from 'react'
import { Layers, Plus, Pencil, Trash2, Monitor, Zap, Power, RotateCcw, X, Loader2 } from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'
import { useThemeStore } from '../store/themeStore'

function GroupFormModal({ open, onClose, onSaved, group }) {
  const [name, setName]         = useState('')
  const [description, setDesc]  = useState('')
  const [loading, setLoading]   = useState(false)

  useEffect(() => {
    if (open) {
      setName(group?.name || '')
      setDesc(group?.description || '')
    }
  }, [open, group])

  const handleSubmit = async () => {
    if (!name.trim()) { toast.error('Name is required'); return }
    setLoading(true)
    try {
      if (group) {
        await api.put(`/groups/${group.id}`, { name, description })
        toast.success('Group updated')
      } else {
        await api.post('/groups', { name, description })
        toast.success('Group created')
      }
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    } finally { setLoading(false) }
  }

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="glass rounded-2xl border border-white/10 overflow-hidden">
          <div className="h-0.5 bg-accent-purple opacity-60" />
          <div className="flex items-center justify-between px-6 py-5 border-b border-white/6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-accent-purple/15 border border-accent-purple/25 flex items-center justify-center">
                <Layers size={16} className="text-accent-purple" />
              </div>
              <h3 className="font-display text-white">{group ? 'Edit Group' : 'New Lab / Group'}</h3>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1"><X size={16} /></button>
          </div>
          <div className="p-6 flex flex-col gap-4">
            <div>
              <label className="label">Group Name</label>
              <input className="input-field" placeholder="e.g. Computer Lab 1"
                value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label className="label">Description (optional)</label>
              <textarea rows={2} className="input-field resize-none"
                placeholder="Description or location..."
                value={description} onChange={e => setDesc(e.target.value)} />
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={onClose} className="btn-ghost flex-1 justify-center" disabled={loading}>Cancel</button>
              <button onClick={handleSubmit} disabled={loading}
                className="flex-1 justify-center flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30 transition-all">
                {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                {loading ? 'Saving...' : group ? 'Save Changes' : 'Create Group'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function GroupsPage() {
  const [groups, setGroups]   = useState([])
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [groupModal, setGroupModal]     = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [actionModal, setActionModal]   = useState(null)

  const isLight = useThemeStore(s => s.theme === 'light')

  const fetchAll = useCallback(async () => {
    try {
      const [g, d] = await Promise.all([api.get('/groups'), api.get('/devices')])
      setGroups(g.data)
      setDevices(d.data)
    } catch { toast.error('Failed to load') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleDelete = async () => {
    try {
      await api.delete(`/groups/${deleteTarget.id}`)
      toast.success('Group deleted')
      setDeleteTarget(null)
      fetchAll()
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed') }
  }

  const executeAction = async (pin) => {
    const { type, group } = actionModal
    await api.post(`/actions/${type}`, { groupId: group.id, actionPin: pin })
    toast.success(`${type} sent to ${group.name}`)
  }

  const getGroupDevices = (groupId) => devices.filter(d => d.group_id === groupId)

  return (
    <div className="p-6 max-w-[1400px] mx-auto animate-fade-in">
      <PageHeader
        icon={Layers}
        title="Labs & Groups"
        description="Organise machines into labs for bulk control"
        iconColor="text-accent-purple"
        iconBg="bg-accent-purple/15 border-accent-purple/25"
        actions={
          <button onClick={() => setGroupModal('add')}
            className="flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30 transition-all">
            <Plus size={14} /> New Group
          </button>
        }
      />

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`rounded-xl p-5 animate-pulse h-48 border
              ${isLight ? 'bg-white border-black/[0.07]' : 'glass border-white/8'}`} />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className={`w-16 h-16 rounded-2xl border flex items-center justify-center mb-4
            ${isLight ? 'bg-[#f5f5fa] border-black/[0.07]' : 'bg-surface-3 border-white/6'}`}>
            <Layers size={28} className={isLight ? 'text-slate-400' : 'text-slate-600'} />
          </div>
          <p className={`font-body font-medium ${isLight ? 'text-[#1a1a2e]' : 'text-slate-400'}`}>No groups yet</p>
          <p className={`text-sm font-body mt-1 ${isLight ? 'text-[#64748b]' : 'text-slate-600'}`}>
            Create a lab group to control multiple PCs at once
          </p>
          <button onClick={() => setGroupModal('add')}
            className="mt-4 flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg text-sm bg-accent-purple/20 hover:bg-accent-purple/30 text-accent-purple border border-accent-purple/30 transition-all">
            <Plus size={14} /> Create Group
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {groups.map(group => {
            const groupDevices = getGroupDevices(group.id)
            const online = groupDevices.filter(d => d.status === 'online').length
            const pct = groupDevices.length ? Math.round((online / groupDevices.length) * 100) : 0

            return (
              <div key={group.id} className={`rounded-xl overflow-hidden transition-all duration-200
                ${isLight
                  ? 'bg-white border border-black/[0.07] shadow-[0_1px_3px_rgba(0,0,0,0.07),_0_4px_16px_rgba(0,0,0,0.04)]'
                  : 'glass border border-white/8'
                }`}>

                {/* Progress bar */}
                <div className={`h-0.5 ${isLight ? 'bg-black/[0.06]' : 'bg-surface-4'}`}>
                  <div
                    className="h-full bg-accent-purple transition-all duration-700"
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <div className="p-5">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-accent-purple/15 border border-accent-purple/25 flex items-center justify-center">
                        <Layers size={18} className="text-accent-purple" />
                      </div>
                      <div>
                        <h3 className={`font-display text-sm ${isLight ? 'text-[#1a1a2e]' : 'text-white'}`}>
                          {group.name}
                        </h3>
                        {group.description && (
                          <p className={`text-xs font-body mt-0.5 max-w-[180px] truncate
                            ${isLight ? 'text-[#64748b]' : 'text-slate-500'}`}>
                            {group.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setGroupModal(group)}
                        className={`p-1.5 rounded-lg transition-all
                          ${isLight
                            ? 'text-slate-400 hover:text-[#6c5ce7] hover:bg-[#6c5ce7]/10'
                            : 'hover:bg-surface-4 text-slate-500 hover:text-slate-300'
                          }`}>
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(group)}
                        className={`p-1.5 rounded-lg transition-all
                          ${isLight
                            ? 'text-slate-400 hover:text-accent-red hover:bg-accent-red/10'
                            : 'hover:bg-accent-red/10 text-slate-500 hover:text-accent-red'
                          }`}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-3 gap-2 mb-4">
                    {/* Total */}
                    <div className={`text-center py-2 rounded-lg
                      ${isLight ? 'bg-[#f5f5fa] border border-black/[0.06]' : 'bg-surface-3 border border-white/6'}`}>
                      <p className={`text-lg font-display ${isLight ? 'text-[#1a1a2e]' : 'text-white'}`}>
                        {groupDevices.length}
                      </p>
                      <p className={`text-[10px] font-body ${isLight ? 'text-[#64748b]' : 'text-slate-500'}`}>Total</p>
                    </div>
                    {/* Online */}
                    <div className="text-center py-2 rounded-lg bg-accent-green/10 border border-accent-green/15">
                      <p className="text-lg font-display text-accent-green">{online}</p>
                      <p className="text-[10px] text-accent-green/70 font-body">Online</p>
                    </div>
                    {/* Offline */}
                    <div className={`text-center py-2 rounded-lg
                      ${isLight ? 'bg-[#f5f5fa] border border-black/[0.06]' : 'bg-surface-3 border border-white/6'}`}>
                      <p className={`text-lg font-display ${isLight ? 'text-[#374151]' : 'text-slate-400'}`}>
                        {groupDevices.length - online}
                      </p>
                      <p className={`text-[10px] font-body ${isLight ? 'text-[#64748b]' : 'text-slate-500'}`}>Offline</p>
                    </div>
                  </div>

                  {/* Device list preview */}
                  {groupDevices.length > 0 && (
                    <div className="mb-4 flex flex-wrap gap-1.5">
                      {groupDevices.slice(0, 6).map(d => (
                        <span key={d.id} className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono
                          ${isLight
                            ? 'bg-[#f0f0f8] border border-black/[0.07] text-[#374151]'
                            : 'bg-surface-3 border border-white/6 text-slate-400'
                          }`}>
                          <span className={`w-1.5 h-1.5 rounded-full
                            ${d.status === 'online' ? 'bg-accent-green' : isLight ? 'bg-slate-300' : 'bg-slate-600'}`} />
                          {d.name}
                        </span>
                      ))}
                      {groupDevices.length > 6 && (
                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-body
                          ${isLight
                            ? 'bg-[#f0f0f8] border border-black/[0.07] text-[#64748b]'
                            : 'bg-surface-3 border border-white/6 text-slate-500'
                          }`}>
                          +{groupDevices.length - 6} more
                        </span>
                      )}
                    </div>
                  )}

                  {/* Bulk action buttons */}
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => setActionModal({ type: 'wake', group })}
                      disabled={groupDevices.length === 0}
                      className="py-2 rounded-lg bg-accent-green/10 hover:bg-accent-green/20 border border-accent-green/20 hover:border-accent-green/40 text-accent-green transition-all flex items-center justify-center gap-1.5 text-xs font-body font-medium disabled:opacity-40"
                    >
                      <Zap size={13} /> Wake All
                    </button>
                    <button
                      onClick={() => setActionModal({ type: 'shutdown', group })}
                      disabled={groupDevices.length === 0}
                      className="py-2 rounded-lg bg-accent-red/10 hover:bg-accent-red/20 border border-accent-red/20 hover:border-accent-red/40 text-accent-red transition-all flex items-center justify-center gap-1.5 text-xs font-body font-medium disabled:opacity-40"
                    >
                      <Power size={13} /> Off All
                    </button>
                    <button
                      onClick={() => setActionModal({ type: 'restart', group })}
                      disabled={groupDevices.length === 0}
                      className="py-2 rounded-lg bg-accent-yellow/10 hover:bg-accent-yellow/20 border border-accent-yellow/20 hover:border-accent-yellow/40 text-accent-yellow transition-all flex items-center justify-center gap-1.5 text-xs font-body font-medium disabled:opacity-40"
                    >
                      <RotateCcw size={13} /> Restart
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Unassigned devices section */}
      {!loading && (() => {
        const unassigned = devices.filter(d => !d.group_id)
        if (!unassigned.length) return null
        return (
          <div className="mt-8">
            <div className="glow-line mb-5" />
            <h2 className={`font-display text-sm mb-3 flex items-center gap-2
              ${isLight ? 'text-[#374151]' : 'text-slate-400'}`}>
              <Monitor size={14} /> Unassigned Devices ({unassigned.length})
            </h2>
            <div className="flex flex-wrap gap-2">
              {unassigned.map(d => (
                <span key={d.id} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono
                  ${isLight
                    ? 'bg-white border border-black/[0.07] text-[#374151] shadow-sm'
                    : 'bg-surface-2 border border-white/6 text-slate-400'
                  }`}>
                  <span className={`w-1.5 h-1.5 rounded-full
                    ${d.status === 'online' ? 'bg-accent-green' : isLight ? 'bg-slate-300' : 'bg-slate-600'}`} />
                  {d.name}
                  <span className={isLight ? 'text-slate-300' : 'text-slate-600'}>·</span>
                  {d.ip_address}
                </span>
              ))}
            </div>
          </div>
        )
      })()}

      <GroupFormModal
        open={!!groupModal}
        onClose={() => setGroupModal(null)}
        onSaved={fetchAll}
        group={groupModal !== 'add' ? groupModal : null}
      />

      <ActionConfirmModal
        open={!!actionModal}
        onClose={() => setActionModal(null)}
        onConfirm={executeAction}
        title={actionModal ? `${actionModal.type.charAt(0).toUpperCase() + actionModal.type.slice(1)} — ${actionModal.group?.name}` : ''}
        description="This will affect all devices in the group."
        danger={actionModal?.type !== 'wake'}
      />

      <ActionConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={`Delete group "${deleteTarget?.name}"`}
        description="Devices in this group will become unassigned. Enter your action PIN."
        danger
      />
    </div>
  )
}
