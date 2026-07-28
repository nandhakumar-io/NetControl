import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Monitor, Layers, Zap, Clock, Users, BellRing, Activity, Terminal,
  CornerDownLeft, Loader2, X, Power, RefreshCw, PlayCircle, CheckCheck, History, ShieldAlert,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { usePermissions } from '../../hooks/usePermissions'
import { parseQuickAction, resolveDevice, resolveRunbook, resolveOpenAlert } from '../../lib/quickActions'
import { getRecent, recordRecent } from '../../lib/paletteHistory'

// Debounced GET /api/search — one request per pause in typing, not one per
// keystroke, so the palette doesn't hammer the API on every character while
// still feeling instant for how short these queries are.
const DEBOUNCE_MS = 200

const CATEGORY_META = {
  device:         { icon: Monitor,  label: 'Devices' },
  group:          { icon: Layers,   label: 'Groups' },
  runbook:        { icon: Zap,      label: 'Runbooks' },
  schedule:       { icon: Clock,    label: 'Schedules' },
  alertRule:      { icon: BellRing, label: 'Alert Rules' },
  syntheticCheck: { icon: Activity, label: 'Synthetic Checks' },
  bulkTemplate:   { icon: Terminal, label: 'Bulk Command Templates' },
  user:           { icon: Users,    label: 'Users' },
}

const STATUS_DOT = {
  online:  'bg-accent-green',
  offline: 'bg-accent-red',
  unknown: 'bg-slate-500',
}

// Quick-action verb → icon/label, purely for rendering the pending-action
// row consistently with the rest of the palette's iconography.
const ACTION_META = {
  restart: { icon: RefreshCw,   label: 'Restart' },
  wake:    { icon: Power,       label: 'Wake' },
  run:     { icon: PlayCircle,  label: 'Run runbook' },
  ack:     { icon: CheckCheck,  label: 'Acknowledge' },
}

export default function CommandPalette({ open, onClose }) {
  const [q, setQ]             = useState('')
  const [results, setResults] = useState([])   // flattened, in display order
  const [loading, setLoading] = useState(false)
  const [active, setActive]   = useState(0)
  const inputRef  = useRef(null)
  const debounceRef = useRef(null)
  const navigate  = useNavigate()
  const { isAdmin, isOperator, can } = usePermissions()
  const canRunActions   = isAdmin || isOperator            // matches backend requireRole('admin','operator') on /actions/*
  const canManageRunbooks = can(32768)                      // MANAGE_RUNBOOKS bit, matches /runbooks/:id/test
  const canAckAlerts    = isAdmin || isOperator             // matches /alerts/triggered/:id/ack

  // Quick-action state: `pending` is the parsed verb + resolved target(s),
  // shown as a single distinguished row above normal results. `confirming`
  // gates the actual mutation behind an explicit second step — Enter
  // selects the action, Enter again (or a click) executes it — so a typo'd
  // Enter can't restart a device by accident.
  const [pending, setPending]       = useState(null)   // { kind, action?, device?, runbook?, alert?, resolving }
  const [confirming, setConfirming] = useState(false)
  const [pinModal, setPinModal]     = useState(null)   // { action, device } — restart/wake need the action PIN
  const [pin, setPin]               = useState('')
  const [pinError, setPinError]     = useState('')
  const [executing, setExecuting]   = useState(false)
  const actionRequestIdRef = useRef(0)

  // Race-safety: every request is tagged with an incrementing id, and only
  // the response matching the LATEST request is applied. Without this, a
  // slow response to an earlier keystroke can land after a faster response
  // to a later one and clobber it with stale results — which is also what
  // made Enter feel unreliable ("search a device, hit Enter, nothing
  // happens" or it jumps to the wrong page).
  const requestIdRef = useRef(0)

  const [recent, setRecent] = useState([])

  useEffect(() => {
    if (open) {
      setQ(''); setResults([]); setActive(0)
      setPending(null); setConfirming(false); setPinModal(null); setPin(''); setPinError('')
      setRecent(getRecent())
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  // Sorts device results so an exact (case-insensitive) name match always
  // lands first — e.g. typing the full hostname and hitting Enter should
  // jump straight to that device, not whatever else starts with the same
  // characters.
  const rankResults = (flat, query) => {
    const needle = query.trim().toLowerCase()
    if (!needle) return flat
    return [...flat].sort((a, b) => {
      const aExact = (a.label || '').toLowerCase() === needle
      const bExact = (b.label || '').toLowerCase() === needle
      if (aExact !== bExact) return aExact ? -1 : 1
      const aStarts = (a.label || '').toLowerCase().startsWith(needle)
      const bStarts = (b.label || '').toLowerCase().startsWith(needle)
      if (aStarts !== bStarts) return aStarts ? -1 : 1
      return 0
    })
  }

  // Returns the flattened, ranked result list directly (in addition to
  // updating state) so callers like handleKeyDown's Enter-fast-path can
  // navigate off the fresh data immediately instead of waiting a render
  // cycle for `results` to update.
  const runSearch = useCallback((value) => {
    const needle = value.trim()
    if (!needle) { setResults([]); setLoading(false); return Promise.resolve([]) }
    const requestId = ++requestIdRef.current
    setLoading(true)
    return api.get('/search', { params: { q: needle } })
      .then(r => {
        if (requestId !== requestIdRef.current) return [] // superseded by a newer request
        const cats = r.data?.categories || {}
        const order = ['device', 'group', 'runbook', 'schedule', 'alertRule', 'syntheticCheck', 'bulkTemplate', 'user']
        const KEY_BY_TYPE = {
          device: 'devices', group: 'groups', runbook: 'runbooks', schedule: 'schedules',
          alertRule: 'alertRules', syntheticCheck: 'syntheticChecks', bulkTemplate: 'bulkTemplates',
          user: 'users',
        }
        const flat = []
        for (const type of order) {
          for (const item of cats[KEY_BY_TYPE[type]] || []) flat.push(item)
        }
        const ranked = rankResults(flat, needle)
        setResults(ranked)
        setActive(0)
        return ranked
      })
      .catch(() => { if (requestId === requestIdRef.current) setResults([]); return [] })
      .finally(() => { if (requestId === requestIdRef.current) setLoading(false) })
  }, [])

  // Resolves a quick-action verb's target(s) against live data (devices,
  // runbooks, open alerts) as the person types, same debounce cadence as
  // normal search. A verb the person's role can't execute is treated as no
  // match at all — it never resolves into an actionable row — mirroring
  // the "don't surface what the underlying endpoint would 403 on" rule the
  // rest of the palette already follows for view permissions.
  const runQuickAction = useCallback((intent) => {
    const requestId = ++actionRequestIdRef.current
    setPending({ ...intent, resolving: true })
    setActive(0)

    const settle = (patch) => { if (requestId === actionRequestIdRef.current) setPending(p => (p ? { ...p, ...patch, resolving: false } : p)) }

    if (intent.kind === 'device-action') {
      if (!canRunActions) { setPending(null); return }
      resolveDevice(intent.deviceQuery)
        .then(device => settle({ device }))
        .catch(() => settle({ device: null }))
      return
    }
    if (intent.kind === 'runbook-run') {
      if (!canManageRunbooks) { setPending(null); return }
      Promise.all([resolveRunbook(intent.runbookQuery), resolveDevice(intent.deviceQuery)])
        .then(([runbook, device]) => settle({ runbook, device }))
        .catch(() => settle({ runbook: null, device: null }))
      return
    }
    if (intent.kind === 'alert-ack') {
      if (!canAckAlerts) { setPending(null); return }
      resolveOpenAlert(intent.alertQuery)
        .then(alert => settle({ alert }))
        .catch(() => settle({ alert: null }))
      return
    }
  }, [canRunActions, canManageRunbooks, canAckAlerts])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    const intent = parseQuickAction(q)
    if (intent) {
      setResults([]); setLoading(false)
      debounceRef.current = setTimeout(() => runQuickAction(intent), DEBOUNCE_MS)
    } else {
      setPending(null); setConfirming(false)
      debounceRef.current = setTimeout(() => runSearch(q), DEBOUNCE_MS)
    }
    return () => clearTimeout(debounceRef.current)
  }, [q, runSearch, runQuickAction])

  const go = (item) => {
    if (!item) return
    recordRecent(item)
    onClose()
    navigate(item.path)
  }

  // Whether the currently-pending quick action has everything it needs to
  // run (all target(s) resolved to a real record) — gates both the Enter
  // fast-path and the row's visual "ready" state.
  const pendingReady = pending && !pending.resolving && (
    (pending.kind === 'device-action' && pending.device) ||
    (pending.kind === 'runbook-run' && pending.runbook && pending.device) ||
    (pending.kind === 'alert-ack' && pending.alert)
  )

  const executeAck = async () => {
    setExecuting(true)
    try {
      await api.post(`/alerts/triggered/${pending.alert.id}/ack`)
      toast.success(`Acknowledged: ${pending.alert.rule_name || 'alert'}${pending.alert.device_name ? ` on ${pending.alert.device_name}` : ''}`)
      recordRecent({ type: 'alertAck', id: pending.alert.id, label: pending.alert.rule_name, path: '/alerts?tab=history' })
      setQ(''); onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to acknowledge')
    } finally { setExecuting(false) }
  }

  const executeRunbook = async () => {
    setExecuting(true)
    try {
      const { data } = await api.post(`/runbooks/${pending.runbook.id}/test`, { deviceId: pending.device.id })
      if (data.result === 'success') toast.success(`Ran "${pending.runbook.label}" on ${pending.device.label}`)
      else toast.error(`"${pending.runbook.label}" on ${pending.device.label}: ${data.output || 'failed'}`)
      recordRecent({ type: 'runbook', id: pending.runbook.id, label: pending.runbook.label, path: `/runbooks?highlight=${pending.runbook.id}` })
      setQ(''); onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to run runbook')
    } finally { setExecuting(false) }
  }

  const executePin = async (e) => {
    e?.preventDefault()
    if (!pin.trim()) { setPinError('Action PIN is required'); return }
    setExecuting(true); setPinError('')
    try {
      const { action, device } = pinModal
      const { data } = await api.post(`/actions/${action}`, { deviceId: device.id, actionPin: pin })
      const failed = (data.results || []).some(r => r.result === 'failure')
      if (failed) toast.error(`${ACTION_META[action].label} ${device.label}: ${data.results?.[0]?.details || 'failed'}`)
      else toast.success(`${ACTION_META[action].label} sent to ${device.label}`)
      recordRecent({ type: 'device', id: device.id, label: device.label, path: device.path })
      setPin(''); setPinModal(null); setQ(''); onClose()
    } catch (err) {
      setPinError(err.response?.data?.error || 'Action failed')
    } finally { setExecuting(false) }
  }

  // Enter on a ready quick-action row: destructive device actions (restart/
  // wake) always require the action PIN, same as everywhere else in the
  // app that touches /api/actions — so the palette opens that step rather
  // than firing directly. Run/ack aren't PIN-gated by the backend, but
  // still get one explicit confirm tap so a fast-typed Enter can't fire
  // them by accident.
  const activateQuickAction = () => {
    if (!pendingReady) return
    if (pending.kind === 'device-action') { setPinModal({ action: pending.action, device: pending.device }); return }
    if (!confirming) { setConfirming(true); return }
    if (pending.kind === 'runbook-run') executeRunbook()
    else if (pending.kind === 'alert-ack') executeAck()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (pinModal) { setPinModal(null); setPin(''); setPinError(''); return }
      if (confirming) { setConfirming(false); return }
      onClose(); return
    }
    if (pinModal) return // input focus is in the PIN field; its own handler covers Enter
    if (pending) {
      if (e.key === 'Enter') { e.preventDefault(); activateQuickAction() }
      return
    }
    const list = q.trim() ? results : recent
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, list.length - 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!q.trim()) { go(recent[active]); return }
      // Fast path: results already match what's currently typed (the
      // debounce already resolved) — navigate immediately, no extra
      // round-trip.
      if (!loading && results.length) { go(results[active]); return }
      // Enter pressed before the debounced search finished (or nothing
      // has fired yet) — skip the debounce and search right now, then
      // jump straight to the best match once it resolves, instead of
      // silently doing nothing.
      clearTimeout(debounceRef.current)
      runSearch(q).then(ranked => { if (ranked.length) go(ranked[0]) })
    }
  }

  if (!open) return null

  // Group flattened results back into sections for rendering, preserving
  // the fixed order runSearch already applied.
  const sections = []
  for (const item of results) {
    let section = sections.find(s => s.type === item.type)
    if (!section) { section = { type: item.type, items: [] }; sections.push(section) }
    section.items.push(item)
  }
  let rowIndex = -1

  const showRecent = !q.trim() && !pending

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-xl rounded-2xl border overflow-hidden animate-slide-up"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-mid)', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Search size={18} style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search, or try “restart web-01”, “run reboot-nginx on web-01”, “ack disk-90”…"
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: 'var(--text-primary)' }}
          />
          {(loading || (pending && pending.resolving)) && <Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-muted)' }} />}
          <button onClick={onClose} className="p-1 rounded-md hover:opacity-70" aria-label="Close">
            <X size={16} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {/* ── Quick action: pending / confirm ─────────────────────────── */}
          {pending && !pinModal && (() => {
            const meta = ACTION_META[pending.kind === 'device-action' ? pending.action : pending.kind === 'runbook-run' ? 'run' : 'ack']
            const Icon = meta.icon
            let label, sublabel, disabledReason = null
            if (pending.kind === 'device-action') {
              label = pending.device ? `${meta.label} ${pending.device.label}` : `${meta.label} — no matching device`
              sublabel = pending.device?.sublabel
            } else if (pending.kind === 'runbook-run') {
              label = pending.runbook && pending.device
                ? `Run “${pending.runbook.label}” on ${pending.device.label}`
                : `Run runbook — ${!pending.runbook ? 'no matching runbook' : 'no matching device'}`
              sublabel = pending.runbook && pending.device ? 'Runbook' : null
            } else {
              label = pending.alert
                ? `Acknowledge “${pending.alert.rule_name || 'alert'}”${pending.alert.device_name ? ` on ${pending.alert.device_name}` : ''}`
                : 'Acknowledge — no matching open alert'
              sublabel = pending.alert ? 'Open incident' : null
            }
            return (
              <div className="px-2 pb-2">
                <div
                  className="flex items-center gap-3 px-3 py-3 rounded-xl border"
                  style={{
                    background: pendingReady ? 'rgba(124,92,245,0.08)' : 'var(--bg-hover)',
                    borderColor: pendingReady ? 'rgba(167,139,250,0.3)' : 'var(--border-subtle)',
                  }}
                >
                  <Icon size={18} className="shrink-0" style={{ color: pendingReady ? '#a78bfa' : 'var(--text-faint)' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate" style={{ color: pendingReady ? 'var(--text-primary)' : 'var(--text-muted)' }}>{label}</p>
                    {sublabel && <p className="text-xs truncate" style={{ color: 'var(--text-faint)' }}>{sublabel}</p>}
                  </div>
                  {pendingReady && !confirming && (
                    <span className="flex items-center gap-1 text-xs shrink-0" style={{ color: 'var(--text-faint)' }}>
                      <CornerDownLeft size={13} /> {pending.kind === 'device-action' ? 'enter PIN' : 'confirm'}
                    </span>
                  )}
                </div>
                {pendingReady && confirming && pending.kind !== 'device-action' && (
                  <div className="flex items-center gap-2 mt-2 px-1">
                    <button
                      onClick={activateQuickAction}
                      disabled={executing}
                      className="flex-1 justify-center flex items-center gap-2 font-body font-medium px-3 py-2 rounded-lg text-sm bg-[#6c5ce7]/20 hover:bg-[#6c5ce7]/30 text-[#a78bfa] border border-[#6c5ce7]/30 disabled:opacity-40"
                    >
                      {executing && <Loader2 size={13} className="animate-spin" />}
                      {executing ? 'Working…' : 'Confirm — press Enter again'}
                    </button>
                    <button onClick={() => setConfirming(false)} disabled={executing} className="px-3 py-2 rounded-lg text-sm" style={{ color: 'var(--text-muted)' }}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Quick action: PIN entry for restart/wake ────────────────── */}
          {pinModal && (
            <div className="px-4 py-3 space-y-3">
              <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                <ShieldAlert size={14} className="shrink-0 mt-0.5" style={{ color: '#a78bfa' }} />
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Enter your action PIN to {ACTION_META[pinModal.action].label.toLowerCase()} <span style={{ color: 'var(--text-secondary)' }}>{pinModal.device.label}</span>. This is logged in the audit trail.
                </p>
              </div>
              <input
                type="password"
                autoFocus
                value={pin}
                onChange={e => { setPin(e.target.value); setPinError('') }}
                onKeyDown={e => { if (e.key === 'Enter') executePin(e) }}
                placeholder="Action PIN"
                className="input-field w-full"
                style={pinError ? { borderColor: 'rgba(239,68,68,0.5)' } : undefined}
                autoComplete="off"
              />
              {pinError && <p className="text-xs" style={{ color: '#f87171' }}>{pinError}</p>}
              <div className="flex gap-2">
                <button onClick={() => { setPinModal(null); setPin(''); setPinError('') }} disabled={executing} className="flex-1 justify-center px-3 py-2 rounded-lg text-sm" style={{ color: 'var(--text-muted)' }}>
                  Cancel
                </button>
                <button
                  onClick={executePin}
                  disabled={executing || !pin.trim()}
                  className="flex-1 justify-center flex items-center gap-2 font-body font-medium px-3 py-2 rounded-lg text-sm bg-[#6c5ce7]/20 hover:bg-[#6c5ce7]/30 text-[#a78bfa] border border-[#6c5ce7]/30 disabled:opacity-40"
                >
                  {executing && <Loader2 size={13} className="animate-spin" />}
                  {executing ? 'Sending…' : `Confirm ${ACTION_META[pinModal.action].label}`}
                </button>
              </div>
            </div>
          )}

          {/* ── Recent items (empty query) ──────────────────────────────── */}
          {showRecent && recent.length > 0 && (
            <div className="mb-1">
              <div className="px-4 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5" style={{ color: 'var(--text-faint)' }}>
                <History size={11} /> Recent
              </div>
              {recent.map((item, i) => {
                const meta = CATEGORY_META[item.type]
                const Icon = meta?.icon || Clock
                const isActive = i === active
                return (
                  <button
                    key={`recent-${item.type}-${item.id}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(item)}
                    className="w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors"
                    style={{ background: isActive ? 'var(--bg-hover)' : 'transparent', color: 'var(--text-primary)' }}
                  >
                    <Icon size={16} style={{ color: 'var(--text-secondary)' }} className="shrink-0" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.status && <span className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_DOT[item.status] || 'bg-slate-500'}`} />}
                    {item.sublabel && <span className="text-xs truncate max-w-[35%]" style={{ color: 'var(--text-muted)' }}>{item.sublabel}</span>}
                    {isActive && <CornerDownLeft size={13} style={{ color: 'var(--text-faint)' }} className="shrink-0" />}
                  </button>
                )
              })}
            </div>
          )}

          {showRecent && recent.length === 0 && (
            <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              Start typing to search across your organization…
            </div>
          )}

          {q.trim() && !pending && !loading && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No matches for "{q}"
            </div>
          )}

          {!pending && sections.map(section => {
            const meta = CATEGORY_META[section.type]
            const Icon = meta?.icon || Search
            return (
              <div key={section.type} className="mb-1">
                <div className="px-4 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                  {meta?.label || section.type}
                </div>
                {section.items.map(item => {
                  rowIndex += 1
                  const isActive = rowIndex === active
                  const thisRow = rowIndex
                  return (
                    <button
                      key={`${item.type}-${item.id}`}
                      onMouseEnter={() => setActive(thisRow)}
                      onClick={() => go(item)}
                      className="w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors"
                      style={{
                        background: isActive ? 'var(--bg-hover)' : 'transparent',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <Icon size={16} style={{ color: 'var(--text-secondary)' }} className="shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.status && (
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_DOT[item.status] || 'bg-slate-500'}`} />
                      )}
                      <span className="text-xs truncate max-w-[35%]" style={{ color: 'var(--text-muted)' }}>
                        {item.sublabel}
                      </span>
                      {isActive && <CornerDownLeft size={13} style={{ color: 'var(--text-faint)' }} className="shrink-0" />}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div
          className="flex items-center gap-4 px-4 py-2 border-t text-xs"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-faint)' }}
        >
          <span><kbd className="px-1 py-0.5 rounded border" style={{ borderColor: 'var(--border-mid)' }}>↑↓</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded border" style={{ borderColor: 'var(--border-mid)' }}>↵</kbd> {pending ? 'confirm' : 'open'}</span>
          <span><kbd className="px-1 py-0.5 rounded border" style={{ borderColor: 'var(--border-mid)' }}>esc</kbd> {pinModal || confirming ? 'back' : 'close'}</span>
        </div>
      </div>
    </div>
  )
}