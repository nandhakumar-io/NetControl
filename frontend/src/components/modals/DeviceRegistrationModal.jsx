// components/modals/DeviceRegistrationModal.jsx
// Modal for approving new agent device registrations
// Shows when a new device registers and needs admin approval
//
// THEME FIX: this used to be hardcoded to dark-mode Tailwind classes
// (bg-surface-1, text-slate-200/400/500, border-slate-600 — all static
// hex colors from tailwind.config.js, NOT the app's theme-aware
// `--bg-*`/`--text-*`/`--border-*` CSS custom properties defined in
// index.css). Every other surface in the app (cards, other modals) uses
// those CSS vars via inline `style={{ background: 'var(--bg-card)' }}`,
// which is what actually flips with the `html.light` class the theme
// toggle sets — the static Tailwind classes never do. Net effect: this
// modal stayed dark even when the rest of the UI switched to light mode.
// Fixed by switching every color to the CSS vars, matching the pattern
// already used in ActionConfirmModal.jsx / BackupPage.jsx / etc.
import React, { useState, useEffect } from 'react'
import {
  Server, Network, HardDrive, Check, X, AlertCircle, 
  Loader2, Copy, Check as CheckIcon, Pencil
} from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

export default function DeviceRegistrationModal({ 
  device, 
  isOpen, 
  onClose, 
  onApprove,
  onReject,
  isLoading = false 
}) {
  const [copied, setCopied] = useState(false)
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [editedName, setEditedName] = useState('')

  // Reset the editable name whenever a different pending device is opened
  // (the agent-suggested name is just a starting point — admin can rename
  // it before approving, e.g. to match their own naming convention).
  useEffect(() => {
    setEditedName(device?.device_name || '')
  }, [device?.device_id])

  if (!isOpen || !device) return null

  const handleCopyDeviceId = () => {
    navigator.clipboard.writeText(device.device_id)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const trimmedName = editedName.trim()
  const nameInvalid = !trimmedName || trimmedName.length > 100

  const handleApprove = async () => {
    if (nameInvalid) {
      toast.error('Device name is required (max 100 characters)')
      return
    }
    setApproving(true)
    try {
      // BUG FIX: this previously called '/api/devices/...' — but the shared
      // axios instance (lib/api.js) already has baseURL '/api', so the
      // request actually hit '/api/api/devices/...' and 404'd every time.
      // That's why approve/reject looked "stuck" with a generic error toast.
      // Every other call in this app correctly omits the '/api' prefix
      // (see DevicesPage.jsx, DeviceModal.jsx) — matching that here.
      await api.post(`/devices/${device.device_id}/approve-registration`, {
        name: trimmedName,
        os_type: device.os_type,
        ip_address: device.ip_address,
        mac_address: device.mac_address
      })
      
      toast.success(`Device "${device.device_name}" approved`)
      if (onApprove) {
        onApprove(device)
      }
      onClose()
    } catch (e) {
      console.error('Approval error:', e)
      toast.error(e.response?.data?.error || 'Failed to approve device')
    } finally {
      setApproving(false)
    }
  }

  const handleReject = async () => {
    if (!window.confirm(`Delete "${device.device_name}" permanently?`)) {
      return
    }
    
    setRejecting(true)
    try {
      await api.delete(`/devices/${device.device_id}`)
      toast.success(`Device "${device.device_name}" rejected and deleted`)
      if (onReject) {
        onReject(device)
      }
      onClose()
    } catch (e) {
      console.error('Rejection error:', e)
      toast.error(e.response?.data?.error || 'Failed to reject device')
    } finally {
      setRejecting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div
        className="rounded-xl shadow-2xl w-full max-w-md border"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b flex items-start gap-3"
          style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="relative w-10 h-10 rounded-lg bg-brand-500/10 border border-brand-500/20 flex items-center justify-center shrink-0">
            <AlertCircle size={18} className="text-brand-400" />
            <span className="absolute -top-1 -right-1 flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-brand-500" />
            </span>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-body font-semibold" style={{ color: 'var(--text-primary)' }}>
                New Device Registered
              </h2>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-brand-500/15 text-brand-400 border border-brand-500/25">
                Live
              </span>
            </div>
            <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>
              A new agent just checked in. Review and approve to add it to your network.
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-4">
          {/* Device name — editable so the admin can rename before approving */}
          <div>
            <label className="text-xs font-body font-semibold block mb-1.5 flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
              Device Name
              <Pencil size={10} style={{ color: 'var(--text-faint)' }} />
            </label>
            <input
              type="text"
              value={editedName}
              onChange={e => setEditedName(e.target.value)}
              maxLength={100}
              placeholder="Enter a device name…"
              className="w-full px-3 py-2 rounded-lg border text-sm font-mono focus:outline-none focus:ring-1 transition-colors"
              style={{
                background: 'var(--bg-input)',
                color: 'var(--text-primary)',
                borderColor: nameInvalid ? '#f87171' : 'var(--border-subtle)',
              }}
            />
            {nameInvalid ? (
              <p className="text-[11px] text-accent-red mt-1">Name is required (max 100 characters)</p>
            ) : editedName.trim() !== device.device_name ? (
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>Renamed from agent-suggested "{device.device_name}"</p>
            ) : (
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-faint)' }}>Agent-suggested name — edit if you'd like</p>
            )}
          </div>

          {/* Device info grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* IP Address */}
            <div>
              <label className="text-xs font-body font-semibold block mb-1" style={{ color: 'var(--text-secondary)' }}>
                <Network size={11} className="inline mr-1" />
                IP Address
              </label>
              <div className="px-3 py-2 rounded-lg border text-sm font-mono"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
                {device.ip_address || 'Unknown'}
              </div>
            </div>

            {/* MAC Address */}
            <div>
              <label className="text-xs font-body font-semibold block mb-1" style={{ color: 'var(--text-secondary)' }}>
                <HardDrive size={11} className="inline mr-1" />
                MAC Address
              </label>
              <div className="px-3 py-2 rounded-lg border text-sm font-mono truncate"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                title={device.mac_address}>
                {device.mac_address || 'N/A'}
              </div>
            </div>

            {/* OS Type */}
            <div>
              <label className="text-xs font-body font-semibold block mb-1" style={{ color: 'var(--text-secondary)' }}>
                <Server size={11} className="inline mr-1" />
                OS Type
              </label>
              <div className="px-3 py-2 rounded-lg border text-sm font-mono flex items-center gap-1.5"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: device.os_type ? 'var(--text-primary)' : 'var(--text-faint)' }}>
                {device.os_type === 'windows' ? (
                  <span className="inline-flex items-center gap-1 text-sky-400"><Server size={10} /> Windows</span>
                ) : device.os_type === 'linux' ? (
                  <span className="inline-flex items-center gap-1 text-violet-400"><HardDrive size={10} /> Linux</span>
                ) : 'Unknown'}
              </div>
            </div>

            {/* Device ID */}
            <div>
              <label className="text-xs font-body font-semibold block mb-1" style={{ color: 'var(--text-secondary)' }}>
                Device ID
              </label>
              <button
                onClick={handleCopyDeviceId}
                className="w-full px-3 py-2 rounded-lg border text-xs font-mono text-left transition-colors flex items-center justify-between group"
                style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                title="Click to copy"
              >
                <span className="truncate">{device.device_id?.slice(0, 12)}…</span>
                {copied ? (
                  <CheckIcon size={12} className="text-accent-green shrink-0" />
                ) : (
                  <Copy size={12} style={{ color: 'var(--text-faint)' }} className="group-hover:opacity-70 shrink-0" />
                )}
              </button>
            </div>
          </div>

          {/* Info note */}
          <div className="bg-brand-500/5 border border-brand-500/20 rounded-lg p-3">
            <p className="text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-semibold text-brand-400">Note:</span> After approval, you can configure SSH credentials in the Devices page for remote access.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t flex gap-3"
          style={{ borderColor: 'var(--border-subtle)' }}>
          <button
            onClick={handleReject}
            disabled={approving || rejecting}
            className="flex-1 px-4 py-2 rounded-lg border text-sm font-body transition-all hover:border-accent-red hover:text-accent-red hover:bg-accent-red/5 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            style={{ borderColor: 'var(--border-mid)', color: 'var(--text-secondary)' }}
          >
            {rejecting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Rejecting…
              </>
            ) : (
              <>
                <X size={14} />
                Reject
              </>
            )}
          </button>
          <button
            onClick={handleApprove}
            disabled={approving || rejecting || nameInvalid}
            className="flex-1 px-4 py-2 rounded-lg bg-brand-500 text-white text-sm font-body font-semibold transition-all hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {approving ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Approving…
              </>
            ) : (
              <>
                <Check size={14} />
                Approve
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}