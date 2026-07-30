// components/modals/BulkEditModal.jsx — bulk-edit form for multiple selected
// devices, posted to PUT /api/devices/bulk-update. Only fields the operator
// actually touches are sent (see FIELDS below) — leaving a field blank/at
// its default means "don't change this on any selected device", matching
// the backend's behavior of only writing keys present in `updates`.
import React, { useState } from 'react'
import { X, Users, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import { getErrorMessage } from '../../lib/errors'

const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,49}$/i

function TagInput({ tags, onChange }) {
  const [draft, setDraft] = useState('')
  const addTag = () => {
    const t = draft.trim().toLowerCase()
    setDraft('')
    if (!t || tags.includes(t) || !TAG_RE.test(t)) return
    onChange([...tags, t])
  }
  const removeTag = (t) => onChange(tags.filter(x => x !== t))
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {tags.map(t => (
          <span key={t} className="inline-flex items-center gap-1 text-xs font-mono px-2 py-1 rounded-lg"
            style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', color: '#a78bfa' }}>
            {t}
            <button type="button" onClick={() => removeTag(t)} className="hover:opacity-70">
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <input
        className="input-field"
        placeholder="Type a tag and press Enter (e.g. prod, k8s-node)"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag() } }}
        onBlur={addTag}
      />
    </div>
  )
}

const EMPTY = {
  group_id: '',
  os_type: '',
  ssh_username: '', ssh_password: '', ssh_key: '',
  rpc_username: '', rpc_password: '',
  tags: [], tagsMode: 'add',
}

export default function BulkEditModal({ open, onClose, deviceIds, devices, groups, onSaved }) {
  const [form, setForm]       = useState(EMPTY)
  const [enabled, setEnabled] = useState({}) // which fields the operator has actually opted to change
  const [loading, setLoading] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const toggle = (k) => setEnabled(e => ({ ...e, [k]: !e[k] }))

  const selectedDevices = (devices || []).filter(d => deviceIds.includes(d.id))
  const anyWindows = selectedDevices.some(d => d.os_type === 'windows')
  const anyLinux   = selectedDevices.some(d => d.os_type === 'linux')

  const reset = () => { setForm(EMPTY); setEnabled({}) }
  const handleClose = () => { reset(); onClose() }

  const handleSubmit = async () => {
    if (!deviceIds.length) return
    const updates = {}
    if (enabled.group_id)     updates.group_id = form.group_id || null
    if (enabled.os_type)      updates.os_type = form.os_type
    if (enabled.ssh_username) updates.ssh_username = form.ssh_username || null
    if (enabled.ssh_password) updates.ssh_password = form.ssh_password || null
    if (enabled.ssh_key)      updates.ssh_key = form.ssh_key || null
    if (enabled.rpc_username) updates.rpc_username = form.rpc_username || null
    if (enabled.rpc_password) updates.rpc_password = form.rpc_password || null
    if (enabled.tags && form.tags.length) {
      updates.tags = form.tags
      updates.tagsMode = form.tagsMode
    }

    if (Object.keys(updates).length === 0) {
      toast.error('Pick at least one field to change')
      return
    }

    setLoading(true)
    try {
      const { data } = await api.put('/devices/bulk-update', { deviceIds, updates })
      toast.success(`${data.updated ?? deviceIds.length} device${deviceIds.length > 1 ? 's' : ''} updated`)
      reset()
      onSaved()
    } catch (err) {
      toast.error(getErrorMessage(err, 'Bulk update failed'))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  const Row = ({ id, label, children }) => (
    <div className="flex items-start gap-3 py-2.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <label className="flex items-center gap-2 pt-1.5 shrink-0 w-40 cursor-pointer">
        <input type="checkbox" checked={!!enabled[id]} onChange={() => toggle(id)} />
        <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      </label>
      <div className="flex-1">{children}</div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div className="absolute inset-0 modal-backdrop" />
      <div className="relative z-10 w-full max-w-lg animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="glass rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(167,139,250,0.18)' }}>
          <div className="h-px glow-line" />

          <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(124,92,245,0.15)', border: '1px solid rgba(167,139,250,0.25)' }}>
                <Users size={15} className="text-brand-400" />
              </div>
              <h3 className="font-display text-base" style={{ color: 'var(--text-primary)' }}>
                Edit {deviceIds.length} Device{deviceIds.length > 1 ? 's' : ''}
              </h3>
            </div>
            <button onClick={handleClose} className="icon-btn p-1.5"><X size={15} /></button>
          </div>

          <div className="p-6 max-h-[68vh] overflow-y-auto">
            <p className="text-xs font-body mb-3" style={{ color: 'var(--text-faint)' }}>
              Check a field to change it on all selected devices. Unchecked fields are left untouched.
            </p>

            <Row id="group_id" label="Group / Lab">
              <select className="input-field" disabled={!enabled.group_id}
                value={form.group_id} onChange={e => set('group_id', e.target.value)}>
                <option value="">No Group</option>
                {groups?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Row>

            <Row id="os_type" label="OS Type">
              <select className="input-field" disabled={!enabled.os_type}
                value={form.os_type || 'linux'} onChange={e => set('os_type', e.target.value)}>
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
              </select>
            </Row>

            <Row id="ssh_username" label="SSH Username">
              <input className="input-field" disabled={!enabled.ssh_username}
                placeholder="ubuntu" value={form.ssh_username} onChange={e => set('ssh_username', e.target.value)} />
            </Row>

            <Row id="ssh_password" label="SSH Password">
              <input type="password" className="input-field" disabled={!enabled.ssh_password}
                placeholder="New SSH password" value={form.ssh_password} onChange={e => set('ssh_password', e.target.value)} />
            </Row>

            <Row id="ssh_key" label="SSH Private Key">
              <textarea rows={2} className="input-field resize-none font-mono text-xs" disabled={!enabled.ssh_key}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={form.ssh_key} onChange={e => set('ssh_key', e.target.value)} />
            </Row>

            <Row id="rpc_username" label="Windows Username">
              <input className="input-field" disabled={!enabled.rpc_username}
                placeholder="Administrator" value={form.rpc_username} onChange={e => set('rpc_username', e.target.value)} />
            </Row>

            <Row id="rpc_password" label="Windows Password">
              <input type="password" className="input-field" disabled={!enabled.rpc_password}
                placeholder="New Windows password" value={form.rpc_password} onChange={e => set('rpc_password', e.target.value)} />
            </Row>

            <Row id="tags" label="Tags">
              <div className="space-y-2">
                <TagInput tags={form.tags} onChange={t => set('tags', t)} />
                <div className="flex gap-3 text-xs font-body" style={{ color: 'var(--text-muted)' }}>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="tagsMode" checked={form.tagsMode === 'add'}
                      onChange={() => set('tagsMode', 'add')} disabled={!enabled.tags} />
                    Add to existing tags
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="tagsMode" checked={form.tagsMode === 'replace'}
                      onChange={() => set('tagsMode', 'replace')} disabled={!enabled.tags} />
                    Replace all tags
                  </label>
                </div>
              </div>
            </Row>

            {(anyWindows && anyLinux) && (
              <div className="mt-3 px-3 py-2 rounded-xl" style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
                  Your selection mixes Linux and Windows devices — credential fields only apply to the matching OS type on each device.
                </p>
              </div>
            )}

            <div className="col-span-2 mt-3 px-3 py-2.5 rounded-xl"
              style={{ background: 'rgba(124,92,245,0.07)', border: '1px solid rgba(167,139,250,0.15)' }}>
              <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>Security: </span>
                Credentials are AES-256 encrypted at rest and never sent to the browser.
              </p>
            </div>
          </div>

          <div className="flex gap-3 px-6 pb-6">
            <button onClick={handleClose} className="btn-ghost flex-1 justify-center" disabled={loading}>Cancel</button>
            <button onClick={handleSubmit} className="btn-primary flex-1 justify-center" disabled={loading}>
              {loading ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : `Update ${deviceIds.length} Device${deviceIds.length > 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}