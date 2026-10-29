import React, { useState, useEffect } from 'react'
import { X, Layers, Check, Loader2, CheckSquare, Square } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import { useThemeStore } from '../../store/themeStore'

const COLOR_PRESETS = [
  { name: 'Purple', hex: '#a855f7' },
  { name: 'Sky', hex: '#38bdf8' },
  { name: 'Emerald', hex: '#22c55e' },
  { name: 'Amber', hex: '#fbbf24' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Cyan', hex: '#06b6d4' },
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Orange', hex: '#f97316' },
]

export default function ClusterModal({ open, onClose, group, cluster, groupDevices = [], onSaved }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#a855f7')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [loading, setLoading] = useState(false)
  const isLight = useThemeStore(s => s.theme === 'light')

  useEffect(() => {
    if (open) {
      setName(cluster?.name || '')
      setDescription(cluster?.description || '')
      setColor(cluster?.color || '#a855f7')
      if (cluster) {
        const preselected = groupDevices.filter(d => d.cluster_id === cluster.id).map(d => d.id)
        setSelectedIds(new Set(preselected))
      } else {
        setSelectedIds(new Set())
      }
    }
  }, [open, cluster, groupDevices])

  if (!open || !group) return null

  const toggleDevice = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    setSelectedIds(new Set(groupDevices.map(d => d.id)))
  }

  const selectNone = () => {
    setSelectedIds(new Set())
  }

  const selectUnassigned = () => {
    const unassigned = groupDevices.filter(d => !d.cluster_id || d.cluster_id === cluster?.id).map(d => d.id)
    setSelectedIds(new Set(unassigned))
  }

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Cluster / Batch name is required')
      return
    }
    setLoading(true)
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        color,
        deviceIds: Array.from(selectedIds),
      }
      if (cluster) {
        await api.put(`/groups/${group.id}/clusters/${cluster.id}`, payload)
        toast.success(`Cluster "${payload.name}" updated`)
      } else {
        await api.post(`/groups/${group.id}/clusters`, payload)
        toast.success(`Cluster "${payload.name}" created`)
      }
      onSaved?.()
      onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save cluster')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg rounded-2xl overflow-hidden animate-slide-up"
        style={{
          background: isLight ? '#fff' : 'var(--bg-surface-1)',
          border: '1px solid var(--border-mid)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
        }}
        onClick={e => e.stopPropagation()}>

        {/* Top color strip */}
        <div style={{ height: 3, background: color }} />

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: `${color}20`, border: `1px solid ${color}40` }}>
              <Layers size={15} style={{ color }} />
            </div>
            <div>
              <h3 className="font-display text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                {cluster ? 'Edit Cluster / Batch' : 'New Cluster / Batch'}
              </h3>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Inside <strong>{group.name}</strong>
              </p>
            </div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-muted)' }} className="p-1 hover:text-accent-red">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          {/* Cluster Name */}
          <div>
            <label className="label">Cluster / Batch Name</label>
            <input className="input-field" placeholder="e.g. Batch A, Row 1-2, Morning Shift"
              value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()} autoFocus />
          </div>

          {/* Description */}
          <div>
            <label className="label">Description (Optional)</label>
            <input className="input-field" placeholder="e.g. 15 PCs for Staff Admin John"
              value={description} onChange={e => setDescription(e.target.value)} />
          </div>

          {/* Color picker */}
          <div>
            <label className="label">Badge Color</label>
            <div className="flex items-center gap-2 flex-wrap">
              {COLOR_PRESETS.map(p => (
                <button
                  key={p.hex}
                  type="button"
                  onClick={() => setColor(p.hex)}
                  className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
                  style={{
                    background: p.hex,
                    boxShadow: color === p.hex ? `0 0 0 2px var(--bg-card), 0 0 0 4px ${p.hex}` : 'none',
                    transform: color === p.hex ? 'scale(1.1)' : 'scale(1)',
                  }}
                  title={p.name}
                >
                  {color === p.hex && <Check size={14} className="text-white drop-shadow" />}
                </button>
              ))}
            </div>
          </div>

          {/* Device Assignment */}
          <div className="pt-2">
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">
                Assigned Devices ({selectedIds.size} of {groupDevices.length})
              </label>
              <div className="flex items-center gap-2 text-xs">
                <button type="button" onClick={selectAll} className="hover:underline" style={{ color: '#38bdf8' }}>All</button>
                <span style={{ color: 'var(--text-faint)' }}>·</span>
                <button type="button" onClick={selectUnassigned} className="hover:underline" style={{ color: '#38bdf8' }}>Unassigned</button>
                <span style={{ color: 'var(--text-faint)' }}>·</span>
                <button type="button" onClick={selectNone} className="hover:underline" style={{ color: 'var(--text-muted)' }}>None</button>
              </div>
            </div>

            {groupDevices.length === 0 ? (
              <div className="p-4 rounded-xl text-center text-xs" style={{ background: 'var(--bg-surface-2)', color: 'var(--text-muted)' }}>
                No devices found in this lab group.
              </div>
            ) : (
              <div className="max-h-52 overflow-y-auto space-y-1.5 p-2 rounded-xl"
                style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
                {groupDevices.map(d => {
                  const isSelected = selectedIds.has(d.id)
                  const isOtherCluster = d.cluster_id && d.cluster_id !== cluster?.id
                  return (
                    <div
                      key={d.id}
                      onClick={() => toggleDevice(d.id)}
                      className="flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer text-xs transition-all"
                      style={{
                        background: isSelected ? `${color}18` : 'transparent',
                        border: `1px solid ${isSelected ? `${color}40` : 'transparent'}`,
                      }}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <button type="button" className="shrink-0" style={{ color: isSelected ? color : 'var(--text-muted)' }}>
                          {isSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                        </button>
                        <span className="font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</span>
                        <span className="font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>{d.ip_address}</span>
                      </div>
                      <div>
                        {isOtherCluster && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                            style={{ background: `${d.cluster_color || '#a855f7'}20`, color: d.cluster_color || '#a855f7' }}>
                            {d.cluster_name || 'In other batch'}
                          </span>
                        )}
                        <span className={`w-1.5 h-1.5 rounded-full inline-block ml-2 ${d.status === 'online' ? 'bg-accent-green' : 'bg-slate-600'}`} />
                      </div>
                    </div>
                  )
                })}
              </div>
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
            style={{ background: color, color: '#fff' }}>
            {loading ? <Loader2 size={13} className="animate-spin" /> : null}
            {loading ? 'Saving…' : cluster ? 'Save Changes' : 'Create Cluster'}
          </button>
        </div>
      </div>
    </div>
  )
}
