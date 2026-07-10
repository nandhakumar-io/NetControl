// components/modals/EnrollmentTokenModal.jsx — view/copy/regenerate an org's
// agent enrollment token.
//
// This is the missing UI half of routes/orgs.js's GET/POST
// .../enrollment-token endpoints (see db/migrate-agent-enrollment.js for the
// backend fix this token exists to support): agent installers need this
// value in their x-enrollment-token header so a freshly registered device
// lands in the right org's Devices page instead of getting created with
// org_id = NULL and becoming invisible everywhere except the metrics
// pipeline (the exact bug that migration fixes).
import React, { useState, useEffect, useCallback } from 'react'
import { X, KeyRound, Copy, Check, RefreshCw, Loader2, AlertTriangle } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

export default function EnrollmentTokenModal({ org, onClose }) {
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [confirmingRegen, setConfirmingRegen] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api.get(`/orgs/${org.id}/enrollment-token`)
      .then(({ data }) => setToken(data.enrollment_token))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load enrollment token'))
      .finally(() => setLoading(false))
  }, [org.id])

  useEffect(() => { load() }, [load])

  const copyToken = () => {
    if (!token) return
    navigator.clipboard.writeText(token)
    setCopied(true)
    toast.success('Enrollment token copied')
    setTimeout(() => setCopied(false), 1500)
  }

  const regenerate = async () => {
    setRegenerating(true)
    try {
      const { data } = await api.post(`/orgs/${org.id}/enrollment-token/regenerate`)
      setToken(data.enrollment_token)
      setConfirmingRegen(false)
      toast.success('New enrollment token generated — update any install scripts still using the old one')
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to regenerate token')
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="glass w-full max-w-lg rounded-2xl border" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <h2 className="font-display text-sm flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <KeyRound size={16} className="text-brand-400" /> Agent Enrollment Token — {org.name}
          </h2>
          <button onClick={onClose} style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Give this token to the agent installer (as the <code style={{ color: 'var(--text-secondary)' }}>x-enrollment-token</code> header
            on <code style={{ color: 'var(--text-secondary)' }}>POST /api/metrics/register</code>) so newly installed agents register
            straight into <span style={{ color: 'var(--text-primary)' }}>{org.name}</span> instead of another organization.
          </p>

          {loading ? (
            <div className="flex justify-center py-6"><Loader2 className="animate-spin text-brand-400" size={20} /></div>
          ) : (
            <div className="flex items-center gap-2">
              <code className="input-field flex-1 font-mono text-xs truncate select-all" style={{ color: 'var(--text-primary)' }}>
                {token}
              </code>
              <button onClick={copyToken} className="btn-secondary px-3 py-2 shrink-0" title="Copy token">
                {copied ? <Check size={14} className="text-accent-green" /> : <Copy size={14} />}
              </button>
            </div>
          )}

          <div className="border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
            {!confirmingRegen ? (
              <button
                onClick={() => setConfirmingRegen(true)}
                disabled={loading}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                <RefreshCw size={12} /> Regenerate token
              </button>
            ) : (
              <div className="rounded-xl border border-accent-amber/30 bg-accent-amber/5 p-3 flex flex-col gap-2">
                <p className="text-xs flex items-start gap-2 text-accent-amber">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  Any install script or agent still using the old token will stop being able to register new
                  devices (already-registered devices keep working — this only affects <em>new</em> enrollments).
                </p>
                <div className="flex gap-2">
                  <button onClick={regenerate} disabled={regenerating} className="btn-primary text-xs px-3 py-1.5">
                    {regenerating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    Yes, regenerate
                  </button>
                  <button onClick={() => setConfirmingRegen(false)} className="btn-secondary text-xs px-3 py-1.5">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}