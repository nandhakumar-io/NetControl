import React, { useState, useEffect } from 'react'
import { X, Layers, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import { useThemeStore } from '../../store/themeStore'

export default function AssignClusterModal({ open, onClose, selectedDevices = [], groups = [], onSaved }) {
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [selectedClusterId, setSelectedClusterId] = useState('')
  const [loading, setLoading] = useState(false)
  const isLight = useThemeStore(s => s.theme === 'light')

  useEffect(() => {
    if (open && selectedDevices.length > 0) {
      // Find common group if any
      const groupIds = [...new Set(selectedDevices.map(d => d.group_id).filter(Boolean))]
      if (groupIds.length === 1) {
        setSelectedGroupId(groupIds[0])
      } else if (groups.length > 0) {
        setSelectedGroupId(groups[0].id)
      } else {
        setSelectedGroupId('')
      }
      setSelectedClusterId('')
    }
  }, [open, selectedDevices, groups])

  if (!open) return null

  const activeGroup = groups.find(g => g.id === selectedGroupId)
  const availableClusters = activeGroup?.clusters || []

  const submit = async () => {
    setLoading(true)
    try {
      const deviceIds = selectedDevices.map(d => d.id)
      await api.post('/devices/assign-cluster', {
        deviceIds,
        clusterId: selectedClusterId || null,
      })
      toast.success(`Assigned ${deviceIds.length} device(s) to ${selectedClusterId ? (availableClusters.find(c => c.id === selectedClusterId)?.name || 'cluster') : 'unassigned'}`)
      onSaved?.()
      onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to assign cluster')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md rounded-2xl overflow-hidden animate-slide-up"
        style={{
          background: isLight ? '#fff' : 'var(--bg-surface-1)',
          border: '1px solid var(--border-mid)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
        }}
        onClick={e => e.stopPropagation()}>

        <div style={{ height: 3, background: 'linear-gradient(90deg, #a855f7, #38bdf8)' }} />

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)' }}>
              <Layers size={15} className="text-accent-purple" />
            </div>
            <div>
              <h3 className="font-display text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                Assign to Cluster / Batch
              </h3>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {selectedDevices.length} device{selectedDevices.length === 1 ? '' : 's'} selected
              </p>
            </div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-muted)' }} className="p-1 hover:text-accent-red">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          <div>
            <label className="label">Select Lab / Group</label>
            <select
              className="input-field"
              value={selectedGroupId}
              onChange={e => {
                setSelectedGroupId(e.target.value)
                setSelectedClusterId('')
              }}
            >
              <option value="">Select Group...</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Select Cluster / Batch</label>
            <select
              className="input-field"
              value={selectedClusterId}
              onChange={e => setSelectedClusterId(e.target.value)}
              disabled={!selectedGroupId}
            >
              <option value="">Clear Cluster (Unassigned)</option>
              {availableClusters.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {selectedGroupId && availableClusters.length === 0 && (
              <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
                No clusters / batches created in this group yet. You can create batches in the Labs & Groups page.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={onClose} className="btn-ghost flex-1 justify-center" disabled={loading}>
            Cancel
          </button>
          <button onClick={submit} disabled={loading}
            className="flex-1 justify-center flex items-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
            style={{ background: '#a855f7', color: '#fff' }}>
            {loading ? <Loader2 size={13} className="animate-spin" /> : null}
            {loading ? 'Assigning…' : 'Assign to Batch'}
          </button>
        </div>
      </div>
    </div>
  )
}
