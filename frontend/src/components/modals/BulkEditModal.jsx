// components/modals/BulkEditModal.jsx
// Edit shared fields (group, SSH/Windows credentials) across many selected
// devices in one request. Only the sections the user turns on get sent —
// everything else on each device is left untouched.
import React, { useState } from 'react'
import { Users, X, Loader2, FolderInput, KeyRound, ShieldCheck } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

function Section({ icon: Icon, title, hint, enabled, onToggle, children }) {
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${enabled ? 'rgba(167,139,250,0.35)' : 'var(--border-subtle)'}` }}>
      <button type="button" onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
        style={{ background: enabled ? 'rgba(167,139,250,0.08)' : 'var(--bg-surface-2)' }}>
        <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: enabled ? 'rgba(167,139,250,0.18)' : 'var(--bg-surface-3)', color: enabled ? '#a78bfa' : 'var(--text-faint)' }}>
          <Icon size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</p>
          <p className="text-sm" style={{ color: 'var(--text-faint)' }}>{hint}</p>
        </span>
        <span className="w-10 h-6 rounded-full flex items-center shrink-0 transition-all px-0.5"
          style={{ background: enabled ? '#a78bfa' : 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)' }}>
          <span className="w-5 h-5 rounded-full bg-white transition-transform"
            style={{ transform: enabled ? 'translateX(16px)' : 'translateX(0)' }} />
        </span>
      </button>
      {enabled && (
        <div className="px-4 py-4 space-y-3" style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-surface-1)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

const F = ({ label, children }) => (
  <div>
    <label className="text-sm font-semibold block mb-1.5" style={{ color: 'var(--text-muted)' }}>{label}</label>
    {children}
  </div>
)

export default function BulkEditModal({ open, onClose, onSaved, deviceIds, devices, groups }) {
  const [groupOn, setGroupOn]   = useState(false)
  const [groupId, setGroupId]   = useState('')

  const [sshOn, setSshOn]       = useState(false)
  const [sshUser, setSshUser]   = useState('')
  const [sshPass, setSshPass]   = useState('')

  const [rpcOn, setRpcOn]       = useState(false)
  const [rpcUser, setRpcUser]   = useState('')
  const [rpcPass, setRpcPass]   = useState('')

  const [saving, setSaving]     = useState(false)

  const reset = () => {
    setGroupOn(false); setGroupId('')
    setSshOn(false); setSshUser(''); setSshPass('')
    setRpcOn(false); setRpcUser(''); setRpcPass('')
    setSaving(false)
  }

  const handleClose = () => { reset(); onClose() }

  if (!open) return null

  const selected = devices.filter(d => deviceIds.includes(d.id))
  const count = deviceIds.length

  const canSave =
    (groupOn) ||
    (sshOn && (sshUser.trim() || sshPass.trim())) ||
    (rpcOn && (rpcUser.trim() || rpcPass.trim()))

  const handleSave = async () => {
    if (!canSave || saving) return
    const updates = {}
    if (groupOn) updates.group_id = groupId || null
    if (sshOn) {
      if (sshUser.trim()) updates.ssh_username = sshUser.trim()
      if (sshPass.trim()) updates.ssh_password = sshPass
    }
    if (rpcOn) {
      if (rpcUser.trim()) updates.rpc_username = rpcUser.trim()
      if (rpcPass.trim()) updates.rpc_password = rpcPass
    }

    setSaving(true)
    try {
      const { data } = await api.put('/devices/bulk-update', { deviceIds, updates })
      toast.success(`Updated ${data.updated} device${data.updated === 1 ? '' : 's'}`)
      reset()
      onSaved ? onSaved() : onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Bulk update failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div className="absolute inset-0 modal-backdrop" />
      <div className="relative z-10 w-full max-w-lg animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="rounded-2xl overflow-hidden flex flex-col max-h-[88vh]"
          style={{ background: 'var(--bg-surface-1)', border: '1px solid var(--border-subtle)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>

          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-4 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.25)' }}>
              <Users size={16} className="text-brand-400" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Edit {count} selected device{count === 1 ? '' : 's'}
              </h3>
              <p className="text-sm truncate" style={{ color: 'var(--text-faint)' }}>
                {selected.slice(0, 3).map(d => d.name).join(', ')}{count > 3 ? `, +${count - 3} more` : ''}
              </p>
            </div>
            <button onClick={handleClose} className="ml-auto icon-btn p-1.5"><X size={15} /></button>
          </div>

          {/* Body */}
          <div className="px-6 py-5 space-y-3 overflow-y-auto">
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Turn on a section to apply a new value to every selected device. Sections left off are untouched, and blank fields inside an
              enabled section are also left untouched.
            </p>

            <Section icon={FolderInput} title="Group / Lab" hint="Move all selected devices into a group"
              enabled={groupOn} onToggle={() => setGroupOn(o => !o)}>
              <F label="Group">
                <select className="input-field" value={groupId} onChange={e => setGroupId(e.target.value)}>
                  <option value="">No Group</option>
                  {groups?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </F>
            </Section>

            <Section icon={KeyRound} title="SSH Credentials (Linux)" hint="Update username and/or password for Linux devices"
              enabled={sshOn} onToggle={() => setSshOn(o => !o)}>
              <F label="SSH Username">
                <input className="input-field" placeholder="Leave blank to keep existing"
                  value={sshUser} onChange={e => setSshUser(e.target.value)} />
              </F>
              <F label="SSH Password">
                <input type="password" className="input-field" placeholder="Leave blank to keep existing"
                  value={sshPass} onChange={e => setSshPass(e.target.value)} autoComplete="off" />
              </F>
            </Section>

            <Section icon={ShieldCheck} title="Windows Credentials (RPC)" hint="Update username and/or password for Windows devices"
              enabled={rpcOn} onToggle={() => setRpcOn(o => !o)}>
              <F label="Username">
                <input className="input-field" placeholder="Leave blank to keep existing"
                  value={rpcUser} onChange={e => setRpcUser(e.target.value)} />
              </F>
              <F label="Password">
                <input type="password" className="input-field" placeholder="Leave blank to keep existing"
                  value={rpcPass} onChange={e => setRpcPass(e.target.value)} autoComplete="off" />
              </F>
            </Section>

            <div className="px-3 py-2.5 rounded-xl" style={{ background: 'rgba(124,92,245,0.07)', border: '1px solid rgba(167,139,250,0.15)' }}>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>Security: </span>
                Credentials are AES-256 encrypted at rest and never sent back to the browser.
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex gap-3 px-6 py-4 shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button onClick={handleClose} className="btn-ghost flex-1 justify-center" disabled={saving}>Cancel</button>
            <button onClick={handleSave} className="btn-primary flex-1 justify-center"
              disabled={!canSave || saving}
              style={!canSave ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
              {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : `Save to ${count} device${count === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}