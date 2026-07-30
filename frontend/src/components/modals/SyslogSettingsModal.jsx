import React, { useState, useEffect } from 'react'
import { X, Radio, Loader2, Zap, CheckCircle2, XCircle } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import { getErrorMessage } from '../../lib/errors'

const EMPTY = {
  enabled: false,
  host: '',
  port: 514,
  protocol: 'udp',
}

export default function SyslogSettingsModal({ open, onClose, onSaved }) {
  const [form, setForm]         = useState(EMPTY)
  const [loading, setLoading]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [testing, setTesting]   = useState(false)
  const [testResult, setTestResult] = useState(null) // { ok, error } | null
  const [runtime, setRuntime]   = useState(null)

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setTestResult(null) }

  const load = async () => {
    setLoading(true)
    try {
      const [{ data: cfg }, { data: status }] = await Promise.all([
        api.get('/audit/syslog/config'),
        api.get('/audit/syslog/status'),
      ])
      setForm({
        enabled: !!cfg.enabled,
        host: cfg.host || '',
        port: cfg.port || 514,
        protocol: cfg.protocol === 'tcp' ? 'tcp' : 'udp',
      })
      setRuntime(status.runtime || null)
    } catch {
      toast.error('Failed to load syslog configuration')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      setTestResult(null)
      load()
    }
  }, [open])

  const handleSave = async () => {
    if (form.enabled && !form.host.trim()) {
      toast.error('A host is required to enable syslog forwarding')
      return
    }
    setSaving(true)
    try {
      const { data } = await api.put('/audit/syslog/config', form)
      setForm({
        enabled: !!data.enabled,
        host: data.host || '',
        port: data.port || 514,
        protocol: data.protocol === 'tcp' ? 'tcp' : 'udp',
      })
      toast.success('Syslog settings saved')
      onSaved?.()
    } catch (err) {
      toast.error(getErrorMessage(err, 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const { data } = await api.post('/audit/syslog/test')
      setTestResult(data)
      if (data.ok) toast.success('Test message sent successfully')
      else toast.error(data.error || 'Test message failed')
    } catch (err) {
      const data = err.response?.data
      setTestResult({ ok: false, error: data?.error || 'Test failed' })
      toast.error(data?.error || 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 modal-backdrop" />
      <div className="relative z-10 w-full max-w-md animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="glass rounded-2xl overflow-hidden">
          <div className="h-0.5 bg-accent-cyan opacity-60" />

          <div className="flex items-center justify-between px-6 py-5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-accent-cyan/15 border border-accent-cyan/25 flex items-center justify-center">
                <Radio size={16} className="text-accent-cyan" />
              </div>
              <div>
                <h3 className="font-display" style={{ color: 'var(--text-primary)' }}>Syslog Forwarding</h3>
                <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>Sync the audit log to your syslog server (RFC 5424)</p>
              </div>
            </div>
            <button onClick={onClose} className="icon-btn p-1"><X size={16} /></button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : (
            <div className="p-6 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">

              {/* Enable toggle */}
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg glass-sm">
                <div>
                  <p className="text-sm font-body" style={{ color: 'var(--text-primary)' }}>Enable syslog forwarding</p>
                  <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>Every audit event is sent as a message in real time</p>
                </div>
                <button
                  onClick={() => set('enabled', !form.enabled)}
                  className={`w-10 h-5 rounded-full transition-all duration-200 relative shrink-0 ${form.enabled ? 'bg-accent-cyan' : ''}`}
                  style={!form.enabled ? { background: 'var(--bg-surface-4)' } : {}}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${form.enabled ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="label">Syslog Server Host</label>
                  <input className="input-field" placeholder="e.g. 10.0.0.5 or syslog.local"
                    value={form.host} onChange={e => set('host', e.target.value)} />
                </div>
                <div>
                  <label className="label">Port</label>
                  <input type="number" className="input-field" placeholder="514"
                    value={form.port} onChange={e => set('port', e.target.value)} />
                </div>
              </div>

              <div>
                <label className="label">Transport Protocol</label>
                <select className="input-field" value={form.protocol} onChange={e => set('protocol', e.target.value)}>
                  <option value="udp">UDP (simple, fire-and-forget)</option>
                  <option value="tcp">TCP (reliable, octet-counted framing)</option>
                </select>
              </div>

              {/* Runtime stats */}
              {runtime && (
                <div className="flex items-center gap-4 px-3 py-2 rounded-lg glass-sm text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
                  <span className="text-accent-green">{runtime.sent} sent</span>
                  <span className="text-accent-red">{runtime.failed} failed</span>
                  {runtime.lastError && <span className="truncate" style={{ color: 'var(--text-faint)' }} title={runtime.lastError}>Last error: {runtime.lastError}</span>}
                </div>
              )}

              {/* Test result */}
              {testResult && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-body ${
                  testResult.ok
                    ? 'bg-accent-green/10 border-accent-green/25 text-accent-green'
                    : 'bg-accent-red/10 border-accent-red/25 text-accent-red'
                }`}>
                  {testResult.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                  {testResult.ok ? 'Test message sent successfully' : (testResult.error || 'Test message failed')}
                </div>
              )}

              <button
                onClick={handleTest}
                disabled={testing || !form.host.trim()}
                className="btn-ghost justify-center disabled:opacity-40"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                Send Test Message
              </button>
            </div>
          )}

          <div className="flex gap-3 px-6 pb-6">
            <button onClick={onClose} className="btn-ghost flex-1 justify-center" disabled={saving}>Cancel</button>
            <button onClick={handleSave}
              className="flex-1 justify-center flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg transition-all duration-200 text-sm bg-accent-cyan/20 hover:bg-accent-cyan/30 text-accent-cyan border border-accent-cyan/30"
              disabled={saving || loading}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}