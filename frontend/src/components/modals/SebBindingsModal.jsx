// components/modals/SebBindingsModal.jsx
// Bind a NetControl device to its SEB client once, instead of relying on
// IP/hostname guessing every time. SEB connection tokens change per session,
// so what gets stored is a stable identifier from the live connection (machine
// name, fixed address, ...). Pick a connection → click the identifier chip
// that is stable for that PC → choose the device → Bind.
import React, { useState, useEffect, useCallback } from 'react'
import { X, Loader2, Link2, Unlink, RefreshCw } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { getErrorMessage } from '../../lib/errors'

const BY_LABEL = { binding: 'bound', ip: 'by IP', hostname: 'by hostname' }

function ConnectionRow({ con, devices, onBind }) {
  const [value, setValue] = useState('')
  const [deviceId, setDeviceId] = useState(con.device?.id || '')
  const [busy, setBusy] = useState(false)
  const bind = async () => {
    setBusy(true)
    try { await onBind(deviceId, value) } finally { setBusy(false) }
  }
  return (
    <div className="px-3 py-2.5 rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-surface-3)', color: 'var(--text-secondary)' }}>
          {con.status} · …{con.tokenSuffix}
        </span>
        <span className="text-[11px] font-body" style={{ color: con.device ? '#22c55e' : 'var(--text-faint)' }}>
          {con.device ? `${con.device.name} (${BY_LABEL[con.matchedBy] || con.matchedBy})` : 'not matched to a device'}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {con.fields.map(f => (
          <button key={f} type="button" onClick={() => setValue(f)}
            className="text-[11px] px-1.5 py-0.5 rounded border font-mono transition-all"
            style={{
              borderColor: value === f ? '#a78bfa' : 'var(--border-subtle)',
              background: value === f ? 'rgba(167,139,250,0.18)' : 'transparent',
              color: value === f ? '#a78bfa' : 'var(--text-muted)',
            }}>{f}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <select value={deviceId} onChange={e => setDeviceId(e.target.value)} className="input-field flex-1 text-xs">
          <option value="">Choose device…</option>
          {devices.map(d => <option key={d.id} value={d.id}>{d.name}{d.group_name ? ` · ${d.group_name}` : ''}</option>)}
        </select>
        <button type="button" onClick={bind} disabled={busy || !value || !deviceId}
          className="btn-ghost flex items-center gap-1.5 px-3 text-xs disabled:opacity-40">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Bind
        </button>
      </div>
      {!value && <p className="text-[10px] mt-1" style={{ color: 'var(--text-faint)' }}>Click the identifier that stays the same for this PC (e.g. its machine name).</p>}
    </div>
  )
}

export default function SebBindingsModal({ open, onClose, examId }) {
  const [devices, setDevices] = useState([])
  const [cons, setCons] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingCons, setLoadingCons] = useState(false)

  const loadDevices = useCallback(async () => {
    setLoading(true)
    try { const { data } = await api.get('/seb/bindings'); setDevices(data) }
    catch (err) { toast.error(getErrorMessage(err, 'Could not load devices')) }
    finally { setLoading(false) }
  }, [])

  const loadCons = useCallback(async () => {
    if (!examId) return
    setLoadingCons(true)
    try { const { data } = await api.get(`/seb/exams/${encodeURIComponent(examId)}/connections`); setCons(data.connections) }
    catch (err) { toast.error(getErrorMessage(err, 'Could not read SEB Server')); setCons(null) }
    finally { setLoadingCons(false) }
  }, [examId])

  useEffect(() => { if (open) { setCons(null); loadDevices(); loadCons() } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const bind = async (deviceId, key) => {
    try {
      await api.put(`/seb/bindings/${deviceId}`, { key })
      toast.success('Bound')
      await Promise.all([loadDevices(), loadCons()])
    } catch (err) { toast.error(getErrorMessage(err, 'Bind failed')) }
  }
  const unbind = async (d) => {
    try { await api.put(`/seb/bindings/${d.id}`, { key: null }); await Promise.all([loadDevices(), loadCons()]) }
    catch (err) { toast.error(getErrorMessage(err, 'Unbind failed')) }
  }

  if (!open) return null
  const bound = devices.filter(d => d.seb_match_key)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={e => { e.stopPropagation(); onClose() }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'rgba(108,92,231,0.25)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
          <div className="flex items-start justify-between p-6 pb-3">
            <div>
              <h3 className="font-display text-base" style={{ color: 'var(--text-primary)' }}>SEB client bindings</h3>
              <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>
                A bound device is matched only on its stored identifier. Unbound devices fall back to IP / hostname.
              </p>
            </div>
            <button onClick={onClose} className="p-1 rounded-lg hover:text-accent-red" style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
          </div>

          <div className="px-6 pb-6 grid gap-5 max-h-[70vh] overflow-y-auto">
            <section>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Live connections{examId ? ` — exam ${examId}` : ''}</h4>
                <button onClick={loadCons} disabled={!examId || loadingCons} className="p-1 disabled:opacity-40" style={{ color: 'var(--text-muted)' }} title="Refresh">
                  <RefreshCw size={12} className={loadingCons ? 'animate-spin' : ''} />
                </button>
              </div>
              {!examId && <p className="text-xs" style={{ color: 'var(--text-faint)' }}>Enter an exam ID in the Quit SEB dialog first.</p>}
              {examId && cons && cons.length === 0 && <p className="text-xs" style={{ color: 'var(--text-faint)' }}>No connections in this exam right now — start SEB on the PCs, then refresh.</p>}
              <div className="space-y-2">
                {(cons || []).map(c => <ConnectionRow key={c.tokenSuffix + c.fields.join('|')} con={c} devices={devices} onBind={bind} />)}
              </div>
            </section>

            <section>
              <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>Bound devices ({bound.length}/{devices.length})</h4>
              {loading && <Loader2 size={14} className="animate-spin" />}
              <div className="space-y-1">
                {bound.map(d => (
                  <div key={d.id} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
                    <span className="truncate" style={{ color: 'var(--text-primary)' }}>{d.name}{d.group_name ? <span style={{ color: 'var(--text-faint)' }}> · {d.group_name}</span> : null}</span>
                    <span className="font-mono truncate" style={{ color: '#a78bfa' }}>{d.seb_match_key}</span>
                    <button onClick={() => unbind(d)} className="p-1 hover:text-accent-red shrink-0" style={{ color: 'var(--text-muted)' }} title="Unbind"><Unlink size={12} /></button>
                  </div>
                ))}
                {!loading && bound.length === 0 && <p className="text-xs" style={{ color: 'var(--text-faint)' }}>Nothing bound yet.</p>}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}