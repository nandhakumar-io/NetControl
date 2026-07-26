import React, { useState, useEffect } from 'react'
import { X, Monitor, Smartphone, LogOut, ShieldAlert } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

// Self-service "Active sessions" panel, matching the style of the other
// account-level modals (TwoFactorModal, NotificationPrefsModal). Mount
// from wherever the account menu lives (Layout.jsx sidebar) with:
//   const [showSessions, setShowSessions] = useState(false)
//   <SessionsModal open={showSessions} onClose={() => setShowSessions(false)} />

function formatTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
function ago(ts) {
  if (!ts) return 'never'
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return formatTs(ts)
}

// Best-effort, deliberately simple — good enough for "which device is
// this" at a glance without pulling in a full UA-parsing dependency.
// Order matters: check the more specific tokens (Edg, OPR) before the
// engines/browsers they're built on (Chrome, Safari) would otherwise
// falsely match first.
function describeUserAgent(ua) {
  if (!ua) return { label: 'Unknown device', mobile: false }
  const mobile = /Mobile|Android|iPhone|iPad/.test(ua)
  let browser = 'Unknown browser'
  if (/Edg\//.test(ua)) browser = 'Edge'
  else if (/OPR\//.test(ua)) browser = 'Opera'
  else if (/Firefox\//.test(ua)) browser = 'Firefox'
  else if (/CriOS\//.test(ua)) browser = 'Chrome'
  else if (/Chrome\//.test(ua)) browser = 'Chrome'
  else if (/Safari\//.test(ua)) browser = 'Safari'

  let os = ''
  if (/Windows/.test(ua)) os = 'Windows'
  else if (/Mac OS X/.test(ua)) os = 'macOS'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/iPhone|iPad/.test(ua)) os = 'iOS'
  else if (/Linux/.test(ua)) os = 'Linux'

  return { label: os ? `${browser} on ${os}` : browser, mobile }
}

export default function SessionsModal({ open, onClose }) {
  const [sessions, setSessions] = useState(null)
  const [loading, setLoading] = useState(false)
  const [revokingId, setRevokingId] = useState(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const load = () => {
    setLoading(true)
    api.get('/sessions').then(({ data }) => setSessions(data))
      .catch(() => toast.error('Could not load sessions'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { if (open) load() }, [open])

  if (!open) return null

  const revokeOne = async (session) => {
    setRevokingId(session.id)
    try {
      await api.delete(`/sessions/${session.id}`)
      setSessions(prev => prev.filter(s => s.id !== session.id))
      toast.success(session.current ? 'Signed out of this device' : 'Session revoked')
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not revoke session')
    } finally { setRevokingId(null) }
  }

  const revokeAllOthers = async () => {
    try {
      const { data } = await api.delete('/sessions')
      toast.success(`Signed out of ${data.revoked} other session${data.revoked === 1 ? '' : 's'}`)
      setConfirmAll(false)
      load()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not revoke sessions')
    }
  }

  const otherCount = (sessions || []).filter(s => !s.current).length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="glass w-full max-w-lg rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <h2 className="font-display text-sm flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <Monitor size={16} className="text-brand-400" /> Active Sessions
          </h2>
          <button onClick={onClose} style={{ color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>
            These are the devices and browsers currently signed in to your account. Revoke any you don't recognize.
          </p>

          {confirmAll ? (
            <div className="flex flex-col gap-3 rounded-lg p-3" style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)' }}>
              <div className="flex items-start gap-2">
                <ShieldAlert size={15} className="shrink-0 mt-0.5" style={{ color: '#fbbf24' }} />
                <p className="text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
                  This signs out every other session ({otherCount}) but keeps this device logged in. Continue?
                </p>
              </div>
              <div className="flex gap-2">
                <button className="btn-ghost flex-1 justify-center text-xs" onClick={() => setConfirmAll(false)}>Cancel</button>
                <button className="btn-primary flex-1 justify-center text-xs bg-accent-red/80 hover:bg-accent-red" onClick={revokeAllOthers}>
                  Sign out everywhere else
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn-secondary w-full justify-center text-xs"
              onClick={() => setConfirmAll(true)}
              disabled={loading || otherCount === 0}
            >
              <LogOut size={13} /> Sign out of all other sessions{otherCount > 0 ? ` (${otherCount})` : ''}
            </button>
          )}

          <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
            {loading && !sessions ? (
              <p className="text-xs font-body text-center py-4" style={{ color: 'var(--text-muted)' }}>Loading…</p>
            ) : sessions && sessions.length === 0 ? (
              <p className="text-xs font-body text-center py-4" style={{ color: 'var(--text-muted)' }}>No active sessions found.</p>
            ) : (sessions || []).map(s => {
              const { label, mobile } = describeUserAgent(s.userAgent)
              const Icon = mobile ? Smartphone : Monitor
              return (
                <div key={s.id} className="flex items-center gap-3 rounded-lg p-3"
                  style={{ background: s.current ? 'rgba(52,211,153,0.06)' : 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                  <Icon size={16} className="shrink-0" style={{ color: s.current ? '#34d399' : 'var(--text-muted)' }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-body font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{label}</span>
                      {s.current && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-body font-bold shrink-0"
                          style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399' }}>THIS DEVICE</span>
                      )}
                    </div>
                    <p className="text-[11px] font-body truncate" style={{ color: 'var(--text-muted)' }}>
                      {s.ipAddress || 'Unknown IP'} · last active {ago(s.lastUsedAt)}
                    </p>
                  </div>
                  <button
                    onClick={() => revokeOne(s)}
                    disabled={revokingId === s.id}
                    title={s.current ? 'Log out this device' : 'Revoke session'}
                    className="shrink-0 p-1.5 rounded-lg transition-all"
                    style={{ color: 'var(--text-muted)' }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.background = 'rgba(248,113,113,0.1)' }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}>
                    <LogOut size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}