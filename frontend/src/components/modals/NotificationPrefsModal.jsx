// components/modals/NotificationPrefsModal.jsx — self-service in-app/push
// notification preferences. The backend (services/notificationPrefs.js +
// routes/notificationPrefs.js) was fully built — consumed by
// routes/alerts.js's notifyAdmins() and capacityForecast's fan-out — but
// had no UI, so every user was stuck with the defaults (in-app: all
// severities, push: warning+) with no way to mute or adjust either.
import React, { useState, useEffect } from 'react'
import { X, BellRing, Loader2, VolumeX, Volume2 } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

const SEVERITIES = [
  { value: 'info', label: 'All (info+)' },
  { value: 'warning', label: 'Warning+' },
  { value: 'critical', label: 'Critical only' },
]

const MUTE_OPTIONS = [
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '24 hours', minutes: 1440 },
]

function ChannelRow({ label, description, enabled, onToggleEnabled, severity, onSeverity }) {
  return (
    <div className="px-3 py-3 rounded-lg border" style={{ background: 'var(--bg-surface-3)', borderColor: 'var(--border-subtle)' }}>
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-sm font-body font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</p>
          <p className="text-[11px] font-body mt-0.5" style={{ color: 'var(--text-faint)' }}>{description}</p>
        </div>
        <button
          onClick={onToggleEnabled}
          className={`w-10 h-5 rounded-full transition-all duration-200 relative shrink-0 ml-3 ${enabled ? 'bg-accent-purple' : 'bg-surface-5'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'left-5' : 'left-0.5'}`} />
        </button>
      </div>
      {enabled && (
        <div className="flex items-center gap-1.5 mt-3">
          {SEVERITIES.map(s => (
            <button
              key={s.value}
              onClick={() => onSeverity(s.value)}
              className={`flex-1 text-[11px] py-1.5 px-2 rounded-lg font-body border transition-all ${
                severity === s.value ? 'bg-accent-purple/15 border-accent-purple/40 text-accent-purple' : ''
              }`}
              style={severity !== s.value ? { background: 'var(--bg-surface-4)', borderColor: 'var(--border-mid)', color: 'var(--text-muted)' } : {}}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function NotificationPrefsModal({ open, onClose }) {
  const [prefs, setPrefs] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    api.get('/notification-prefs')
      .then(({ data }) => setPrefs(data))
      .catch(() => toast.error('Failed to load notification preferences'))
      .finally(() => setLoading(false))
  }, [open])

  const save = async (patch) => {
    setSaving(true)
    const optimistic = { ...prefs, ...patch }
    setPrefs(optimistic) // optimistic — feels instant for toggles/severity clicks
    try {
      const { data } = await api.put('/notification-prefs', patch)
      setPrefs(data)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save')
      // Revert by re-fetching rather than guessing the prior state.
      api.get('/notification-prefs').then(({ data }) => setPrefs(data)).catch(() => {})
    } finally {
      setSaving(false)
    }
  }

  const mute = async (minutes) => {
    setSaving(true)
    try {
      const { data } = await api.post('/notification-prefs/mute', { minutes })
      setPrefs(data)
      toast.success(`Notifications muted for ${minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}`)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to mute')
    } finally { setSaving(false) }
  }

  const unmute = async () => {
    setSaving(true)
    try {
      const { data } = await api.post('/notification-prefs/unmute')
      setPrefs(data)
      toast.success('Notifications unmuted')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to unmute')
    } finally { setSaving(false) }
  }

  if (!open) return null

  const isMuted = prefs?.muted_until && Number(prefs.muted_until) > Math.floor(Date.now() / 1000)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="glass rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="h-0.5 bg-accent-purple opacity-60" />

          <div className="flex items-center justify-between px-6 py-5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-accent-purple/15 border border-accent-purple/25 flex items-center justify-center">
                <BellRing size={16} className="text-accent-purple" />
              </div>
              <h3 className="font-display" style={{ color: 'var(--text-primary)' }}>Notification Preferences</h3>
            </div>
            <button onClick={onClose} className="p-1" style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
          </div>

          {loading || !prefs ? (
            <div className="flex justify-center py-16">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : (
            <div className="p-6 space-y-4">
              {isMuted && (
                <div className="flex items-center justify-between px-3 py-2.5 rounded-lg"
                  style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)' }}>
                  <span className="flex items-center gap-2 text-xs font-body" style={{ color: '#fbbf24' }}>
                    <VolumeX size={13} />
                    Muted until {new Date(Number(prefs.muted_until) * 1000).toLocaleString()}
                  </span>
                  <button onClick={unmute} disabled={saving}
                    className="text-xs font-body font-medium px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10" style={{ color: '#fbbf24' }}>
                    Unmute
                  </button>
                </div>
              )}

              <ChannelRow
                label="In-app notifications"
                description="Shown in the bell dropdown while you're signed in"
                enabled={!!prefs.in_app_enabled}
                onToggleEnabled={() => save({ in_app_enabled: !prefs.in_app_enabled })}
                severity={prefs.in_app_min_severity}
                onSeverity={(v) => save({ in_app_min_severity: v })}
              />

              <ChannelRow
                label="Push notifications"
                description="Sent to your browser/device even when this tab isn't open"
                enabled={!!prefs.push_enabled}
                onToggleEnabled={() => save({ push_enabled: !prefs.push_enabled })}
                severity={prefs.push_min_severity}
                onSeverity={(v) => save({ push_min_severity: v })}
              />

              {!isMuted && (
                <div>
                  <label className="label flex items-center gap-1.5"><Volume2 size={12} /> Mute temporarily</label>
                  <div className="grid grid-cols-4 gap-2">
                    {MUTE_OPTIONS.map(m => (
                      <button key={m.minutes} onClick={() => mute(m.minutes)} disabled={saving}
                        className="text-xs py-2 px-2 rounded-lg font-body border transition-all disabled:opacity-40"
                        style={{ background: 'var(--bg-surface-3)', borderColor: 'var(--border-mid)', color: 'var(--text-muted)' }}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}