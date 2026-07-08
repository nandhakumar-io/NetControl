import React, { useState, useEffect, useCallback } from 'react'
import {
  Shield, Plus, Trash2, Pencil, X, Check, RefreshCw,
  Globe, Lock, Wifi, Bell, Zap, AlertTriangle, CheckCircle2,
  ChevronRight, Copy, ExternalLink, ToggleLeft, ToggleRight,
  Send, Clock, XCircle, Activity, Eye, EyeOff, Server,
  Network, UserX, Key
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import { useThemeStore } from '../store/themeStore'
import { useAuthStore } from '../store/authStore'

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
function ago(ts) {
  if (!ts) return '—'
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  if (s < 86400) return `${Math.floor(s/3600)}h ago`
  return formatTs(ts)
}

const PROVIDERS = [
  { value: 'slack',    label: 'Slack',        color: '#4A154B', icon: '💬' },
  { value: 'teams',    label: 'MS Teams',     color: '#5059C9', icon: '🟦' },
  { value: 'telegram', label: 'Telegram',     color: '#26A5E4', icon: '✈️' },
  { value: 'generic',  label: 'Generic JSON', color: '#64748b', icon: '🔗' },
]

const ALL_EVENTS = {
  'device.offline':          { label: 'Device Offline',          color: '#f87171', cat: 'device' },
  'device.online':           { label: 'Device Online',           color: '#34d399', cat: 'device' },
  'device.wake':             { label: 'Wake-on-LAN sent',        color: '#34d399', cat: 'device' },
  'device.shutdown':         { label: 'Shutdown sent',           color: '#fb923c', cat: 'device' },
  'device.restart':          { label: 'Restart sent',            color: '#facc15', cat: 'device' },
  'auth.login':              { label: 'Login success',           color: '#34d399', cat: 'auth'   },
  'auth.login_failed':       { label: 'Login failed',            color: '#f87171', cat: 'auth'   },
  'auth.ip_blocked':         { label: 'IP blocked',              color: '#f87171', cat: 'auth'   },
  'alert.triggered':         { label: 'Alert triggered',         color: '#facc15', cat: 'alert'  },
  'alert.critical':          { label: 'Critical alert',          color: '#f87171', cat: 'alert'  },
  'alert.resolved':          { label: 'Alert resolved',          color: '#34d399', cat: 'alert'  },
  'alert.flapping':          { label: 'Alert flapping',          color: '#fb923c', cat: 'alert'  },
  'alert.escalated':         { label: 'Alert escalated',         color: '#f87171', cat: 'alert'  },
  'file.push':               { label: 'File pushed',             color: '#a78bfa', cat: 'system' },
  'ssh.failure':             { label: 'SSH failure',             color: '#f87171', cat: 'system' },
  'system.agent_registered': { label: 'Agent registered',        color: '#38bdf8', cat: 'system' },
}

// ── Field wrapper ─────────────────────────────────────────────────────────────
const F = ({ label, hint, children }) => (
  <div>
    <label className="label">{label}</label>
    {children}
    {hint && <p className="text-[11px] font-body mt-1" style={{ color: 'var(--text-muted)' }}>{hint}</p>}
  </div>
)

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({ value, onChange }) {
  return (
    <button onClick={() => onChange(!value)} className="shrink-0">
      {value
        ? <ToggleRight size={22} style={{ color: '#6c5ce7' }} />
        : <ToggleLeft  size={22} style={{ color: 'var(--text-muted)' }} />}
    </button>
  )
}

// ── Status dot ────────────────────────────────────────────────────────────────
function StatusDot({ status }) {
  if (status >= 200 && status < 300) return <span className="text-[10px] font-mono text-accent-green">✓ {status}</span>
  if (!status || status === 0)        return <span className="text-[10px] font-mono text-slate-500">—</span>
  return <span className="text-[10px] font-mono text-accent-red">✗ {status}</span>
}

// ─────────────────────────────────────────────────────────────────────────────
// IP ALLOWLIST SECTION
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_IP = { cidr: '', label: '', user_id: '', role: '', enabled: true }

function IPRuleModal({ rule, users, onSave, onClose }) {
  const [form, setForm] = useState(rule ? { cidr: rule.cidr, label: rule.label || '', user_id: rule.user_id || '', role: rule.role || '', enabled: !!rule.enabled } : EMPTY_IP)
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    if (!form.cidr.trim()) { toast.error('CIDR is required'); return }
    setSaving(true)
    try {
      const payload = {
        cidr:    form.cidr.trim(),
        label:   form.label || null,
        user_id: form.user_id || null,
        role:    form.role || null,
        enabled: form.enabled,
      }
      if (rule?.id) await api.put(`/security/ip-allowlist/${rule.id}`, payload)
      else          await api.post('/security/ip-allowlist', payload)
      toast.success(rule?.id ? 'Rule updated' : 'Rule added')
      onSave(); onClose()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md rounded-2xl overflow-hidden animate-slide-up"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ height: 3, background: 'linear-gradient(90deg,#38bdf8,#34d399)' }} />
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.25)' }}>
              <Network size={14} style={{ color: '#38bdf8' }} />
            </div>
            <p className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>
              {rule?.id ? 'Edit IP Rule' : 'Add IP Range'}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:text-accent-red transition-colors" style={{ color: 'var(--text-muted)' }}>
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <F label="IP / CIDR Range" hint="Examples: 192.168.1.0/24 or 10.0.5.25">
            <input className="input-field font-mono" placeholder="192.168.1.0/24"
              value={form.cidr} onChange={e => set('cidr', e.target.value)} />
          </F>
          <F label="Label (optional)">
            <input className="input-field" placeholder="e.g. College WiFi network"
              value={form.label} onChange={e => set('label', e.target.value)} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Apply to user (optional)">
              <select className="input-field" value={form.user_id} onChange={e => set('user_id', e.target.value)}>
                <option value="">All users</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
              </select>
            </F>
            <F label="Apply to role (optional)">
              <select className="input-field" value={form.role} onChange={e => set('role', e.target.value)}>
                <option value="">All roles</option>
                {['admin', 'operator', 'viewer'].map(r => <option key={r} value={r} className="capitalize">{r}</option>)}
              </select>
            </F>
          </div>
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle value={form.enabled} onChange={v => set('enabled', v)} />
            <span className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>Rule enabled</span>
          </label>
          <div className="text-[11px] font-body p-3 rounded-xl" style={{ background: 'rgba(56,189,248,0.07)', border: '1px solid rgba(56,189,248,0.2)', color: 'var(--text-secondary)' }}>
            <strong style={{ color: '#38bdf8' }}>Scoping order:</strong> User-specific rules override role rules, which override global rules. If no rules match, access is allowed. Loopback (127.0.0.1) is always permitted.
          </div>
        </div>

        <div className="flex gap-2 px-5 py-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary flex-1 justify-center disabled:opacity-40">
            {saving ? 'Saving…' : rule?.id ? 'Update Rule' : 'Add Rule'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK SECTION
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_WH = { name: '', url: '', provider: 'generic', secret: '', chatId: '', minSeverity: 'info', events: [], enabled: true }

function WebhookModal({ hook, onSave, onClose }) {
  const [form, setForm] = useState(hook
    ? { name: hook.name, url: hook.url, provider: hook.provider, secret: '', chatId: hook.chat_id || '', minSeverity: hook.min_severity || 'info', events: JSON.parse(hook.events || '[]'), enabled: !!hook.enabled }
    : EMPTY_WH)
  const [saving, setSaving] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [customEvent, setCustomEvent] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const toggleEvent = (ev) => setForm(f => ({
    ...f, events: f.events.includes(ev) ? f.events.filter(e => e !== ev) : [...f.events, ev]
  }))

  const addCustomEvent = () => {
    const ev = customEvent.trim().toLowerCase().replace(/\s+/g, '_')
    if (!ev) return
    if (form.events.includes(ev)) { toast.error('Event already added'); return }
    setForm(f => ({ ...f, events: [...f.events, ev] }))
    setCustomEvent('')
  }
  const removeCustomEvent = (ev) => setForm(f => ({ ...f, events: f.events.filter(e => e !== ev) }))
  const setCategory = (cat, checked) => {
    const catEvents = Object.keys(ALL_EVENTS).filter(k => ALL_EVENTS[k].cat === cat)
    setForm(f => ({
      ...f, events: checked
        ? [...new Set([...f.events, ...catEvents])]
        : f.events.filter(e => !catEvents.includes(e))
    }))
  }

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name required'); return }
    if (!form.url.trim())  { toast.error('URL required'); return }
    if (form.provider === 'telegram' && !form.chatId.trim()) { toast.error('Chat ID required for Telegram'); return }
    if (!form.events.length) { toast.error('Select at least one event'); return }
    setSaving(true)
    try {
      const payload = { ...form, secret: form.secret || null }
      if (hook?.id) await api.put(`/security/webhooks/${hook.id}`, payload)
      else          await api.post('/security/webhooks', payload)
      toast.success(hook?.id ? 'Webhook updated' : 'Webhook created')
      onSave(); onClose()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed') }
    finally { setSaving(false) }
  }

  const cats = [...new Set(Object.values(ALL_EVENTS).map(e => e.cat))]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg rounded-2xl overflow-hidden animate-slide-up max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ height: 3, background: 'linear-gradient(90deg,#a78bfa,#c084fc)' }} />
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)' }}>
              <Bell size={14} style={{ color: '#a78bfa' }} />
            </div>
            <p className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>
              {hook?.id ? 'Edit Webhook' : 'New Webhook'}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:text-accent-red" style={{ color: 'var(--text-muted)' }}>
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <F label="Webhook name">
              <input className="input-field" placeholder="e.g. Slack #alerts"
                value={form.name} onChange={e => set('name', e.target.value)} />
            </F>
            <F label="Provider">
              <select className="input-field" value={form.provider} onChange={e => set('provider', e.target.value)}>
                {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.icon} {p.label}</option>)}
              </select>
            </F>
          </div>

          <F label="Webhook URL" hint={
            form.provider === 'slack' ? 'Slack: Settings → Integrations → Incoming Webhooks' :
            form.provider === 'teams' ? 'Teams: Channel → Connectors → Incoming Webhook' :
            form.provider === 'telegram' ? 'Message @BotFather on Telegram to create a bot and get its token, then use https://api.telegram.org/bot<TOKEN> here (no trailing /sendMessage)' :
            'Any URL accepting a POST with JSON body'
          }>
            <input className="input-field font-mono text-xs" placeholder={form.provider === 'telegram' ? 'https://api.telegram.org/bot123456:ABC-token' : 'https://hooks.slack.com/services/…'}
              value={form.url} onChange={e => set('url', e.target.value)} />
          </F>

          {form.provider === 'telegram' && (
            <F label="Chat ID" hint="Message your bot once, then visit https://api.telegram.org/bot<TOKEN>/getUpdates to find the numeric chat id (group chats are negative numbers).">
              <input className="input-field font-mono text-xs" placeholder="e.g. 123456789 or -1001234567890"
                value={form.chatId} onChange={e => set('chatId', e.target.value)} />
            </F>
          )}

          <F label="Minimum severity" hint="Events below this severity are skipped for this destination — e.g. send everything to Slack but only critical to Telegram.">
            <select className="input-field" value={form.minSeverity} onChange={e => set('minSeverity', e.target.value)}>
              <option value="info">Info and above (everything)</option>
              <option value="warning">Warning and above</option>
              <option value="critical">Critical only</option>
            </select>
          </F>

          {form.provider !== 'telegram' && (
            <F label="Signing secret (optional)" hint="If set, deliveries include X-NetControl-Signature: sha256=... header">
              <div className="relative">
                <input type={showSecret ? 'text' : 'password'} className="input-field pr-10"
                  placeholder="Optional HMAC secret" value={form.secret} onChange={e => set('secret', e.target.value)} />
                <button onClick={() => setShowSecret(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }}>
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </F>
          )}
          {/* Event selector */}
          <div>
            <label className="label">Events to subscribe to</label>
            <div className="space-y-3">
              {cats.map(cat => {
                const catEvents = Object.keys(ALL_EVENTS).filter(k => ALL_EVENTS[k].cat === cat)
                const allOn = catEvents.every(e => form.events.includes(e))
                return (
                  <div key={cat}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <button onClick={() => setCategory(cat, !allOn)}
                        className="text-[10px] font-body font-bold uppercase tracking-widest flex items-center gap-1"
                        style={{ color: allOn ? '#a78bfa' : 'var(--text-muted)' }}>
                        {allOn ? <CheckCircle2 size={11} style={{ color: '#a78bfa' }} /> : <div className="w-3 h-3 rounded-full border" style={{ borderColor: 'var(--text-muted)' }} />}
                        {cat}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pl-4">
                      {catEvents.map(ev => {
                        const cfg = ALL_EVENTS[ev]
                        const on  = form.events.includes(ev)
                        return (
                          <button key={ev} onClick={() => toggleEvent(ev)}
                            className="text-[10px] font-body px-2 py-1 rounded-lg border transition-all"
                            style={{
                              background: on ? `${cfg.color}15` : 'var(--bg-input)',
                              borderColor: on ? `${cfg.color}40` : 'var(--border-subtle)',
                              color: on ? cfg.color : 'var(--text-muted)',
                            }}>
                            {cfg.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Custom event names — for alert rules or integrations not in the built-in list */}
          <div>
            <label className="label">Custom event name</label>
            <div className="flex gap-2">
              <input className="input-field font-mono text-xs" placeholder="e.g. alert.disk_critical"
                value={customEvent}
                onChange={e => setCustomEvent(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomEvent() } }} />
              <button onClick={addCustomEvent} type="button"
                className="btn-ghost px-3 shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
                <Plus size={14} />
              </button>
            </div>
            <p className="text-[11px] font-body mt-1" style={{ color: 'var(--text-muted)' }}>
              Add any event key your alert rules or scripts fire (e.g. a custom alert action). It'll be matched
              exactly against the event name sent when firing a webhook, or use <code>*</code> to receive every event.
            </p>
            {form.events.filter(e => !ALL_EVENTS[e]).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {form.events.filter(e => !ALL_EVENTS[e]).map(ev => (
                  <span key={ev}
                    className="text-[10px] font-mono px-2 py-1 rounded-lg border flex items-center gap-1.5"
                    style={{ background: 'rgba(167,139,250,0.1)', borderColor: 'rgba(167,139,250,0.3)', color: '#a78bfa' }}>
                    {ev}
                    <button onClick={() => removeCustomEvent(ev)} type="button" className="hover:text-accent-red">
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle value={form.enabled} onChange={v => set('enabled', v)} />
            <span className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>Webhook enabled</span>
          </label>
        </div>

        <div className="flex gap-2 px-5 py-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary flex-1 justify-center disabled:opacity-40">
            {saving ? 'Saving…' : hook?.id ? 'Update' : 'Create Webhook'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Webhook delivery log panel ────────────────────────────────────────────────
function DeliveryLog({ hookId, hookName, onClose }) {
  const [log, setLog] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    api.get(`/security/webhooks/${hookId}/log`)
      .then(r => setLog(r.data))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load delivery log'))
      .finally(() => setLoading(false))
  }, [hookId])

  useEffect(() => { load() }, [load])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg rounded-2xl overflow-hidden animate-slide-up"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <p className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>
            Delivery Log — {hookName}
          </p>
          <div className="flex items-center gap-1">
            <button onClick={load} className="icon-btn p-1.5" title="Refresh">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
          </div>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {loading ? (
            <div className="py-10 text-center"><RefreshCw size={16} className="animate-spin mx-auto" style={{ color: 'var(--text-muted)' }} /></div>
          ) : log.length === 0 ? (
            <div className="py-10 text-center opacity-40">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No deliveries yet</p>
            </div>
          ) : log.map((entry, i) => (
            <div key={entry.id} className="px-5 py-3"
              style={{ borderBottom: i < log.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
              <div className="flex items-start gap-3 cursor-pointer"
                onClick={() => setExpanded(x => x === entry.id ? null : entry.id)}>
                <StatusDot status={entry.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{entry.event}</p>
                  {entry.error && <p className="text-[10px] font-body text-accent-red mt-0.5 truncate">{entry.error}</p>}
                  <p className="text-[9px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {entry.duration_ms != null ? `${entry.duration_ms}ms · ` : ''}{ago(entry.fired_at)}
                  </p>
                </div>
              </div>
              {expanded === entry.id && entry.response_body && (
                <pre className="text-[10px] font-mono mt-2 p-2 rounded-lg overflow-x-auto"
                  style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', maxHeight: 160 }}>
                  {entry.response_body}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function SecurityPage() {
  const [tab, setTab] = useState('ip')  // 'ip' | 'webhooks'

  // IP state
  const [ipRules,    setIpRules]    = useState([])
  const [blockedLog, setBlockedLog] = useState([])
  const [ipLoading,  setIpLoading]  = useState(true)
  const [ipModal,    setIpModal]    = useState(null)    // null | 'new' | rule
  const [testIp,     setTestIp]     = useState('')
  const [testRole,   setTestRole]   = useState('operator')
  const [testResult, setTestResult] = useState(null)
  const [users,      setUsers]      = useState([])

  // Webhook state
  const [hooks,      setHooks]      = useState([])
  const [whLoading,  setWhLoading]  = useState(true)
  const [whModal,    setWhModal]    = useState(null)    // null | 'new' | hook
  const [logTarget,  setLogTarget]  = useState(null)
  const [testing,    setTesting]    = useState(null)

  const isLight = useThemeStore(s => s.theme === 'light')

  const loadIP = useCallback(async () => {
    setIpLoading(true)
    try {
      const [r, b, u] = await Promise.all([
        api.get('/security/ip-allowlist'),
        api.get('/security/ip-allowlist/blocked'),
        api.get('/users'),
      ])
      setIpRules(r.data); setBlockedLog(b.data); setUsers(u.data)
    } catch { toast.error('Failed to load IP rules') }
    finally { setIpLoading(false) }
  }, [])

  const loadWebhooks = useCallback(async () => {
    setWhLoading(true)
    try {
      const { data } = await api.get('/security/webhooks')
      setHooks(data)
    } catch { toast.error('Failed to load webhooks') }
    finally { setWhLoading(false) }
  }, [])

  useEffect(() => { loadIP(); loadWebhooks() }, [loadIP, loadWebhooks])

  const deleteIPRule = async (id) => {
    try { await api.delete(`/security/ip-allowlist/${id}`); toast.success('Rule deleted'); loadIP() }
    catch (e) { toast.error(e.response?.data?.error || 'Delete failed') }
  }

  const deleteWebhook = async (id) => {
    try { await api.delete(`/security/webhooks/${id}`); toast.success('Webhook deleted'); loadWebhooks() }
    catch (e) { toast.error(e.response?.data?.error || 'Delete failed') }
  }

  const testWebhook = async (hook) => {
    setTesting(hook.id)
    try {
      const { data } = await api.post(`/security/webhooks/${hook.id}/test`)
      const r = data.results?.[0]
      // BUG FIX: `!r?.error` used to read as success even when `r` itself
      // was undefined (empty results array), so a suppressed test silently
      // showed "Test sent — HTTP ?" instead of a failure.
      if (!r || r.error) toast.error(`Test failed: ${r?.error || 'No delivery attempted'}`)
      else toast.success(`Test sent — HTTP ${r.status || '?'}`)
    } catch (e) { toast.error(e.response?.data?.error || 'Test failed') }
    finally { setTesting(null); loadWebhooks() }
  }

  const testIPCheck = async () => {
    if (!testIp.trim()) { toast.error('Enter an IP to test'); return }
    try {
      const { data } = await api.post('/security/ip-allowlist/test', { ip: testIp.trim(), role: testRole })
      setTestResult(data)
    } catch (e) { toast.error(e.response?.data?.error || 'Test failed') }
  }

  const toggleIPRule = async (rule) => {
    try {
      await api.put(`/security/ip-allowlist/${rule.id}`, { enabled: !rule.enabled })
      loadIP()
    } catch { toast.error('Update failed') }
  }

  const toggleWebhook = async (hook) => {
    try {
      await api.put(`/security/webhooks/${hook.id}`, { enabled: !hook.enabled })
      loadWebhooks()
    } catch { toast.error('Update failed') }
  }

  return (
    <div className="p-6 max-w-[1200px] mx-auto animate-fade-in pb-10">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isLight ? 'bg-[#6c5ce7] text-white' : 'bg-brand-500/20 border border-brand-500/30 text-brand-400'}`}>
            <Shield size={18} />
          </div>
          <div>
            <h1 className="text-xl font-display font-bold" style={{ color: 'var(--text-primary)' }}>Security</h1>
            <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>IP allowlists and webhook notifications</p>
          </div>
        </div>
        <button onClick={() => tab === 'ip' ? setIpModal('new') : setWhModal('new')} className="btn-primary">
          <Plus size={14} /> {tab === 'ip' ? 'Add IP Rule' : 'New Webhook'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit mb-6" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
        {[['ip', Network, 'IP Allowlist'], ['webhooks', Bell, 'Webhooks']].map(([t, Icon, lbl]) => (
          <button key={t} onClick={() => setTab(t)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-body font-medium transition-all"
            style={{
              background: tab === t ? (isLight ? '#6c5ce7' : 'var(--bg-card)') : 'transparent',
              color: tab === t ? (isLight ? '#fff' : 'var(--text-primary)') : 'var(--text-muted)',
              boxShadow: tab === t && !isLight ? '0 1px 4px rgba(0,0,0,0.3)' : 'none',
            }}>
            <Icon size={13} /> {lbl}
          </button>
        ))}
      </div>

      {/* ── IP ALLOWLIST TAB ─────────────────────────────────────────────── */}
      {tab === 'ip' && (
        <div className="space-y-5">

          {/* Info banner */}
          <div className="glass rounded-2xl p-4 flex items-start gap-3"
            style={{ border: '1px solid rgba(56,189,248,0.2)' }}>
            <Network size={16} style={{ color: '#38bdf8', flexShrink: 0, marginTop: 2 }} />
            <div>
              <p className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>How IP allowlisting works</p>
              <p className="text-xs font-body mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                When no rules exist, all logins are permitted. Once you add rules, logins from IPs that don't match any rule are blocked.
                Rules are matched in order: user-specific → role → global. Loopback (127.0.0.1) is always allowed.
                Use CIDR notation to allow entire subnets (e.g. <code className="font-mono">192.168.0.0/16</code> for all 192.168.x.x addresses).
              </p>
            </div>
          </div>

          {/* IP test tool */}
          <div className="glass rounded-2xl p-5">
            <p className="text-xs font-body font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-muted)' }}>
              Test IP Access
            </p>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="flex-1 min-w-[160px]">
                <label className="label">IP Address</label>
                <input className="input-field font-mono" placeholder="192.168.1.50"
                  value={testIp} onChange={e => setTestIp(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && testIPCheck()} />
              </div>
              <div>
                <label className="label">Role</label>
                <select className="input-field" value={testRole} onChange={e => setTestRole(e.target.value)}>
                  {['admin', 'operator', 'viewer'].map(r => <option key={r} value={r} className="capitalize">{r}</option>)}
                </select>
              </div>
              <button onClick={testIPCheck} className="btn-primary h-[42px]"><Zap size={13} /> Test</button>
            </div>
            {testResult && (
              <div className="mt-3 flex items-center gap-3 px-4 py-3 rounded-xl"
                style={{
                  background: testResult.allowed ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
                  border: `1px solid ${testResult.allowed ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}`,
                }}>
                {testResult.allowed
                  ? <CheckCircle2 size={16} style={{ color: '#34d399', flexShrink: 0 }} />
                  : <XCircle size={16} style={{ color: '#f87171', flexShrink: 0 }} />
                }
                <div>
                  <p className="text-sm font-body font-semibold" style={{ color: testResult.allowed ? '#34d399' : '#f87171' }}>
                    {testResult.allowed ? `✓ ${testResult.ip} would be allowed` : `✗ ${testResult.ip} would be blocked`}
                  </p>
                  <p className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                    reason: {testResult.reason}
                    {testResult.rule?.label ? ` — "${testResult.rule.label}"` : ''}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Rules table */}
          <div className="glass rounded-2xl overflow-hidden">
            <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}>
              <p className="text-[10px] font-body font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                {ipRules.length} Rule{ipRules.length !== 1 ? 's' : ''}
              </p>
              <button onClick={loadIP} className="icon-btn p-1.5"><RefreshCw size={12} className={ipLoading ? 'animate-spin' : ''} /></button>
            </div>
            {ipLoading ? (
              <div className="py-10 text-center"><RefreshCw size={16} className="animate-spin mx-auto" style={{ color: 'var(--text-muted)' }} /></div>
            ) : ipRules.length === 0 ? (
              <div className="py-12 flex flex-col items-center gap-3 opacity-50">
                <Globe size={28} style={{ color: 'var(--text-muted)' }} />
                <div className="text-center">
                  <p className="text-sm font-body font-semibold" style={{ color: 'var(--text-muted)' }}>No IP rules configured</p>
                  <p className="text-xs font-body mt-1" style={{ color: 'var(--text-muted)' }}>All logins are currently permitted from any IP</p>
                </div>
                <button onClick={() => setIpModal('new')} className="btn-primary text-xs"><Plus size={12} /> Add first rule</button>
              </div>
            ) : ipRules.map((rule, i) => (
              <div key={rule.id} className="flex items-center gap-4 px-5 py-3.5 group transition-colors"
                style={{ borderBottom: i < ipRules.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <Toggle value={!!rule.enabled} onChange={() => toggleIPRule(rule)} />
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: rule.enabled ? 'rgba(52,211,153,0.12)' : 'var(--bg-input)', border: `1px solid ${rule.enabled ? 'rgba(52,211,153,0.3)' : 'var(--border-subtle)'}` }}>
                  <Network size={13} style={{ color: rule.enabled ? '#34d399' : 'var(--text-muted)' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono font-bold" style={{ color: 'var(--text-primary)' }}>{rule.cidr}</p>
                  <p className="text-[10px] font-body" style={{ color: 'var(--text-muted)' }}>
                    {rule.label || 'No label'}
                    {rule.username && <span> · user: <strong>{rule.username}</strong></span>}
                    {rule.role && <span> · role: <strong>{rule.role}</strong></span>}
                    {!rule.user_id && !rule.role && <span> · <em>global rule</em></span>}
                  </p>
                </div>
                <p className="text-[10px] font-mono hidden sm:block" style={{ color: 'var(--text-muted)' }}>{ago(rule.created_at)}</p>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => setIpModal(rule)} className="icon-btn p-1.5"><Pencil size={12} /></button>
                  <button onClick={() => deleteIPRule(rule.id)}
                    className="p-1.5 rounded-lg border transition-all hover:bg-accent-red/10 hover:text-accent-red hover:border-accent-red/20"
                    style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Blocked attempts log */}
          {blockedLog.length > 0 && (
            <div className="glass rounded-2xl overflow-hidden">
              <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}>
                <p className="text-[10px] font-body font-bold uppercase tracking-widest" style={{ color: '#f87171' }}>
                  Blocked Login Attempts ({blockedLog.length})
                </p>
              </div>
              {blockedLog.slice(0, 10).map((b, i) => (
                <div key={b.id} className="flex items-center gap-4 px-5 py-3"
                  style={{ borderBottom: i < Math.min(blockedLog.length - 1, 9) ? '1px solid var(--border-subtle)' : 'none' }}>
                  <UserX size={13} style={{ color: '#f87171', flexShrink: 0 }} />
                  <span className="text-xs font-body font-semibold" style={{ color: 'var(--text-primary)' }}>{b.username || '—'}</span>
                  <span className="text-xs font-mono" style={{ color: '#f87171' }}>{b.ip}</span>
                  <span className="text-[10px] font-body flex-1 truncate" style={{ color: 'var(--text-muted)' }}>{b.reason}</span>
                  <span className="text-[9px] font-mono shrink-0" style={{ color: 'var(--text-faint)' }}>{ago(b.blocked_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── WEBHOOKS TAB ─────────────────────────────────────────────────── */}
      {tab === 'webhooks' && (
        <div className="space-y-5">

          {/* Info banner */}
          <div className="glass rounded-2xl p-4 flex items-start gap-3" style={{ border: '1px solid rgba(167,139,250,0.2)' }}>
            <Bell size={16} style={{ color: '#a78bfa', flexShrink: 0, marginTop: 2 }} />
            <div>
              <p className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>Webhook notifications</p>
              <p className="text-xs font-body mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Send real-time HTTP POST notifications to Slack, MS Teams, or any custom endpoint when events occur in NetControl.
                Each delivery is logged. Deliveries are concurrent — one failure doesn't block others.
                Set a signing secret to verify payload authenticity on your receiver side.
              </p>
            </div>
          </div>

          {/* Hooks list */}
          <div className="glass rounded-2xl overflow-hidden">
            <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-input)' }}>
              <p className="text-[10px] font-body font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                {hooks.length} Webhook{hooks.length !== 1 ? 's' : ''}
              </p>
              <button onClick={loadWebhooks} className="icon-btn p-1.5"><RefreshCw size={12} className={whLoading ? 'animate-spin' : ''} /></button>
            </div>

            {whLoading ? (
              <div className="py-10 text-center"><RefreshCw size={16} className="animate-spin mx-auto" style={{ color: 'var(--text-muted)' }} /></div>
            ) : hooks.length === 0 ? (
              <div className="py-12 flex flex-col items-center gap-3 opacity-50">
                <Bell size={28} style={{ color: 'var(--text-muted)' }} />
                <div className="text-center">
                  <p className="text-sm font-body font-semibold" style={{ color: 'var(--text-muted)' }}>No webhooks configured</p>
                  <p className="text-xs font-body mt-1" style={{ color: 'var(--text-muted)' }}>Add a webhook to start receiving notifications</p>
                </div>
                <button onClick={() => setWhModal('new')} className="btn-primary text-xs"><Plus size={12} /> New Webhook</button>
              </div>
            ) : hooks.map((hook, i) => {
              const prov   = PROVIDERS.find(p => p.value === hook.provider) || PROVIDERS.find(p => p.value === 'generic')
              const events = (() => { try { return JSON.parse(hook.events) } catch { return [] } })()
              return (
                <div key={hook.id} className="flex items-center gap-4 px-5 py-4 group transition-colors"
                  style={{ borderBottom: i < hooks.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <Toggle value={!!hook.enabled} onChange={() => toggleWebhook(hook)} />
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-base"
                    style={{ background: `${prov.color}15`, border: `1px solid ${prov.color}30` }}>
                    {prov.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>{hook.name}</p>
                      <StatusDot status={hook.last_status} />
                      {hook.fail_count > 0 && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-bold text-accent-red" style={{ background: 'rgba(248,113,113,0.12)' }}>
                          {hook.fail_count} fail{hook.fail_count > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] font-mono truncate mt-0.5" style={{ color: 'var(--text-muted)', maxWidth: 260 }}>{hook.url}</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {events.slice(0, 4).map(ev => {
                        const cfg = ALL_EVENTS[ev]
                        return (
                          <span key={ev} className="text-[9px] px-1.5 py-0.5 rounded font-body"
                            style={cfg
                              ? { background: `${cfg.color}12`, color: cfg.color }
                              : { background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                            {cfg ? cfg.label : ev}
                          </span>
                        )
                      })}
                      {events.length > 4 && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: 'var(--text-muted)', background: 'var(--bg-input)' }}>+{events.length - 4}</span>}
                    </div>
                  </div>
                  {hook.last_fired && (
                    <p className="text-[9px] font-mono hidden sm:block shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {ago(hook.last_fired)}
                    </p>
                  )}
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => testWebhook(hook)} disabled={testing === hook.id}
                      title="Send test" className="icon-btn p-1.5 disabled:opacity-40">
                      {testing === hook.id ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}
                    </button>
                    <button onClick={() => setLogTarget(hook)} title="Delivery log" className="icon-btn p-1.5">
                      <Activity size={12} />
                    </button>
                    <button onClick={() => setWhModal(hook)} className="icon-btn p-1.5">
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => deleteWebhook(hook.id)}
                      className="p-1.5 rounded-lg border transition-all hover:bg-accent-red/10 hover:text-accent-red hover:border-accent-red/20"
                      style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      {ipModal && (
        <IPRuleModal
          rule={ipModal === 'new' ? null : ipModal}
          users={users}
          onSave={loadIP}
          onClose={() => setIpModal(null)}
        />
      )}
      {whModal && (
        <WebhookModal
          hook={whModal === 'new' ? null : whModal}
          onSave={loadWebhooks}
          onClose={() => setWhModal(null)}
        />
      )}
      {logTarget && (
        <DeliveryLog hookId={logTarget.id} hookName={logTarget.name} onClose={() => setLogTarget(null)} />
      )}
    </div>
  )
}