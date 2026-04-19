import React, { useState, useEffect } from 'react'
import { X, UserPlus, Pencil, Eye, EyeOff } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import { PERM } from '../../hooks/usePermissions'

const EMPTY = {
  username:    '',
  password:    '',
  role:        'operator',
  permissions: 0,
  enabled:     true,
}

// ── Permission toggles for custom role ──────────────────────────────────────
const PERM_DEFS = [
  { bit: PERM.VIEW_DEVICES,     label: 'View Devices'      },
  { bit: PERM.MANAGE_DEVICES,   label: 'Manage Devices'    },
  { bit: PERM.RUN_ACTIONS,      label: 'Run Actions'       },
  { bit: PERM.VIEW_GROUPS,      label: 'View Groups'       },
  { bit: PERM.MANAGE_GROUPS,    label: 'Manage Groups'     },
  { bit: PERM.VIEW_SCHEDULES,   label: 'View Schedules'    },
  { bit: PERM.MANAGE_SCHEDULES, label: 'Manage Schedules'  },
  { bit: PERM.VIEW_AUDIT,       label: 'View Audit Log'    },
]

const F = ({ label, children, error }) => (
  <div>
    <label className="label">{label}</label>
    {children}
    {error && <p className="text-xs text-accent-red mt-1 font-body">{error}</p>}
  </div>
)

export default function UserModal({ open, onClose, onSaved, user, isLight }) {
  const [form, setForm]       = useState(EMPTY)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors]   = useState({})
  const [showPw, setShowPw]   = useState(false)

  useEffect(() => {
    if (open) {
      setForm(user ? {
        username:    user.username,
        password:    '',
        role:        user.role,
        permissions: user.permissions || 0,
        enabled:     !!user.enabled,
      } : EMPTY)
      setErrors({})
      setShowPw(false)
    }
  }, [open, user])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const togglePerm = (bit) => setForm(f => ({
    ...f,
    permissions: (f.permissions & bit) ? (f.permissions & ~bit) : (f.permissions | bit),
  }))

  const validate = () => {
    const e = {}
    if (!form.username.trim()) e.username = 'Required'
    else if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(form.username)) e.username = 'Letters, numbers, _ . - only (3–50 chars)'
    if (!user && !form.password) e.password = 'Required for new user'
    else if (form.password && form.password.length < 6) e.password = 'Min 6 characters'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return
    setLoading(true)
    try {
      const payload = {
        username:    form.username.trim().toLowerCase(),
        role:        form.role,
        permissions: form.role === 'custom' ? form.permissions : 0,
        enabled:     form.enabled,
      }
      if (form.password) payload.password = form.password

      if (user) {
        await api.put(`/users/${user.id}`, payload)
        toast.success('User updated')
      } else {
        await api.post('/users', payload)
        toast.success('User created')
      }
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  const baseInput = isLight
    ? 'w-full bg-white border border-black/10 rounded-lg px-3 py-2.5 text-sm text-[#1a1a2e] placeholder-slate-400 focus:outline-none focus:border-[#6c5ce7]/50 focus:ring-1 focus:ring-[#6c5ce7]/15 transition-all font-body'
    : 'input-field'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className={`rounded-2xl overflow-hidden
          ${isLight ? 'bg-white shadow-2xl' : 'glass border border-white/10'}`}>

          {/* Top accent */}
          <div className={`h-0.5 ${isLight ? 'bg-[#6c5ce7]' : 'bg-brand-500 opacity-50'}`} />

          {/* Header */}
          <div className={`flex items-center justify-between px-6 py-4 border-b
            ${isLight ? 'border-black/[0.07]' : 'border-white/6'}`}>
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center
                ${isLight ? 'bg-[#6c5ce7] text-white' : 'bg-brand-500/15 border border-brand-500/25 text-brand-400'}`}>
                {user ? <Pencil size={15} /> : <UserPlus size={15} />}
              </div>
              <h3 className={`font-display text-sm ${isLight ? 'text-[#1a1a2e]' : 'text-white'}`}>
                {user ? `Edit — ${user.username}` : 'Create User'}
              </h3>
            </div>
            <button onClick={onClose} className={`p-1 transition-colors ${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-500 hover:text-slate-300'}`}>
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">

            {/* Username */}
            <F label="Username" error={errors.username}>
              <input
                className={`${baseInput} ${errors.username ? 'border-accent-red/50' : ''}`}
                placeholder="e.g. johndoe"
                value={form.username}
                onChange={e => set('username', e.target.value)}
                disabled={!!user}
              />
              {user && <p className={`text-[11px] mt-1 font-body ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                Username cannot be changed after creation.
              </p>}
            </F>

            {/* Password */}
            <F label={user ? 'New Password (blank to keep)' : 'Password'} error={errors.password}>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  className={`${baseInput} pr-10 ${errors.password ? 'border-accent-red/50' : ''}`}
                  placeholder={user ? '••••••••' : 'Min 6 characters'}
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  className={`absolute right-3 top-1/2 -translate-y-1/2 ${isLight ? 'text-slate-400' : 'text-slate-500'}`}
                >
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </F>

            {/* Role */}
            <F label="Role">
              <div className="grid grid-cols-2 gap-2">
                {['admin', 'operator', 'viewer', 'custom'].map(r => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => set('role', r)}
                    className={`py-2.5 px-3 rounded-lg border text-sm font-body font-medium capitalize transition-all text-left
                      ${form.role === r
                        ? isLight
                          ? 'bg-[#6c5ce7]/10 border-[#6c5ce7]/40 text-[#6c5ce7]'
                          : 'bg-brand-500/15 border-brand-500/40 text-brand-400'
                        : isLight
                          ? 'bg-white border-black/10 text-slate-500 hover:border-black/20'
                          : 'bg-surface-3 border-white/6 text-slate-400 hover:border-white/12'
                      }`}
                  >
                    {r}
                    <span className={`block text-[10px] font-normal mt-0.5
                      ${form.role === r ? 'opacity-80' : isLight ? 'text-slate-400' : 'text-slate-600'}`}>
                      {{
                        admin:    'Full access',
                        operator: 'Actions + view',
                        viewer:   'Read-only',
                        custom:   'Choose below',
                      }[r]}
                    </span>
                  </button>
                ))}
              </div>
            </F>

            {/* Custom permission bits */}
            {form.role === 'custom' && (
              <F label="Permissions">
                <div className={`rounded-lg border p-3 space-y-2
                  ${isLight ? 'bg-[#f5f5fa] border-black/[0.07]' : 'bg-surface-3 border-white/6'}`}>
                  {PERM_DEFS.map(({ bit, label }) => {
                    const on = !!(form.permissions & bit)
                    return (
                      <label key={bit} className="flex items-center gap-3 cursor-pointer select-none group">
                        <div
                          onClick={() => togglePerm(bit)}
                          className={`w-4 h-4 rounded border flex items-center justify-center transition-all
                            ${on
                              ? isLight ? 'bg-[#6c5ce7] border-[#6c5ce7]' : 'bg-brand-500 border-brand-500'
                              : isLight ? 'bg-white border-black/20' : 'bg-surface-4 border-white/15'
                            }`}
                        >
                          {on && <span className="text-white text-[9px] font-bold">✓</span>}
                        </div>
                        <span className={`text-xs font-body ${isLight ? 'text-slate-600 group-hover:text-[#1a1a2e]' : 'text-slate-400 group-hover:text-slate-200'} transition-colors`}>
                          {label}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </F>
            )}

            {/* Enabled toggle */}
            {user && (
              <div className="flex items-center justify-between">
                <div>
                  <p className={`text-sm font-body font-medium ${isLight ? 'text-[#1a1a2e]' : 'text-slate-200'}`}>Account enabled</p>
                  <p className={`text-xs font-body ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>Disabled accounts cannot log in</p>
                </div>
                <button
                  type="button"
                  onClick={() => set('enabled', !form.enabled)}
                  className={`relative w-9 h-5 rounded-full border transition-all duration-300
                    ${form.enabled
                      ? isLight ? 'bg-[#6c5ce7] border-[#6c5ce7]' : 'bg-brand-500 border-brand-500'
                      : isLight ? 'bg-slate-200 border-slate-300' : 'bg-surface-4 border-white/10'
                    }`}
                >
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all duration-300
                    ${form.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className={`flex gap-3 px-6 pb-6 pt-2`}>
            <button onClick={onClose} className="btn-ghost flex-1 justify-center" disabled={loading}>
              Cancel
            </button>
            <button onClick={handleSubmit} className={`flex-1 justify-center flex items-center gap-2 btn-primary
              ${isLight ? '!bg-[#6c5ce7] hover:!bg-[#5a4bd1]' : ''}`}
              disabled={loading}>
              {loading ? '…' : user ? 'Save Changes' : 'Create User'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
