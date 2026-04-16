import React, { useState, useEffect } from 'react'
import { X, Monitor, Loader2 } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

const EMPTY = {
  name: '',
  ip_address: '',
  mac_address: '',
  os_type: 'linux',
  group_id: '',
  // Linux / SSH
  ssh_username: '',
  ssh_password: '',
  ssh_key: '',
  // Windows / net rpc
  rpc_username: '',
  rpc_password: '',
}

const F = ({ label, id, errors, children }) => (
  <div>
    <label className="label" htmlFor={id}>{label}</label>
    {children}
    {errors?.[id] && (
      <p className="text-xs text-accent-red mt-1 font-body">{errors[id]}</p>
    )}
  </div>
)

export default function DeviceModal({ open, onClose, onSaved, device, groups }) {
  const [form, setForm]       = useState(EMPTY)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors]   = useState({})

  useEffect(() => {
    if (open) {
      setForm(device ? {
        name:         device.name         || '',
        ip_address:   device.ip_address   || '',
        mac_address:  device.mac_address  || '',
        os_type:      device.os_type      || 'linux',
        group_id:     device.group_id     || '',
        // Usernames are NOT secrets — backend returns them for pre-population
        ssh_username: device.ssh_username || '',
        rpc_username: device.rpc_username || '',
        // Secrets are never returned from the server — always start blank
        ssh_password: '',
        ssh_key:      '',
        rpc_password: '',
      } : EMPTY)
      setErrors({})
    }
  }, [open, device])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const validate = () => {
    const e = {}
    if (!form.name.trim())        e.name        = 'Required'
    if (!form.ip_address.trim())  e.ip_address  = 'Required'
    if (!form.mac_address.trim()) e.mac_address = 'Required'

    if (form.mac_address && !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(form.mac_address)) {
      e.mac_address = 'Invalid MAC (e.g. AA:BB:CC:DD:EE:FF)'
    }

    if (form.os_type === 'linux') {
      if (!form.ssh_username.trim()) e.ssh_username = 'Required'
      if (!device && !form.ssh_password.trim()) e.ssh_password = 'Required for new device'
    } else {
      if (!form.rpc_username.trim()) e.rpc_username = 'Required'
      if (!device && !form.rpc_password.trim()) e.rpc_password = 'Required for new device'
    }

    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return
    setLoading(true)
    try {
      const payload = { ...form }

      // Empty group_id → send null so backend doesn't get an empty string that fails UUID validation
      if (!payload.group_id) payload.group_id = null

      // Remove empty secret fields so backend CASE WHEN preserves existing encrypted values
      if (!payload.ssh_password) delete payload.ssh_password
      if (!payload.ssh_key)      delete payload.ssh_key
      if (!payload.rpc_password) delete payload.rpc_password

      // Strip fields irrelevant to the selected OS
      if (payload.os_type === 'linux') {
        delete payload.rpc_username
        delete payload.rpc_password
      } else {
        delete payload.ssh_username
        delete payload.ssh_password
        delete payload.ssh_key
      }

      if (device) {
        await api.put(`/devices/${device.id}`, payload)
        toast.success('Device updated')
      } else {
        await api.post('/devices', payload)
        toast.success('Device added')
      }

      onSaved()
      onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  const isLinux = form.os_type === 'linux'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="glass rounded-2xl border border-white/10 overflow-hidden">
          <div className="h-0.5 bg-brand-500 opacity-50" />

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-white/6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-brand-500/15 border border-brand-500/25 flex items-center justify-center">
                <Monitor size={16} className="text-brand-400" />
              </div>
              <h3 className="font-display text-white">
                {device ? 'Edit Device' : 'Add Device'}
              </h3>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors p-1">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="p-6 grid grid-cols-2 gap-4 max-h-[70vh] overflow-y-auto">

            {/* Name — full width */}
            <div className="col-span-2">
              <F label="Display Name" id="name" errors={errors}>
                <input
                  id="name"
                  className={`input-field ${errors.name ? 'border-accent-red/50' : ''}`}
                  placeholder="e.g. LAB1-PC-01"
                  value={form.name}
                  onChange={e => set('name', e.target.value)}
                />
              </F>
            </div>

            {/* IP */}
            <F label="IP Address" id="ip_address" errors={errors}>
              <input
                id="ip_address"
                className={`input-field ${errors.ip_address ? 'border-accent-red/50' : ''}`}
                placeholder="192.168.1.100"
                value={form.ip_address}
                onChange={e => set('ip_address', e.target.value)}
              />
            </F>

            {/* MAC */}
            <F label="MAC Address" id="mac_address" errors={errors}>
              <input
                id="mac_address"
                className={`input-field ${errors.mac_address ? 'border-accent-red/50' : ''}`}
                placeholder="AA:BB:CC:DD:EE:FF"
                value={form.mac_address}
                onChange={e => set('mac_address', e.target.value)}
              />
            </F>

            {/* OS Type */}
            <F label="OS Type" id="os_type" errors={errors}>
              <select
                id="os_type"
                className="input-field"
                value={form.os_type}
                onChange={e => set('os_type', e.target.value)}
              >
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
              </select>
            </F>

            {/* Group */}
            <F label="Group / Lab" id="group_id" errors={errors}>
              <select
                id="group_id"
                className="input-field"
                value={form.group_id}
                onChange={e => set('group_id', e.target.value)}
              >
                <option value="">No Group</option>
                {groups?.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </F>

            {/* ── Linux / SSH fields ── */}
            {isLinux ? (<>
              <F label="SSH Username" id="ssh_username" errors={errors}>
                <input
                  id="ssh_username"
                  className={`input-field ${errors.ssh_username ? 'border-accent-red/50' : ''}`}
                  placeholder="e.g. ubuntu"
                  value={form.ssh_username}
                  onChange={e => set('ssh_username', e.target.value)}
                />
              </F>

              <F label={device ? 'SSH Password (blank to keep)' : 'SSH Password'} id="ssh_password" errors={errors}>
                <input
                  id="ssh_password"
                  type="password"
                  className={`input-field ${errors.ssh_password ? 'border-accent-red/50' : ''}`}
                  placeholder={device ? '••••••••' : 'SSH password'}
                  value={form.ssh_password}
                  onChange={e => set('ssh_password', e.target.value)}
                />
              </F>

              <div className="col-span-2">
                <F label="SSH Private Key (optional — overrides password)" id="ssh_key" errors={errors}>
                  <textarea
                    id="ssh_key"
                    rows={3}
                    className="input-field resize-none font-mono text-xs"
                    placeholder={device ? '(leave blank to keep existing key)' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                    value={form.ssh_key}
                    onChange={e => set('ssh_key', e.target.value)}
                  />
                </F>
              </div>

            {/* ── Windows / net rpc fields ── */}
            </>) : (<>
              <F label="RPC Username" id="rpc_username" errors={errors}>
                <input
                  id="rpc_username"
                  className={`input-field ${errors.rpc_username ? 'border-accent-red/50' : ''}`}
                  placeholder="e.g. Administrator"
                  value={form.rpc_username}
                  onChange={e => set('rpc_username', e.target.value)}
                />
              </F>

              <F label={device ? 'RPC Password (blank to keep)' : 'RPC Password'} id="rpc_password" errors={errors}>
                <input
                  id="rpc_password"
                  type="password"
                  className={`input-field ${errors.rpc_password ? 'border-accent-red/50' : ''}`}
                  placeholder={device ? '••••••••' : 'Windows password'}
                  value={form.rpc_password}
                  onChange={e => set('rpc_password', e.target.value)}
                />
              </F>

              <div className="col-span-2 px-3 py-2 rounded-lg bg-surface-3 border border-white/6">
                <p className="text-xs text-slate-500 font-body">
                  Used with <span className="font-mono text-slate-400">net rpc</span> over SMB (port 445).
                  Ensure the Windows machine has file sharing enabled and the account has shutdown privileges.
                </p>
              </div>
            </>)}

            {/* Security note */}
            <div className="col-span-2 px-3 py-2.5 rounded-lg bg-surface-3 border border-white/6">
              <p className="text-xs text-slate-400 font-body">
                <span className="text-slate-300 font-medium">Security:</span> Credentials
                are AES-256 encrypted at rest and never sent to the browser. They are only
                used server-side for remote commands.
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex gap-3 px-6 pb-6">
            <button onClick={onClose} className="btn-ghost flex-1 justify-center" disabled={loading}>
              Cancel
            </button>
            <button onClick={handleSubmit} className="btn-primary flex-1 justify-center" disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : null}
              {loading ? 'Saving…' : device ? 'Save Changes' : 'Add Device'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

