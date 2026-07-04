import React, { useState, useEffect } from 'react'
import { X, Radio, Loader2, Eye, EyeOff, Zap, CheckCircle2, XCircle } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

const MASKED = '••••••••'

const EMPTY = {
  enabled: false,
  host: '',
  port: 162,
  community: '',
  version: '2c',
}

export default function SnmpSettingsModal({ open, onClose, onSaved }) {
  const [form, setForm]         = useState(EMPTY)
  const [loading, setLoading]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [testing, setTesting]   = useState(false)
  const [showCommunity, setShowCommunity] = useState(false)
  const [testResult, setTestResult] = useState(null) // { ok, error } | null
  const [runtime, setRuntime]   = useState(null)

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setTestResult(null) }

  const load = async () => {
    setLoading(true)
    try {
      const [{ data: cfg }, { data: status }] = await Promise.all([
        api.get('/audit/snmp/config'),
        api.get('/audit/snmp/status'),
      ])
      setForm({
        enabled: !!cfg.enabled,
        host: cfg.host || '',
        port: cfg.port || 162,
        community: cfg.communitySet ? MASKED : '',
        version: cfg.version === '1' ? '1' : '2c',
      })
      setRuntime(status.runtime || null)
    } catch {
      toast.error('Failed to load SNMP configuration')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      setTestResult(null)
      setShowCommunity(false)
      load()
    }
  }, [open])

  const handleSave = async () => {
    if (form.enabled && !form.host.trim()) {
      toast.error('A host is required to enable SNMP forwarding')
      return
    }
    setSaving(true)
    try {
      const body = { ...form }
      if (body.community === MASKED) delete body.community // keep existing stored value
      const { data } = await api.put('/audit/snmp/config', body)
      setForm(f => ({ ...f, community: data.community ? MASKED : '' }))
      toast.success('SNMP settings saved')
      onSaved?.()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const { data } = await api.post('/audit/snmp/test')
      setTestResult(data)
      if (data.ok) toast.success('Test trap sent successfully')
      else toast.error(data.error || 'Test trap failed')
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
                <h3 className="font-display" style={{ color: 'var(--text-primary)' }}>SNMP Forwarding</h3>
                <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>Sync the audit log to your NMS as SNMP traps</p>
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
                  <p className="text-sm font-body" style={{ color: 'var(--text-primary)' }}>Enable SNMP forwarding</p>
                  <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>Every audit event is sent as a trap in real time</p>
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
                  <label className="label">SNMP Server Host</label>
                  <input className="input-field" placeholder="e.g. 10.0.0.5 or nms.local"
                    value={form.host} onChange={e => set('host', e.target.value)} />
                </div>
                <div>
                  <label className="label">Port</label>
                  <input type="number" className="input-field" placeholder="162"
                    value={form.port} onChange={e => set('port', e.target.value)} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Community String</label>
                  <div className="relative">
                    <input
                      type={showCommunity ? 'text' : 'password'}
                      className="input-field pr-9"
                      placeholder="public"
                      value={form.community}
                      onFocus={() => { if (form.community === MASKED) set('community', '') }}
                      onChange={e => set('community', e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowCommunity(v => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {showCommunity ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="label">SNMP Version</label>
                  <select className="input-field" value={form.version} onChange={e => set('version', e.target.value)}>
                    <option value="2c">v2c</option>
                    <option value="1">v1</option>
                  </select>
                </div>
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
                  {testResult.ok ? 'Test trap sent successfully' : (testResult.error || 'Test trap failed')}
                </div>
              )}

              <button
                onClick={handleTest}
                disabled={testing || !form.host.trim()}
                className="btn-ghost justify-center disabled:opacity-40"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                Send Test Trap
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