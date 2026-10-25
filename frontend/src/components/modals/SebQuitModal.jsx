// components/modals/SebQuitModal.jsx
// "Quit SEB" for one device, a selection of devices, or a whole group/lab.
// Flow: confirm (exam id + optional shutdown + action PIN) → POST /seb/quit →
// poll /seb/runs/:id and show each device's progress until everything settles.
// The backend only shuts a PC down after SEB has confirmed it exited.
import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  ShieldAlert, X, Loader2, CheckCircle2, XCircle, AlertTriangle, Clock, Power, LogOut, Search, Link2,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { getErrorMessage } from '../../lib/errors'
import SebBindingsModal from './SebBindingsModal'

const LS_EXAM = 'nc_seb_exam_id'
const LS_SHUTDOWN = 'nc_seb_shutdown_after'
const POLL_MS = 2000

const STATE_META = {
  queued:           { label: 'Queued',                     tone: 'muted',  spin: true  },
  waiting_exit:     { label: 'Waiting for SEB to exit',    tone: 'yellow', spin: true  },
  exited:           { label: 'SEB exited',                 tone: 'green',  spin: false },
  shutdown_pending: { label: 'SEB exited — shutting down', tone: 'yellow', spin: true  },
  shutdown_sent:    { label: 'SEB exited · shutdown sent', tone: 'green',  spin: false },
  shutdown_failed:  { label: 'SEB exited · shutdown failed', tone: 'red',  spin: false },
  no_connection:    { label: 'No active SEB connection',   tone: 'yellow', spin: false },
  skipped:          { label: 'Skipped',                    tone: 'yellow', spin: false },
  failed:           { label: 'Failed',                     tone: 'red',    spin: false },
  timeout:          { label: 'Timed out',                  tone: 'red',    spin: false },
  cancelled:        { label: 'Cancelled',                  tone: 'muted',  spin: false },
}
const TONE = {
  green:  { text: 'text-accent-green',  box: 'bg-accent-green/5 border-accent-green/15'   },
  red:    { text: 'text-accent-red',    box: 'bg-accent-red/5 border-accent-red/15'       },
  yellow: { text: 'text-accent-yellow', box: 'bg-accent-yellow/5 border-accent-yellow/15' },
  muted:  { text: '',                   box: 'border-[color:var(--border-subtle)]'        },
}
const IN_FLIGHT = new Set(['queued', 'waiting_exit', 'shutdown_pending'])

function ItemIcon({ meta }) {
  if (meta.spin) return <Loader2 size={14} className={`animate-spin shrink-0 mt-0.5 ${TONE[meta.tone].text}`} style={meta.tone === 'muted' ? { color: 'var(--text-muted)' } : undefined} />
  if (meta.tone === 'green') return <CheckCircle2 size={14} className="text-accent-green shrink-0 mt-0.5" />
  if (meta.tone === 'red') return <XCircle size={14} className="text-accent-red shrink-0 mt-0.5" />
  if (meta.tone === 'yellow') return <AlertTriangle size={14} className="text-accent-yellow shrink-0 mt-0.5" />
  return <Clock size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />
}

/**
 * target: { deviceId } | { deviceIds: [...] } | { groupId }  plus  { label }
 * e.g. { deviceId, label: 'LAB-PC-01' }, { groupId, label: 'Lab 3' }
 */
export default function SebQuitModal({ open, onClose, target, onFinished }) {
  const [config, setConfig]       = useState(null)
  const [examId, setExamId]       = useState('')
  const [shutdownAfter, setShutdownAfter] = useState(false)
  const [pin, setPin]             = useState('')
  const [error, setError]         = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [preview, setPreview]     = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [run, setRun]             = useState(null)     // GET /seb/runs/:id payload
  const [runId, setRunId]         = useState(null)
  const [startSkipped, setStartSkipped] = useState([])
  const [cancelling, setCancelling] = useState(false)
  const [bindingsOpen, setBindingsOpen] = useState(false)
  const pinRef = useRef(null)
  const finishedRef = useRef(false)

  // reset every time the modal opens
  useEffect(() => {
    if (!open) return
    setPin(''); setError(''); setPreview(null); setRun(null); setRunId(null)
    setStartSkipped([]); setSubmitting(false); setCancelling(false); finishedRef.current = false
    setShutdownAfter(localStorage.getItem(LS_SHUTDOWN) === '1')
    let alive = true
    api.get('/seb/config').then(({ data }) => {
      if (!alive) return
      setConfig(data)
      setExamId(localStorage.getItem(LS_EXAM) || data.defaultExamId || '')
    }).catch(err => { if (alive) setConfig({ configured: false, error: getErrorMessage(err, 'Could not load SEB settings') }) })
    return () => { alive = false }
  }, [open])

  // poll the run until it leaves "running"
  useEffect(() => {
    if (!open || !runId) return
    let stop = false
    let timer
    const tick = async () => {
      try {
        const { data } = await api.get(`/seb/runs/${runId}`)
        if (stop) return
        setRun(data)
        if (data.status === 'running') { timer = setTimeout(tick, POLL_MS); return }
        if (!finishedRef.current) { finishedRef.current = true; onFinished?.(data) }
      } catch (err) {
        if (!stop) timer = setTimeout(tick, POLL_MS * 2) // transient — keep trying
      }
    }
    tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [open, runId]) // eslint-disable-line react-hooks/exhaustive-deps

  const body = useCallback(() => {
    const b = { actionPin: pin, examId: examId.trim(), shutdownAfter }
    if (target?.groupId) b.groupId = target.groupId
    else if (target?.deviceIds) b.deviceIds = target.deviceIds
    else if (target?.deviceId) b.deviceId = target.deviceId
    return b
  }, [pin, examId, shutdownAfter, target])

  const handleClose = () => { onClose() }

  const handlePreview = async () => {
    if (!examId.trim()) { setError('Enter the SEB Server exam ID first'); return }
    setPreviewing(true); setError(''); setPreview(null)
    try {
      const { data } = await api.get(`/seb/exams/${encodeURIComponent(examId.trim())}/connections`)
      setPreview(data)
    } catch (err) { setError(getErrorMessage(err, 'Could not read the exam from SEB Server')) }
    finally { setPreviewing(false) }
  }

  const handleStart = async () => {
    if (!examId.trim()) { setError('Exam ID is required'); return }
    if (!pin.trim()) { setError('Action PIN is required'); return }
    setSubmitting(true); setError('')
    try {
      const { data } = await api.post('/seb/quit', body())
      localStorage.setItem(LS_EXAM, examId.trim())
      localStorage.setItem(LS_SHUTDOWN, shutdownAfter ? '1' : '0')
      setPin('')
      setStartSkipped(data.skipped || [])
      setRunId(data.runId)
    } catch (err) {
      const d = err.response?.data
      const skipped = d?.skipped?.length ? ` (${d.skipped.map(s => `${s.device}: ${s.reason}`).join('; ')})` : ''
      setError(getErrorMessage(err, 'Could not start SEB quit') + skipped)
    } finally { setSubmitting(false) }
  }

  const handleCancel = async () => {
    setCancelling(true)
    try { await api.post(`/seb/runs/${runId}/cancel`); toast.success('Run cancelled — pending shutdowns blocked') }
    catch (err) { toast.error(getErrorMessage(err, 'Cancel failed')) }
    finally { setCancelling(false) }
  }

  if (!open) return null

  const running = !!runId && (!run || run.status === 'running')
  const items = run?.items || []
  const okState = run?.shutdown_after ? 'shutdown_sent' : 'exited'
  const okCount = items.filter(i => i.state === okState).length
  const inFlight = items.filter(i => IN_FLIGHT.has(i.state) || (i.state === 'exited' && run?.shutdown_after)).length
  const badCount = items.length - okCount - inFlight
  const notConfigured = config && config.configured === false

  const headerTone = !runId ? 'purple'
    : running ? 'purple'
    : run?.status === 'completed' ? 'green'
    : run?.status === 'failed' ? 'red' : 'yellow'

  const handleKey = (e) => { if (e.key === 'Enter' && !runId) handleStart(); if (e.key === 'Escape') handleClose() }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-lg animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="rounded-2xl border overflow-hidden"
          style={{ background: 'var(--bg-card)', borderColor: 'rgba(108,92,231,0.25)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
          <div className={`h-0.5 opacity-70 ${headerTone === 'green' ? 'bg-accent-green' : headerTone === 'red' ? 'bg-accent-red' : headerTone === 'yellow' ? 'bg-accent-yellow' : 'bg-[#6c5ce7]'}`} />

          {/* Header */}
          <div className="flex items-start justify-between p-6 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#6c5ce7]/15 border border-[#6c5ce7]/25">
                <LogOut size={20} className="text-[#6c5ce7]" />
              </div>
              <div>
                <h3 className="font-display text-base" style={{ color: 'var(--text-primary)' }}>
                  Quit SEB — {target?.label}
                </h3>
                <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {!runId
                    ? 'Ends the Safe Exam Browser session via SEB Server.'
                    : running ? `${okCount} done · ${inFlight} in progress${badCount ? ` · ${badCount} not completed` : ''}`
                    : `${okCount} succeeded · ${badCount} not completed`}
                </p>
              </div>
            </div>
            <button onClick={handleClose} className="p-1 rounded-lg transition-colors hover:text-accent-red" style={{ color: 'var(--text-muted)' }}>
              <X size={16} />
            </button>
          </div>

          {/* ── Confirm form ── */}
          {!runId && (
            <div className="px-6 pb-6">
              {notConfigured && (
                <div className="mb-4 px-3 py-2.5 rounded-lg border border-accent-red/25 bg-accent-red/5">
                  <p className="text-xs font-body text-accent-red">
                    {config.error || 'SEB Server integration is not configured. Set the SEB_* variables on the backend and restart.'}
                  </p>
                </div>
              )}

              <label className="label">SEB Server exam ID</label>
              <div className="flex gap-2">
                <input value={examId} onChange={e => { setExamId(e.target.value); setError(''); setPreview(null) }}
                  onKeyDown={handleKey} placeholder="e.g. 12" className="input-field flex-1" autoComplete="off" disabled={notConfigured} />
                <button type="button" onClick={handlePreview} disabled={previewing || notConfigured || !examId.trim()}
                  className="btn-ghost flex items-center gap-1.5 px-3 text-xs disabled:opacity-40" title="Read this exam's live connections from SEB Server">
                  {previewing ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Check
                </button>
                <button type="button" onClick={() => setBindingsOpen(true)} disabled={notConfigured}
                  className="btn-ghost flex items-center gap-1.5 px-3 text-xs disabled:opacity-40" title="Bind devices to their SEB clients">
                  <Link2 size={12} /> Bindings
                </button>
              </div>
              {preview && (
                <p className="text-[11px] font-body mt-1.5" style={{ color: 'var(--text-muted)' }}>
                  {preview.total} connection(s) in exam · {preview.connections.filter(c => c.device).length} matched to NetControl devices
                  {preview.connections.filter(c => c.device).length === 0 && preview.total > 0 && (
                    <span className="text-accent-yellow"> — none matched by IP/hostname; the quit would find nothing.</span>
                  )}
                </p>
              )}

              <label className="flex items-start gap-2.5 mt-4 cursor-pointer select-none">
                <input type="checkbox" checked={shutdownAfter} onChange={e => setShutdownAfter(e.target.checked)} className="mt-0.5" />
                <span className="text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
                  <span className="font-medium flex items-center gap-1"><Power size={11} className="text-accent-red" /> Shut down the PC after SEB exits</span>
                  <span className="block mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Only sent once SEB has confirmed it closed. Timeouts, failures and cancellations never shut a machine down.
                  </span>
                </span>
              </label>

              <div className="mt-4 px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <p className="text-xs font-body leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Security check:</span>{' '}
                  Enter your action PIN to authorise. This is logged in the audit trail.
                </p>
              </div>

              <label className="label mt-4">Action PIN</label>
              <input ref={pinRef} type="password" value={pin} onChange={e => { setPin(e.target.value); setError('') }}
                onKeyDown={handleKey} placeholder="Enter your action PIN"
                className={`input-field ${error ? 'border-accent-red/50' : ''}`} autoComplete="off" disabled={notConfigured} />
              {error && <p className="text-xs text-accent-red mt-2 font-body">{error}</p>}

              <div className="flex gap-3 mt-5">
                <button onClick={handleClose} className="btn-ghost flex-1 justify-center" disabled={submitting}>Cancel</button>
                <button onClick={handleStart} disabled={submitting || notConfigured || !pin.trim() || !examId.trim()}
                  className="flex-1 justify-center flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg transition-all duration-200 text-sm disabled:opacity-40 bg-accent-red/20 hover:bg-accent-red/30 text-accent-red border border-accent-red/30 hover:border-accent-red/50">
                  {submitting && <Loader2 size={14} className="animate-spin" />}
                  {submitting ? 'Sending…' : shutdownAfter ? 'Quit SEB & shut down' : 'Quit SEB'}
                </button>
              </div>
            </div>
          )}

          {/* ── Progress / results ── */}
          {runId && (
            <div className="px-6 pb-6">
              {startSkipped.length > 0 && !items.length && (
                <p className="text-xs font-body text-accent-yellow mb-3">{startSkipped.length} device(s) skipped up front.</p>
              )}
              <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                {!items.length && (
                  <div className="flex items-center gap-2 text-xs font-body" style={{ color: 'var(--text-muted)' }}>
                    <Loader2 size={14} className="animate-spin" /> Contacting SEB Server…
                  </div>
                )}
                {items.map(it => {
                  const meta = STATE_META[it.state] || { label: it.state, tone: 'muted', spin: false }
                  const tone = TONE[meta.tone]
                  return (
                    <div key={it.id} className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border ${tone.box}`}>
                      <ItemIcon meta={meta} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-body font-medium truncate" style={{ color: 'var(--text-primary)' }}>{it.device_name}</p>
                          <span className={`text-[10px] font-semibold shrink-0 ${tone.text}`} style={meta.tone === 'muted' ? { color: 'var(--text-muted)' } : undefined}>{meta.label}</span>
                        </div>
                        {it.details && (
                          <p className="text-[11px] font-body mt-0.5 break-words" style={{ color: 'var(--text-muted)' }}>{it.details}</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {run?.status === 'cancelled' && (
                <p className="text-[11px] font-body mt-3" style={{ color: 'var(--text-muted)' }}>
                  Run cancelled. SEB_QUIT instructions already registered can't be recalled.
                </p>
              )}

              <div className="flex gap-3 mt-5">
                {running && (
                  <button onClick={handleCancel} disabled={cancelling} className="btn-ghost flex-1 justify-center disabled:opacity-40">
                    {cancelling ? 'Cancelling…' : 'Stop & block shutdowns'}
                  </button>
                )}
                <button onClick={handleClose} className="btn-primary flex-1 justify-center">
                  {running ? 'Hide (keeps running)' : 'Done'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <SebBindingsModal open={bindingsOpen} onClose={() => { setBindingsOpen(false); setPreview(null) }} examId={examId.trim()} />
    </div>
  )
}