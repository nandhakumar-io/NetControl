import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Monitor, Plus, Search, Zap, Power, RotateCcw,
  LayoutGrid, LayoutList, Server, CheckSquare, Square,
  ChevronDown, ChevronRight, Upload, Pencil, Trash2,
  TerminalSquare, RefreshCw, Wifi, WifiOff, HelpCircle,
  SlidersHorizontal, X, AlertOctagon, Users, Wrench, PackageCheck, ArrowUp, ArrowDown, Columns3, Check
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import DeviceModal from '../components/modals/DeviceModal'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'
import FilePushModal from '../components/modals/FilePushModal'
import DeviceRegistrationModal from '../components/modals/DeviceRegistrationModal'
import BulkEditModal from '../components/modals/BulkEditModal'
import SavedViews from '../components/SavedViews'
import { useThemeStore } from '../store/themeStore'
import { usePermissions } from '../hooks/usePermissions'
import { useHighlightParam } from '../hooks/useHighlightParam'

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATUS = {
  online:  { dot: 'bg-accent-green', text: 'Online',  textCls: 'text-accent-green',  ring: 'shadow-[0_0_0_3px_rgba(34,197,94,0.15)]'  },
  offline: { dot: 'bg-slate-500',    text: 'Offline', textCls: 'text-slate-500',     ring: ''  },
  unknown: { dot: 'bg-amber-400',    text: 'Unknown', textCls: 'text-amber-400',     ring: ''  },
  error:   { dot: 'bg-red-400',      text: 'Error',   textCls: 'text-red-400',       ring: ''  },
  needs_approval: { dot: 'bg-brand-400', text: 'Pending Approval', textCls: 'text-brand-400', ring: '' },
}

// ── Status badge pill ─────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.unknown
  return (
    <span className="badge text-sm"
      style={{
        background: status === 'online'  ? 'rgba(34,197,94,0.12)'  :
                    status === 'offline' ? 'rgba(100,116,139,0.12)' :
                    status === 'error'   ? 'rgba(239,68,68,0.12)'   : 'rgba(251,191,36,0.12)',
        border: `1px solid ${
                    status === 'online'  ? 'rgba(34,197,94,0.25)'  :
                    status === 'offline' ? 'rgba(100,116,139,0.25)' :
                    status === 'error'   ? 'rgba(239,68,68,0.25)'   : 'rgba(251,191,36,0.25)'}`,
        color: status === 'online'  ? '#22c55e'  :
               status === 'offline' ? '#64748b'  :
               status === 'error'   ? '#f87171'  : '#fbbf24',
      }}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${status === 'online' ? 'animate-pulse' : ''}`} />
      {s.text}
    </span>
  )
}

// ── Maintenance badge ─────────────────────────────────────────────────────────
// Shown whenever a device is flagged under maintenance — alerts and webhooks
// for that device are suppressed backend-side until it's marked ok again
// (or until maintenance_until passes, if one was set).
function MaintenanceBadge({ note, until }) {
  const untilLabel = until ? new Date(until * 1000).toLocaleString() : null
  const title = [
    note ? `Note: ${note}` : null,
    untilLabel ? `Auto-clears: ${untilLabel}` : 'No auto-clear set',
    'Alerts & webhooks paused for this device',
  ].filter(Boolean).join('\n')
  return (
    <span title={title}
      className="badge text-sm"
      style={{ background: 'rgba(251,146,60,0.12)', border: '1px solid rgba(251,146,60,0.3)', color: '#fb923c' }}>
      <Wrench size={10} />
      Maintenance
    </span>
  )
}

// ── Health score badge ────────────────────────────────────────────────────────
// health = { score, breakdown: {alerts, drift, capacity, uptime}, uptime_pct,
// drift_status, days_to_full } | undefined (still loading or no data at all).
// The number is never a black box — the tooltip spells out exactly which of
// the four factors cost points, matching backend/services/deviceHealthScore.js.
function healthColor(score) {
  if (score >= 85) return '#22c55e'
  if (score >= 60) return '#fbbf24'
  return '#f87171'
}
function HealthBadge({ health, loading }) {
  if (loading && !health) {
    return <span className="text-sm" style={{ color: 'var(--text-faint)' }}>…</span>
  }
  if (!health) return <span className="text-sm" style={{ color: 'var(--text-faint)' }}>—</span>

  const { score, breakdown, uptime_pct, drift_status, days_to_full } = health
  const color = healthColor(score)
  const lines = [`Health score: ${score}/100`]
  lines.push(breakdown.alerts < 0 ? `Open alerts: ${breakdown.alerts} pts` : 'Open alerts: none')
  lines.push(drift_status === 'drift' ? `Config drift detected: ${breakdown.drift} pts` : drift_status === 'clean' ? 'Config drift: clean' : 'Config drift: no data yet')
  lines.push(typeof days_to_full === 'number' ? `Disk projected full in ${Math.round(days_to_full)}d: ${breakdown.capacity} pts` : 'Capacity: stable')
  lines.push(uptime_pct != null ? `7-day uptime ${uptime_pct.toFixed(1)}%: ${breakdown.uptime} pts` : '7-day uptime: no data yet')

  return (
    <span title={lines.join('\n')}
      className="badge text-sm cursor-help"
      style={{ background: `${color}1f`, border: `1px solid ${color}40`, color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {score}
    </span>
  )
}


// Compares a device's reported agent_version against the currently published
// release (services/agentRelease.js / GET /api/agent-release) so it's visible
// right on the Devices page which agents are current vs. need an update —
// same numeric x.y.z comparison the backend uses.
function compareVersions(a, b) {
  const pa = String(a || '0.0.0').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b || '0.0.0').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

// last_seen is written on every metrics ingest (routes/metrics.js), so it's
// a true "last check-in" timestamp — distinct from device.status, which only
// flips to offline once the poller decides last_seen is stale enough. A
// device can sit "online" while quietly not having reported fresh data for
// a while; this is what actually shows that gap.
function fmtLastSeen(ts) {
  if (!ts) return 'never checked in'
  const ageSec = Math.floor(Date.now() / 1000) - ts
  const when = new Date(ts * 1000).toLocaleString()
  if (ageSec < 60) return `${when} (just now)`
  if (ageSec < 3600) return `${when} (${Math.floor(ageSec / 60)}m ago)`
  if (ageSec < 86400) return `${when} (${Math.floor(ageSec / 3600)}h ago)`
  return `${when} (${Math.floor(ageSec / 86400)}d ago)`
}

function AgentVersionBadge({ agentVersion, latestVersion, lastSeen }) {
  const checkinLine = `Last check-in: ${fmtLastSeen(lastSeen)}`
  if (!agentVersion) {
    return (
      <span title={`This device hasn't reported an agent version yet\n${checkinLine}`}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-sm font-mono"
        style={{ background: 'rgba(148,163,184,0.1)', color: 'var(--text-faint)' }}>
        <PackageCheck size={9} /> v?
      </span>
    )
  }
  const outdated = latestVersion && compareVersions(latestVersion, agentVersion) > 0
  return (
    <span
      title={`${outdated ? `Update available: v${latestVersion}` : 'Agent is up to date'}\n${checkinLine}`}
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-sm font-mono font-semibold"
      style={outdated
        ? { background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24' }
        : { background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e' }}>
      <PackageCheck size={9} /> v{agentVersion}
    </span>
  )
}

// ── OS badge ──────────────────────────────────────────────────────────────────
function OsBadge({ osType }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-sm font-mono font-semibold uppercase
      ${osType === 'windows' ? 'bg-sky-400/10 text-sky-400' : 'bg-violet-400/10 text-violet-400'}`}>
      {osType === 'windows' ? <Server size={9} /> : <Monitor size={9} />}
      {osType}
    </span>
  )
}

// ── WoL relay eligibility badge ────────────────────────────────────────────────
// Surfaces services/wol.js#checkEligibility's routing decision so an operator
// can see, before clicking Wake, whether a path even exists: a direct
// same-subnet broadcast, a relay through a named agent, or no path at all
// (the click would still fall back to a direct broadcast as a last resort,
// but that only actually lands if some intermediate hop happens to allow it —
// worth flagging as unreliable rather than staying silent about it).
function WakeEligibilityBadge({ eligibility }) {
  if (!eligibility) return null
  const { method, relayAgent } = eligibility
  if (method === 'direct') return null // same subnet as server — nothing extra to say
  if (method === 'relay') {
    return (
      <span title={`Wake requests for this device are relayed through ${relayAgent}, which is online and on the same subnet.`}
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-sm font-mono"
        style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
        <Zap size={9} /> via {relayAgent}
      </span>
    )
  }
  return (
    <span title="No online relay agent found on this device's subnet, and the server can't broadcast to it directly. Wake will likely fail unless a relay agent comes online."
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-sm font-mono"
      style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
      <AlertOctagon size={9} /> no wake path
    </span>
  )
}

// ── Action button ─────────────────────────────────────────────────────────────
function ActionBtn({ onClick, title, color, children }) {
  const colors = {
    green:  { bg: 'rgba(34,197,94,0.08)',   hbg: 'rgba(34,197,94,0.18)',   border: 'rgba(34,197,94,0.2)',   hborder: 'rgba(34,197,94,0.4)',   text: '#22c55e' },
    red:    { bg: 'rgba(239,68,68,0.08)',    hbg: 'rgba(239,68,68,0.18)',    border: 'rgba(239,68,68,0.2)',    hborder: 'rgba(239,68,68,0.4)',    text: '#f87171' },
    yellow: { bg: 'rgba(251,191,36,0.08)',   hbg: 'rgba(251,191,36,0.18)',   border: 'rgba(251,191,36,0.2)',   hborder: 'rgba(251,191,36,0.4)',   text: '#fbbf24' },
  }
  const c = colors[color]
  return (
    <button onClick={onClick} title={title}
      className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}
      onMouseEnter={e => { e.currentTarget.style.background = c.hbg; e.currentTarget.style.borderColor = c.hborder }}
      onMouseLeave={e => { e.currentTarget.style.background = c.bg;  e.currentTarget.style.borderColor = c.border }}>
      {children}
    </button>
  )
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function Skeleton({ count = 8, view = 'grid' }) {
  if (view === 'list') return (
    <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-surface-2)' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4 animate-pulse" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="w-4 h-4 rounded bg-white/5 shrink-0" />
          <div className="w-8 h-8 rounded-lg bg-white/5 shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 bg-white/5 rounded w-1/3" />
            <div className="h-2.5 bg-white/5 rounded w-1/4" />
          </div>
          <div className="h-3 bg-white/5 rounded w-24 hidden md:block" />
          <div className="h-5 bg-white/5 rounded-full w-16" />
          <div className="h-5 bg-white/5 rounded-full w-16" />
        </div>
      ))}
    </div>
  )
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-2xl p-4 animate-pulse space-y-3"
          style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex gap-3 items-center">
            <div className="w-9 h-9 rounded-xl bg-white/5" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-white/5 rounded w-3/4" />
              <div className="h-2.5 bg-white/5 rounded w-1/2" />
            </div>
          </div>
          <div className="h-2.5 bg-white/5 rounded w-1/3" />
          <div className="flex gap-1.5">
            {[1,2,3].map(j => <div key={j} className="flex-1 h-8 bg-white/5 rounded-lg" />)}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Device Card (grid) ────────────────────────────────────────────────────────
function DeviceCard({ device, selected, onSelect, onWake, onShutdown, onRestart, onEdit, onDelete, onToggleMaintenance, latestAgentVersion, wakeEligibility }) {
  const isLight = useThemeStore(s => s.theme === 'light')
  const status  = device.status || 'unknown'
  const isOnline = status === 'online'
  const inMaintenance = !!device.maintenance_mode

  const openTerminal = (e) => {
    e.stopPropagation()
    window.open(`/terminal/${device.id}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <div id={`hl-${device.id}`} onClick={() => onSelect(device.id)}
      className="relative rounded-2xl p-4 cursor-pointer transition-all duration-200 group"
      style={{
        background: selected
          ? isLight ? 'rgba(108,92,231,0.06)' : 'rgba(167,139,250,0.08)'
          : 'var(--bg-surface-2)',
        border: `1px solid ${selected
          ? isLight ? 'rgba(108,92,231,0.35)' : 'rgba(167,139,250,0.35)'
          : isOnline ? 'rgba(34,197,94,0.2)' : 'var(--border-subtle)'}`,
        boxShadow: selected
          ? isLight ? '0 0 0 3px rgba(108,92,231,0.1)' : '0 0 0 3px rgba(167,139,250,0.08)'
          : 'var(--shadow-card)',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none' }}>

      {/* Selection tick */}
      <div className="absolute top-3 right-3"
        style={{ opacity: selected ? 1 : 0, transition: 'opacity 0.15s' }}>
        <div className="w-5 h-5 rounded-full flex items-center justify-center"
          style={{ background: isLight ? '#6c5ce7' : '#a78bfa' }}>
          <span className="text-white text-xs font-bold">✓</span>
        </div>
      </div>

      {/* Status strip at top */}
      <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-2xl"
        style={{ background: isOnline ? '#22c55e' : status === 'offline' ? '#374151' : '#fbbf24', opacity: 0.6 }} />

      {/* Header */}
      <div className="flex items-start gap-3 mb-3 mt-1">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: device.os_type === 'windows' ? 'rgba(56,189,248,0.1)' : 'rgba(167,139,250,0.1)',
            border: `1px solid ${device.os_type === 'windows' ? 'rgba(56,189,248,0.2)' : 'rgba(167,139,250,0.2)'}`,
          }}>
          {device.os_type === 'windows'
            ? <Server size={16} className="text-sky-400" />
            : <Monitor size={16} className="text-violet-400" />}
        </div>
        <div className="min-w-0 flex-1 pr-4">
          <p className="text-base font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{device.name}</p>
          <p className="text-sm font-mono mt-0.5" style={{ color: 'var(--text-faint)' }}>{device.ip_address}</p>
        </div>
      </div>

      {/* Status + OS row */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <StatusBadge status={status} />
          {inMaintenance && <MaintenanceBadge note={device.maintenance_note} until={device.maintenance_until} />}
          <WakeEligibilityBadge eligibility={wakeEligibility} />
        </div>
        <div className="flex items-center gap-1.5">
          <AgentVersionBadge agentVersion={device.agent_version} latestVersion={latestAgentVersion} lastSeen={device.last_seen} />
          <OsBadge osType={device.os_type} />
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-1.5 mb-2" onClick={e => e.stopPropagation()}>
        <ActionBtn onClick={() => onWake(device)}     title="Wake On LAN" color="green"><Zap size={11} />Wake</ActionBtn>
        <ActionBtn onClick={() => onShutdown(device)} title="Shutdown"    color="red"><Power size={11} />Off</ActionBtn>
        <ActionBtn onClick={() => onRestart(device)}  title="Restart"     color="yellow"><RotateCcw size={11} />Restart</ActionBtn>

        {/* Icon buttons */}
        <button onClick={() => onToggleMaintenance(device)}
          title={inMaintenance ? 'Mark as OK (resume alerts & webhooks)' : 'Mark under maintenance (pause alerts & webhooks)'}
          className="px-2 py-1.5 rounded-lg transition-all text-sm"
          style={inMaintenance
            ? { background: 'rgba(251,146,60,0.14)', border: '1px solid rgba(251,146,60,0.35)', color: '#fb923c' }
            : { background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
          onMouseEnter={e => { if (!inMaintenance) { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = 'var(--border-mid)' } }}
          onMouseLeave={e => { if (!inMaintenance) { e.currentTarget.style.color = 'var(--text-muted)';   e.currentTarget.style.borderColor = 'var(--border-subtle)' } }}>
          <Wrench size={12} />
        </button>
        <button onClick={() => onEdit(device)} title="Edit"
          className="px-2 py-1.5 rounded-lg transition-all text-sm"
          style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = 'var(--border-mid)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)';   e.currentTarget.style.borderColor = 'var(--border-subtle)' }}>
          <Pencil size={12} />
        </button>
        <button onClick={() => onDelete(device)} title="Delete"
          className="px-2 py-1.5 rounded-lg transition-all text-sm"
          style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#f87171';              e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.25)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)';   e.currentTarget.style.background = 'var(--bg-surface-3)';   e.currentTarget.style.borderColor = 'var(--border-subtle)' }}>
          <Trash2 size={12} />
        </button>
      </div>

      {/* Terminal button */}
      {device.ssh_username && (
        <button onClick={openTerminal} title="SSH Terminal"
          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-sm font-semibold transition-all"
          style={{ background: isLight ? 'rgba(108,92,231,0.07)' : 'rgba(167,139,250,0.07)',
                   border: `1px solid ${isLight ? 'rgba(108,92,231,0.2)' : 'rgba(167,139,250,0.2)'}`,
                   color:  isLight ? '#6c5ce7' : '#a78bfa' }}
          onMouseEnter={e => { e.currentTarget.style.background = isLight ? 'rgba(108,92,231,0.14)' : 'rgba(167,139,250,0.14)' }}
          onMouseLeave={e => { e.currentTarget.style.background = isLight ? 'rgba(108,92,231,0.07)' : 'rgba(167,139,250,0.07)' }}>
          <TerminalSquare size={11} /> Remote Access
        </button>
      )}

      {/* Tags — freeform ad-hoc labels, independent of the group hierarchy */}
      {device.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2.5" onClick={e => e.stopPropagation()}>
          {device.tags.map(tag => (
            <span key={tag} className="text-[11px] font-mono px-1.5 py-0.5 rounded-md"
              style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', color: '#a78bfa' }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Group tag */}
      {device.group_name && (
        <div className="mt-2.5 pt-2.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <span className="text-sm" style={{ color: 'var(--text-faint)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Group: </span>{device.group_name}
          </span>
        </div>
      )}
    </div>
  )
}

// ── Group section header ──────────────────────────────────────────────────────
function GroupSection({ groupName, devices, selectedIds, onSelect, onWake, onShutdown, onRestart, onEdit, onDelete, onToggleMaintenance, latestAgentVersion, wakeEligibility }) {
  const [open, setOpen] = useState(true)
  const online  = devices.filter(d => d.status === 'online').length
  const total   = devices.length
  const allSel  = devices.every(d => selectedIds.has(d.id))

  return (
    <div className="mb-8">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 mb-4 group">
        <span style={{ color: 'var(--text-faint)', transition: 'color 0.15s' }}
          className="group-hover:text-[var(--text-muted)]">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className="text-base font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
          {groupName}
        </span>
        <span className="text-sm font-mono" style={{ color: 'var(--text-faint)' }}>
          {online}/{total}
        </span>
        {/* Progress bar */}
        <div className="flex-1 max-w-[60px] h-1 rounded-full overflow-hidden" style={{ background: 'var(--border-subtle)' }}>
          <div className="h-full rounded-full bg-accent-green transition-all duration-700"
            style={{ width: total ? `${(online / total) * 100}%` : '0%', opacity: 0.7 }} />
        </div>
        {/* Select all */}
        <button onClick={e => { e.stopPropagation(); devices.forEach(d => onSelect(d.id, !allSel)) }}
          className="ml-auto flex items-center gap-1.5 text-sm font-semibold transition-colors px-2 py-1 rounded-lg"
          style={{ color: allSel ? '#a78bfa' : 'var(--text-faint)', background: allSel ? 'rgba(167,139,250,0.1)' : 'transparent' }}>
          {allSel ? <CheckSquare size={11} /> : <Square size={11} />}
          <span className="hidden sm:inline">Select all</span>
        </button>
      </button>

      {open && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {devices.map(d => (
            <DeviceCard key={d.id} device={d}
              selected={selectedIds.has(d.id)}
              onSelect={id => onSelect(id, !selectedIds.has(id))}
              onWake={onWake} onShutdown={onShutdown} onRestart={onRestart}
              onEdit={onEdit} onDelete={onDelete} onToggleMaintenance={onToggleMaintenance}
              latestAgentVersion={latestAgentVersion} wakeEligibility={wakeEligibility?.[d.id]} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── List row ──────────────────────────────────────────────────────────────────
// Builds the list view's grid-template-columns string from which optional
// columns (MAC/OS/Agent) are toggled on — shared by the header row and
// every DeviceListRow so they can never drift out of alignment with
// each other.
function deviceGridCols(visibleCols) {
  return [
    '40px', '36px', '1fr', '140px',
    visibleCols.mac   && '140px',
    visibleCols.os    && '90px',
    visibleCols.agent && '100px',
    '90px', '100px', 'auto',
  ].filter(Boolean).join(' ')
}

function ColumnsMenu({ visibleCols, onToggle, isLight }) {
  const [open, setOpen] = React.useState(false)
  const boxRef = React.useRef(null)
  const COLS = [
    { key: 'mac',   label: 'MAC Address' },
    { key: 'os',    label: 'OS' },
    { key: 'agent', label: 'Agent' },
  ]

  React.useEffect(() => {
    const onDocClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  return (
    <div className="relative" ref={boxRef}>
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-all"
        style={{ color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', background: open ? 'var(--bg-surface-3)' : 'transparent' }}>
        <Columns3 size={12} />
        <span className="hidden sm:inline">Columns</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-48 rounded-xl shadow-xl z-50 overflow-hidden py-1"
          style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
          {COLS.map(c => (
            <button key={c.key} onClick={() => onToggle(c.key)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-white/[0.04]"
              style={{ color: 'var(--text-primary)' }}>
              {c.label}
              {visibleCols[c.key] && <Check size={13} style={{ color: isLight ? '#6c5ce7' : '#a78bfa' }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DeviceListRow({ device, group, selected, highlighted, onSelect, onWake, onShutdown, onRestart, onEdit, onDelete, onToggleMaintenance, latestAgentVersion, health, healthLoading, visibleCols, wakeEligibility }) {
  const status = device.status || 'unknown'
  const isLight = useThemeStore(s => s.theme === 'light')
  const inMaintenance = !!device.maintenance_mode

  const openTerminal = (e) => {
    e.stopPropagation()
    window.open(`/terminal/${device.id}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <div id={`hl-${device.id}`}
      className="table-row grid items-center gap-3 px-4 cursor-pointer transition-all group"
      style={{
        gridTemplateColumns: deviceGridCols(visibleCols),
        borderBottom: '1px solid var(--border-subtle)',
        background: highlighted ? (isLight ? 'rgba(108,92,231,0.08)' : 'rgba(167,139,250,0.10)')
          : selected ? (isLight ? 'rgba(108,92,231,0.04)' : 'rgba(167,139,250,0.05)') : 'transparent',
        borderLeft: `2px solid ${highlighted ? (isLight ? '#6c5ce7' : '#a78bfa') : selected ? (isLight ? '#6c5ce7' : '#a78bfa') : 'transparent'}`,
        boxShadow: highlighted ? (isLight ? 'inset 0 0 0 1px rgba(108,92,231,0.35)' : 'inset 0 0 0 1px rgba(167,139,250,0.35)') : 'none',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = highlighted ? (isLight ? 'rgba(108,92,231,0.08)' : 'rgba(167,139,250,0.10)') : 'transparent' }}
      onClick={() => onSelect(device.id, !selected)}>

      {/* Checkbox */}
      <div className="flex items-center justify-center" onClick={e => e.stopPropagation()}>
        <button onClick={() => onSelect(device.id, !selected)}
          style={{ color: selected ? (isLight ? '#6c5ce7' : '#a78bfa') : 'var(--text-faint)' }}>
          {selected ? <CheckSquare size={14} /> : <Square size={14} />}
        </button>
      </div>

      {/* OS icon */}
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{
          background: device.os_type === 'windows' ? 'rgba(56,189,248,0.1)' : 'rgba(167,139,250,0.1)',
          border: `1px solid ${device.os_type === 'windows' ? 'rgba(56,189,248,0.2)' : 'rgba(167,139,250,0.2)'}`,
        }}>
        {device.os_type === 'windows'
          ? <Server size={14} className="text-sky-400" />
          : <Monitor size={14} className="text-violet-400" />}
      </div>

      {/* Name */}
      <div className="min-w-0">
        <p className="text-base font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{device.name}</p>
        {group && <p className="text-sm truncate" style={{ color: 'var(--text-faint)' }}>{group.name}</p>}
        {device.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {device.tags.map(tag => (
              <span key={tag} className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', color: '#a78bfa' }}>
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* IP */}
      <p className="text-sm font-mono truncate" style={{ color: 'var(--text-muted)' }}>{device.ip_address}</p>

      {/* MAC */}
      {visibleCols.mac && <p className="text-sm font-mono truncate" style={{ color: 'var(--text-faint)' }}>{device.mac_address}</p>}

      {/* OS badge */}
      {visibleCols.os && <div><OsBadge osType={device.os_type} /></div>}

      {/* Agent version */}
      {visibleCols.agent && <div><AgentVersionBadge agentVersion={device.agent_version} latestVersion={latestAgentVersion} lastSeen={device.last_seen} /></div>}

      {/* Health score */}
      <div><HealthBadge health={health} loading={healthLoading} /></div>

      {/* Status */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <StatusBadge status={status} />
        {inMaintenance && <MaintenanceBadge note={device.maintenance_note} until={device.maintenance_until} />}
        <WakeEligibilityBadge eligibility={wakeEligibility} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={e => e.stopPropagation()}>
        {[
          { fn: () => onWake(device),     icon: <Zap size={12} />,        color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   title: 'Wake'     },
          { fn: () => onShutdown(device), icon: <Power size={12} />,      color: '#f87171', bg: 'rgba(239,68,68,0.1)',   title: 'Shutdown' },
          { fn: () => onRestart(device),  icon: <RotateCcw size={12} />,  color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  title: 'Restart'  },
          { fn: () => onToggleMaintenance(device), icon: <Wrench size={12} />, color: '#fb923c', bg: 'rgba(251,146,60,0.1)',
            title: inMaintenance ? 'Mark as OK (resume alerts & webhooks)' : 'Mark under maintenance (pause alerts & webhooks)' },
          { fn: () => onEdit(device),     icon: <Pencil size={12} />,     color: null,       bg: null,                   title: 'Edit'     },
        ].map((a, i) => (
          <button key={i} onClick={a.fn} title={a.title}
            className="p-1.5 rounded-lg transition-all"
            style={{ color: a.title === 'Mark as OK (resume alerts & webhooks)' ? '#fb923c' : (a.color || 'var(--text-muted)') }}
            onMouseEnter={e => { if (a.bg) { e.currentTarget.style.background = a.bg }; e.currentTarget.style.color = a.color || 'var(--text-primary)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = a.title === 'Mark as OK (resume alerts & webhooks)' ? '#fb923c' : (a.color || 'var(--text-muted)') }}>
            {a.icon}
          </button>
        ))}
        {device.ssh_username && (
          <button onClick={openTerminal} title="Terminal"
            className="p-1.5 rounded-lg transition-all"
            style={{ color: isLight ? '#6c5ce7' : '#a78bfa' }}
            onMouseEnter={e => { e.currentTarget.style.background = isLight ? 'rgba(108,92,231,0.1)' : 'rgba(167,139,250,0.1)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
            <TerminalSquare size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Bulk bar ──────────────────────────────────────────────────────────────────
function BulkBar({ count, onWakeAll, onShutdownAll, onRestartAll, onPushFile, onEditSelected, onMaintenanceAll, onAgentUpdateAll, onClear, canEdit }) {
  if (!count) return null
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 animate-slide-up">
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl flex-wrap justify-center"
        style={{ background: 'var(--bg-surface-1)', border: '1px solid var(--border-mid)',
                 boxShadow: '0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2)' }}>
        <span className="text-base font-semibold px-2" style={{ color: '#a78bfa' }}>
          {count} selected
        </span>
        <div className="w-px h-4" style={{ background: 'var(--border-subtle)' }} />
        {canEdit && (
          <button onClick={onEditSelected}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-semibold transition-all"
            style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.3)', color: '#a78bfa' }}>
            <Users size={12} />Edit Selected
          </button>
        )}
        {[
          { fn: onWakeAll,     label: 'Wake All',  icon: <Zap size={11} />,       c: '#22c55e', bg: 'rgba(34,197,94,0.1)',  bc: 'rgba(34,197,94,0.25)'  },
          { fn: onShutdownAll, label: 'Shutdown',  icon: <Power size={11} />,     c: '#f87171', bg: 'rgba(239,68,68,0.1)',  bc: 'rgba(239,68,68,0.25)'  },
          { fn: onRestartAll,  label: 'Restart',   icon: <RotateCcw size={11} />, c: '#fbbf24', bg: 'rgba(251,191,36,0.1)', bc: 'rgba(251,191,36,0.25)' },
          { fn: onMaintenanceAll, label: 'Maintenance', icon: <Wrench size={11} />, c: '#fb923c', bg: 'rgba(251,146,60,0.1)', bc: 'rgba(251,146,60,0.25)' },
          { fn: onAgentUpdateAll, label: 'Update Agent', icon: <PackageCheck size={11} />, c: '#38bdf8', bg: 'rgba(56,189,248,0.1)', bc: 'rgba(56,189,248,0.25)' },
          { fn: onPushFile,    label: 'Push File', icon: <Upload size={11} />,    c: '#38bdf8', bg: 'rgba(56,189,248,0.1)', bc: 'rgba(56,189,248,0.25)' },
        ].filter(b => b.fn).map((b, i) => (
          <button key={i} onClick={b.fn}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-semibold transition-all"
            style={{ background: b.bg, border: `1px solid ${b.bc}`, color: b.c }}>
            {b.icon}{b.label}
          </button>
        ))}
        <div className="w-px h-4" style={{ background: 'var(--border-subtle)' }} />
        <button onClick={onClear} className="text-sm px-1 transition-colors"
          style={{ color: 'var(--text-faint)' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--text-muted)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
          <X size={13} />
        </button>
      </div>
    </div>
  )
}

// ── Summary stat ──────────────────────────────────────────────────────────────
function StatPill({ value, label, color, dot }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl"
      style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
      {dot && <span className="w-2 h-2 rounded-full" style={{ background: color }} />}
      <span className="text-base font-mono font-bold" style={{ color }}>{value}</span>
      <span className="text-sm" style={{ color: 'var(--text-faint)' }}>{label}</span>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function DevicesPage() {
  const [devices, setDevices]           = useState([])
  const [groups,  setGroups]            = useState([])
  const [loading, setLoading]           = useState(true)
  const [refreshing, setRefreshing]     = useState(false)
  const [search,  setSearch]            = useState('')
  const [osFilter, setOsFilter]         = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [groupFilter, setGroupFilter]   = useState('all')
  // Freeform ad-hoc labels, independent of the group hierarchy — lets
  // someone slice the fleet by e.g. "prod" + "k8s-node" without having to
  // restructure groups just to get a temporary view.
  const [tagFilter, setTagFilter]       = useState(new Set())
  const [allTags, setAllTags]           = useState([]) // [{ tag, device_count }]
  const [viewMode, setViewMode]         = useState('grid')
  const [selectedIds, setSelectedIds]   = useState(new Set())
  const [deviceModal, setDeviceModal]   = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [actionModal, setActionModal]   = useState(null)
  const [filePushOpen, setFilePushOpen] = useState(false)
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const [registrationTarget, setRegistrationTarget] = useState(null)
  const [latestAgentVersion, setLatestAgentVersion] = useState(null)
  const [healthScores, setHealthScores] = useState({}) // { [deviceId]: { score, breakdown, ... } }
  const [healthLoading, setHealthLoading] = useState(true)
  const [wakeEligibility, setWakeEligibility] = useState({}) // { [deviceId]: { method: 'direct'|'relay'|'none', relayAgent? } }
  const [sortKey, setSortKey] = useState(null) // null | 'health'
  const [sortDir, setSortDir] = useState('asc') // 'asc' surfaces worst-health-first, which is the point of sorting by it
  // List view column visibility — MAC/OS/Agent are the columns worth
  // hiding on a narrow monitor or when they're just not relevant to what
  // you're triaging right now. Checkbox/Device/IP/Health/Status/Actions
  // stay pinned since they're needed for the row's core actions.
  const [visibleCols, setVisibleCols] = useState({ mac: true, os: true, agent: true })
  const toggleCol = (key) => setVisibleCols(v => ({ ...v, [key]: !v[key] }))
  const isLight = useThemeStore(s => s.theme === 'light')
  const { isAdmin } = usePermissions()

  const fetchAll = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    else setRefreshing(true)
    try {
      const [d, g, t] = await Promise.all([api.get('/devices'), api.get('/groups'), api.get('/devices/tags').catch(() => ({ data: [] }))])
      setDevices(d.data)
      setGroups(g.data)
      setAllTags(t.data)
    } catch { toast.error('Failed to load devices') }
    finally { setLoading(false); setRefreshing(false) }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Composite health score — rolls up open alerts, drift, capacity runway,
  // and uptime (see backend/services/deviceHealthScore.js). Fetched
  // separately from the device list itself since it's a heavier computation
  // (touches four other tables) and shouldn't block the page's first paint.
  useEffect(() => {
    setHealthLoading(true)
    api.get('/devices/health-scores')
      .then(({ data }) => setHealthScores(data))
      .catch(() => setHealthScores({}))
      .finally(() => setHealthLoading(false))
  }, [])

  // Wake-on-LAN relay eligibility — which agent (if any) would actually
  // carry a wake request to each device (services/wol.js#checkEligibility).
  // Computed server-side without sending any packet; surfaced as a
  // "Wake-capable via: <agent>" indicator so a dead-end relay path is
  // visible before clicking Wake, not discovered after it silently falls
  // back to a direct broadcast that never reaches the device.
  useEffect(() => {
    api.get('/devices/wake-eligibility')
      .then(({ data }) => setWakeEligibility(data))
      .catch(() => setWakeEligibility({}))
  }, [devices])

  // Published agent release version (services/agentRelease.js), used to flag
  // devices running an older agent build. 404 just means no release has been
  // published yet — not an error worth surfacing here.
  useEffect(() => {
    api.get('/agent-release')
      .then(({ data }) => setLatestAgentVersion(data?.version || null))
      .catch(() => setLatestAgentVersion(null))
  }, [])

  // Auto-refresh device statuses in the background so online/offline state
  // doesn't go stale while the page sits open (backend polls every 5s).
  useEffect(() => {
    const t = setInterval(() => { fetchAll(true) }, 5000)
    return () => clearInterval(t)
  }, [fetchAll])

  const handleSelect = (id, sel) => setSelectedIds(prev => {
    const n = new Set(prev); sel ? n.add(id) : n.delete(id); return n
  })
  const clearSelection = () => setSelectedIds(new Set())

  const handleAction = (type, device) => setActionModal({ type, device })

  const executeAction = async (pin) => {
    const { type, device } = actionModal
    const { data } = await api.post(`/actions/${type}`, { deviceId: device.id, actionPin: pin })
    return data
  }

  const bulkAction = (type) => {
    const targets = devices.filter(d => selectedIds.has(d.id))
    if (!targets.length) return
    setActionModal({ type, device: { name: `${targets.length} devices`, id: '__bulk__' }, bulk: targets })
  }

  const executeBulkAction = async (pin) => {
    const { type, bulk } = actionModal
    const settled = await Promise.allSettled(
      bulk.map(d => api.post(`/actions/${type}`, { deviceId: d.id, actionPin: pin }))
    )
    clearSelection()
    // A rejected settlement here (403 access denied, 409 under maintenance,
    // etc.) used to just disappear from allResults — flatMap only pulled
    // from the 'fulfilled' branch — so a locked device silently vanished
    // from the count instead of showing up with its actual reason.
    // Promise.allSettled preserves input order, so index back into `bulk`
    // to know which device a rejection belonged to.
    const allResults = settled.flatMap((s, i) => {
      if (s.status === 'fulfilled') return s.value.data.results || []
      const device = bulk[i]
      return [{
        device: device.name, id: device.id, result: 'failure',
        details: s.reason?.response?.data?.error || s.reason?.message || 'Request failed',
      }]
    })
    const failed  = allResults.filter(r => r.result !== 'success').length
    const overall = allResults.length === 0 ? 'failure' : failed === 0 ? 'success' : failed === allResults.length ? 'failure' : 'partial'
    return { results: allResults, overall }
  }

  const handleDelete = async () => {
    try {
      await api.delete(`/devices/${deleteTarget.id}`)
      toast.success('Device removed')
      setDeleteTarget(null)
      fetchAll(true)
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed') }
  }

  // Prompts for an optional note + optional auto-clear duration when
  // enabling maintenance. Returns null if the user cancels either prompt.
  const promptMaintenanceDetails = (label) => {
    const note = window.prompt(
      `Mark ${label} under maintenance?\nAlerts & webhooks will pause until marked OK again.\n\nOptional note:`, ''
    )
    if (note === null) return null // cancelled
    const durationRaw = window.prompt(
      `Auto-clear after how many minutes? (e.g. 60 = 1 hour, 1440 = 1 day)\nLeave blank to require a manual "mark OK" instead.`, ''
    )
    if (durationRaw === null) return null // cancelled
    const duration_minutes = durationRaw.trim() ? parseInt(durationRaw, 10) : null
    if (durationRaw.trim() && (!Number.isFinite(duration_minutes) || duration_minutes <= 0)) {
      toast.error('Duration must be a positive number of minutes')
      return null
    }
    return { note: note || undefined, duration_minutes: duration_minutes || undefined }
  }

  const handleToggleMaintenance = async (device) => {
    const enabling = !device.maintenance_mode
    let details = { note: undefined, duration_minutes: undefined }
    if (enabling) {
      const result = promptMaintenanceDetails(`"${device.name}"`)
      if (!result) return
      details = result
    }
    try {
      await api.post(`/devices/${device.id}/maintenance`, { enabled: enabling, ...details })
      toast.success(
        enabling
          ? `${device.name} marked under maintenance${details.duration_minutes ? ` for ${details.duration_minutes}m` : ''}`
          : `${device.name} marked OK`
      )
      fetchAll(true)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update maintenance mode')
    }
  }

  const bulkToggleMaintenance = async () => {
    const targets = devices.filter(d => selectedIds.has(d.id))
    if (!targets.length) return
    // Mixed selection (some already under maintenance, some not) — default
    // to enabling, since that's the far more common bulk action (start of
    // a patch window). Clearing a mixed batch is still one click away by
    // re-selecting just the ones that need it.
    const enabling = !targets.every(d => d.maintenance_mode)
    let details = { note: undefined, duration_minutes: undefined }
    if (enabling) {
      const result = promptMaintenanceDetails(`${targets.length} device(s)`)
      if (!result) return
      details = result
    }
    try {
      const { data } = await api.post('/devices/bulk-maintenance', {
        deviceIds: targets.map(d => d.id), enabled: enabling, ...details,
      })
      toast.success(
        enabling
          ? `${data.updated} device(s) marked under maintenance${details.duration_minutes ? ` for ${details.duration_minutes}m` : ''}`
          : `${data.updated} device(s) marked OK`
      )
      if (data.skipped) toast(`${data.skipped} device(s) skipped — no access`, { icon: '⚠️' })
      clearSelection()
      fetchAll(true)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update maintenance mode')
    }
  }

  // Queues an immediate agent self-update for the selected devices (admin
  // only — matches the backend's requireRole('admin') on
  // POST /devices/bulk-agent-update). Devices without an agent (agentless/
  // SSH-only) are silently skipped server-side since there's nothing to
  // update on them; the response tells us how many that was.
  const bulkAgentUpdate = async () => {
    const targets = devices.filter(d => selectedIds.has(d.id))
    if (!targets.length) return
    if (!window.confirm(`Queue an immediate agent update for ${targets.length} device(s)? Each agent will download and apply the current release on its next check-in.`)) return
    try {
      const { data } = await api.post('/devices/bulk-agent-update', {
        deviceIds: targets.map(d => d.id),
      })
      toast.success(`Update queued for ${data.requested} device(s)`)
      if (data.skipped) toast(`${data.skipped} device(s) skipped — not agent-managed`, { icon: 'ℹ️' })
      clearSelection()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to queue agent update')
    }
  }

  const handleDeleteAll = async () => {
    try {
      const { data } = await api.delete('/devices')
      toast.success(data.message || 'All devices deleted')
      setDeleteAllOpen(false)
      clearSelection()
      fetchAll(true)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed')
      throw err
    }
  }

  // Devices awaiting admin approval (from agent self-registration) are kept
  // separate from the main grid/list — they aren't fully configured yet.
  const pendingDevices = useMemo(() => devices.filter(d => d.status === 'needs_approval'), [devices])
  const manageableDevices = useMemo(() => devices.filter(d => d.status !== 'needs_approval'), [devices])

  // Filtering
  const filtered = useMemo(() => {
    const base = manageableDevices.filter(d => {
      const q = search.toLowerCase()
      if (q && !d.name.toLowerCase().includes(q) && !d.ip_address.includes(q) && !(d.mac_address||'').toLowerCase().includes(q)) return false
      if (osFilter !== 'all' && d.os_type !== osFilter) return false
      if (statusFilter !== 'all' && d.status !== statusFilter) return false
      if (groupFilter !== 'all' && d.group_id !== groupFilter) return false
      if (tagFilter.size > 0 && !(d.tags || []).some(t => tagFilter.has(t))) return false
      return true
    })
    if (sortKey === 'health') {
      const withScore = [...base].sort((a, b) => {
        // Devices with no score yet (still loading, or no signal at all)
        // sink to the bottom regardless of direction — an unknown score
        // isn't "healthy", it's just not computed, so it shouldn't rank
        // above a device with a known problem.
        const sa = healthScores[a.id]?.score
        const sb = healthScores[b.id]?.score
        if (sa == null && sb == null) return 0
        if (sa == null) return 1
        if (sb == null) return -1
        return sortDir === 'asc' ? sa - sb : sb - sa
      })
      return withScore
    }
    return base
  }, [manageableDevices, search, osFilter, statusFilter, groupFilter, tagFilter, sortKey, sortDir, healthScores])

  // Grouped for grid view
  const grouped = useMemo(() => {
    const map = new Map([['ungrouped', { name: 'Ungrouped', devices: [] }]])
    groups.forEach(g => map.set(g.id, { name: g.name, devices: [] }))
    filtered.forEach(d => {
      const key = d.group_id && map.has(d.group_id) ? d.group_id : 'ungrouped'
      map.get(key).devices.push(d)
    })
    return [...map.entries()].filter(([,v]) => v.devices.length > 0).map(([id,v]) => ({ id, ...v }))
  }, [filtered, groups])

  const onlineCount  = manageableDevices.filter(d => d.status === 'online').length
  const offlineCount = manageableDevices.filter(d => d.status === 'offline').length
  const unknownCount = manageableDevices.filter(d => !d.status || d.status === 'unknown').length
  const hasFilters   = search || osFilter !== 'all' || statusFilter !== 'all' || groupFilter !== 'all' || tagFilter.size > 0

  // ── Jump-to-device from global search (Cmd+K → Enter) ─────────────────────
  // Arriving here via /devices?highlight=<id> should reliably show that
  // device even if a filter left over from a previous visit would otherwise
  // hide it — so any active filter is cleared once, on arrival with a
  // highlight param, before the scroll-into-view below runs.
  const highlightId = useHighlightParam(!loading && filtered.length > 0)
  useEffect(() => {
    if (!highlightId) return
    setSearch(''); setOsFilter('all'); setStatusFilter('all'); setGroupFilter('all'); setTagFilter(new Set())
    setViewMode('list') // a single highlighted row reads more clearly in the list view than buried in a grid
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId])

  const clearFilters = () => { setSearch(''); setOsFilter('all'); setStatusFilter('all'); setGroupFilter('all'); setTagFilter(new Set()) }
  const currentFilters = { search, osFilter, statusFilter, groupFilter, tagFilter: [...tagFilter], sortKey, sortDir, visibleCols }
  const applyView = (f) => {
    setSearch(f.search || '')
    setOsFilter(f.osFilter || 'all')
    setStatusFilter(f.statusFilter || 'all')
    setGroupFilter(f.groupFilter || 'all')
    setTagFilter(new Set(f.tagFilter || []))
    setSortKey(f.sortKey ?? null)
    setSortDir(f.sortDir || 'asc')
    setVisibleCols(f.visibleCols || { mac: true, os: true, agent: true })
  }
  const toggleTagFilter = (tag) => {
    setTagFilter(prev => {
      const next = new Set(prev)
      next.has(tag) ? next.delete(tag) : next.add(tag)
      return next
    })
  }

  // Map a device row (id/name) onto the shape DeviceRegistrationModal expects
  // (device_id/device_name), since the modal is shared with the live agent
  // check-in flow which uses those field names.
  const openRegistrationReview = (d) => setRegistrationTarget({
    device_id: d.id,
    device_name: d.name,
    ip_address: d.ip_address,
    mac_address: d.mac_address,
    os_type: d.os_type,
  })

  return (
    <div className="page-shell animate-fade-in">

      {/* Header */}
      <PageHeader
        icon={Monitor}
        title="Devices"
        description="Manage and control all registered machines"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {/* Live stats */}
            <div className="hidden sm:flex items-center gap-2">
              <StatPill value={onlineCount}  label="online"  color="#22c55e" dot />
              <StatPill value={offlineCount} label="offline" color="#64748b" dot />
              {unknownCount > 0 && <StatPill value={unknownCount} label="unknown" color="#fbbf24" dot />}
            </div>
            <button onClick={() => fetchAll(true)} title="Refresh"
              className="p-2 rounded-xl transition-all"
              style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setFilePushOpen(true)} className="btn-ghost">
              <Upload size={14} /> Push File
            </button>
            {isAdmin && devices.length > 0 && (
              <button onClick={() => setDeleteAllOpen(true)} title="Delete all devices"
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold transition-all"
                style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.16)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(239,68,68,0.08)'}>
                <AlertOctagon size={13} /> Delete All
              </button>
            )}
            <button onClick={() => setDeviceModal('add')} className="btn-primary">
              <Plus size={14} /> Add Device
            </button>
          </div>
        }
      />

      {/* Pending agent registrations — require admin review before a device is usable */}
      {pendingDevices.length > 0 && (
        <div className="mb-6 rounded-2xl p-4 animate-fade-in"
          style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.25)' }}>
          <div className="flex items-center gap-2 mb-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-brand-400" />
            </span>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {pendingDevices.length} device{pendingDevices.length > 1 ? 's' : ''} awaiting approval
            </p>
          </div>
          <div className="flex flex-col gap-2">
            {pendingDevices.map(d => (
              <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl transition-colors"
                style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className={`shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg
                    ${d.os_type === 'windows' ? 'bg-sky-400/10 text-sky-400' : 'bg-violet-400/10 text-violet-400'}`}>
                    {d.os_type === 'windows' ? <Server size={13} /> : <Monitor size={13} />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</p>
                    <p className="text-sm font-mono truncate" style={{ color: 'var(--text-faint)' }}>
                      {d.ip_address} · {d.mac_address}
                    </p>
                  </div>
                </div>
                {isAdmin ? (
                  <button onClick={() => openRegistrationReview(d)}
                    className="shrink-0 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all hover:bg-[rgba(167,139,250,0.2)]"
                    style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.3)', color: '#a78bfa' }}>
                    Review
                  </button>
                ) : (
                  <span className="text-sm shrink-0" style={{ color: 'var(--text-faint)' }}>Admin approval required</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-6 p-3 rounded-2xl"
        style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>

        {/* Search */}
        <div className="relative min-w-[180px] flex-1 max-w-xs">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-faint)' }} />
          <input className="input-field pl-8 h-9 text-sm" placeholder="Search name, IP, MAC…"
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        {/* Divider */}
        <div className="w-px h-5 hidden sm:block" style={{ background: 'var(--border-subtle)' }} />

        {/* OS filter */}
        <div className="flex gap-1">
          {[['all','All OS'], ['linux','Linux'], ['windows','Windows']].map(([v,l]) => (
            <button key={v} onClick={() => setOsFilter(v)}
              className="px-3 py-1.5 rounded-lg text-sm font-semibold transition-all"
              style={{
                background: osFilter === v ? (isLight ? '#6c5ce7' : '#a78bfa') : 'transparent',
                color: osFilter === v ? '#fff' : 'var(--text-muted)',
                border: `1px solid ${osFilter === v ? 'transparent' : 'var(--border-subtle)'}`,
              }}>{l}</button>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex gap-1">
          {[['all','All'],['online','Online'],['offline','Offline']].map(([v,l]) => (
            <button key={v} onClick={() => setStatusFilter(v)}
              className="px-3 py-1.5 rounded-lg text-sm font-semibold transition-all flex items-center gap-1.5"
              style={{
                background: statusFilter === v
                  ? v === 'online' ? 'rgba(34,197,94,0.15)' : v === 'offline' ? 'rgba(100,116,139,0.15)' : (isLight ? '#6c5ce7' : '#a78bfa')
                  : 'transparent',
                color: statusFilter === v
                  ? v === 'online' ? '#22c55e' : v === 'offline' ? '#94a3b8' : '#fff'
                  : 'var(--text-muted)',
                border: `1px solid ${statusFilter === v
                  ? v === 'online' ? 'rgba(34,197,94,0.3)' : v === 'offline' ? 'rgba(100,116,139,0.3)' : 'transparent'
                  : 'var(--border-subtle)'}`,
              }}>
              {v !== 'all' && <span className="w-1.5 h-1.5 rounded-full" style={{ background: v === 'online' ? '#22c55e' : '#64748b' }} />}
              {l}
            </button>
          ))}
        </div>

        {/* Group filter */}
        {groups.length > 0 && (
          <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)}
            className="input-field h-9 text-sm py-0" style={{ minWidth: 130 }}>
            <option value="all">All Groups</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}

        {/* Tag filter — freeform ad-hoc slicing independent of groups; matches
            ANY selected tag (OR), so picking "prod" + "k8s-node" shows every
            device carrying either label rather than requiring both. */}
        {allTags.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {allTags.map(({ tag, device_count }) => {
              const active = tagFilter.has(tag)
              return (
                <button key={tag} onClick={() => toggleTagFilter(tag)}
                  title={`${device_count} device${device_count === 1 ? '' : 's'}`}
                  className="text-xs font-mono px-2 py-1 rounded-lg transition-all"
                  style={{
                    background: active ? (isLight ? '#6c5ce7' : '#a78bfa') : 'var(--bg-surface-3)',
                    color: active ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${active ? 'transparent' : 'var(--border-subtle)'}`,
                  }}>
                  {tag}
                </button>
              )
            })}
          </div>
        )}

        <div className="flex-1" />

        {/* List view column visibility — grid-only toggle */}
        {viewMode === 'list' && (
          <ColumnsMenu visibleCols={visibleCols} onToggle={toggleCol} isLight={isLight} />
        )}

        {/* Saved views */}
        <SavedViews page="devices" filters={currentFilters} onApply={applyView} isLight={isLight} />

        {/* Clear filters */}
        {hasFilters && (
          <button onClick={clearFilters}
            className="flex items-center gap-1 text-sm px-2 py-1.5 rounded-lg transition-all"
            style={{ color: isLight ? '#6c5ce7' : '#a78bfa', background: isLight ? 'rgba(108,92,231,0.08)' : 'rgba(167,139,250,0.08)' }}>
            <X size={11} /> Clear
          </button>
        )}

        <span className="text-sm font-mono" style={{ color: 'var(--text-faint)' }}>
          {filtered.length}/{devices.length}
        </span>

        {/* View toggle */}
        <div className="flex gap-0.5 p-0.5 rounded-lg" style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)' }}>
          {[['grid', LayoutGrid], ['list', LayoutList]].map(([mode, Icon]) => (
            <button key={mode} onClick={() => setViewMode(mode)}
              className="p-1.5 rounded-md transition-all"
              style={{
                background: viewMode === mode ? (isLight ? '#6c5ce7' : '#a78bfa') : 'transparent',
                color: viewMode === mode ? '#fff' : 'var(--text-muted)',
              }} title={`${mode} view`}>
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <Skeleton count={8} view={viewMode} />

      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 animate-fade-in">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
            {hasFilters ? <SlidersHorizontal size={24} style={{ color: 'var(--text-faint)' }} />
                        : <Monitor size={24} style={{ color: 'var(--text-faint)' }} />}
          </div>
          <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
            {hasFilters ? 'No devices match your filters' : 'No devices added yet'}
          </p>
          <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
            {hasFilters ? 'Try adjusting search or filters' : 'Add your first device to get started'}
          </p>
          {hasFilters
            ? <button onClick={clearFilters} className="btn-ghost text-sm">Clear filters</button>
            : <button onClick={() => setDeviceModal('add')} className="btn-primary"><Plus size={14} /> Add Device</button>
          }
        </div>

      ) : viewMode === 'grid' ? (
        <div className="animate-fade-in">
          {grouped.map(({ id, name, devices: gd }) => (
            <GroupSection key={id} groupName={name} devices={gd}
              selectedIds={selectedIds} onSelect={handleSelect}
              onWake={d => handleAction('wake', d)}
              onShutdown={d => handleAction('shutdown', d)}
              onRestart={d => handleAction('restart', d)}
              onEdit={d => setDeviceModal(d)}
              onDelete={d => setDeleteTarget(d)}
              onToggleMaintenance={handleToggleMaintenance}
              latestAgentVersion={latestAgentVersion}
              wakeEligibility={wakeEligibility} />
          ))}
        </div>

      ) : (
        <div className="rounded-2xl overflow-hidden animate-fade-in"
          style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-surface-2)' }}>
          {/* Table header */}
          <div className="table-row-head grid items-center gap-3 px-4 text-sm font-bold uppercase tracking-wider"
            style={{ gridTemplateColumns: deviceGridCols(visibleCols),
                     background: 'var(--bg-surface-3)', borderBottom: '1px solid var(--border-subtle)',
                     color: 'var(--text-muted)' }}>
            <button onClick={() => {
                selectedIds.size === filtered.length ? clearSelection()
                  : setSelectedIds(new Set(filtered.map(d => d.id)))
              }}
              style={{ color: selectedIds.size === filtered.length && filtered.length > 0 ? (isLight ? '#6c5ce7' : '#a78bfa') : 'var(--text-faint)' }}>
              {selectedIds.size === filtered.length && filtered.length > 0
                ? <CheckSquare size={13} /> : <Square size={13} />}
            </button>
            <span />
            <span>Device</span>
            <span>IP Address</span>
            {visibleCols.mac && <span>MAC Address</span>}
            {visibleCols.os && <span>OS</span>}
            {visibleCols.agent && <span>Agent</span>}
            <button
              className="flex items-center gap-1 uppercase tracking-wider text-sm font-bold text-left"
              style={{ color: sortKey === 'health' ? (isLight ? '#6c5ce7' : '#a78bfa') : 'var(--text-muted)' }}
              title="Sort by composite health score (open alerts, drift, capacity runway, uptime)"
              onClick={() => {
                if (sortKey !== 'health') { setSortKey('health'); setSortDir('asc') }
                else setSortDir(dir => dir === 'asc' ? 'desc' : 'asc')
              }}>
              Health
              {sortKey === 'health' && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
            </button>
            <span>Status</span>
            <span>Actions</span>
          </div>
          {/* Rows */}
          <div>
            {filtered.map(d => (
              <DeviceListRow key={d.id} device={d}
                group={groups.find(g => g.id === d.group_id)}
                selected={selectedIds.has(d.id)}
                highlighted={d.id === highlightId}
                onSelect={handleSelect}
                onWake={dev => handleAction('wake', dev)}
                onShutdown={dev => handleAction('shutdown', dev)}
                onRestart={dev => handleAction('restart', dev)}
                onEdit={dev => setDeviceModal(dev)}
                onDelete={dev => setDeleteTarget(dev)}
                onToggleMaintenance={handleToggleMaintenance}
                latestAgentVersion={latestAgentVersion}
                health={healthScores[d.id]}
                healthLoading={healthLoading}
                visibleCols={visibleCols}
                wakeEligibility={wakeEligibility[d.id]} />
            ))}
          </div>
        </div>
      )}

      <BulkBar count={selectedIds.size}
        onWakeAll={() => bulkAction('wake')}
        onShutdownAll={() => bulkAction('shutdown')}
        onRestartAll={() => bulkAction('restart')}
        onPushFile={() => setFilePushOpen(true)}
        onEditSelected={() => setBulkEditOpen(true)}
        onMaintenanceAll={bulkToggleMaintenance}
        onAgentUpdateAll={isAdmin ? bulkAgentUpdate : null}
        canEdit={isAdmin}
        onClear={clearSelection} />

      {/* Modals */}
      <DeviceModal open={!!deviceModal} onClose={() => setDeviceModal(null)}
        onSaved={() => fetchAll(true)}
        device={deviceModal !== 'add' ? deviceModal : null}
        groups={groups} />

      <ActionConfirmModal
        open={!!actionModal} onClose={() => setActionModal(null)}
        onConfirm={actionModal?.bulk ? executeBulkAction : executeAction}
        title={actionModal ? `${actionModal.type.charAt(0).toUpperCase() + actionModal.type.slice(1)} — ${actionModal.device?.name}` : ''}
        description="Enter your action PIN to authorise this command."
        danger={actionModal?.type !== 'wake'} />

      <ActionConfirmModal
        open={!!deleteTarget} onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={`Delete ${deleteTarget?.name}`}
        description="This will permanently remove the device and its stored credentials. This cannot be undone."
        danger />

      <ActionConfirmModal
        open={deleteAllOpen} onClose={() => setDeleteAllOpen(false)}
        onConfirm={handleDeleteAll}
        title={`Delete all ${devices.length} device(s)`}
        description="This will permanently remove every device and its stored credentials. This cannot be undone."
        danger />

      <FilePushModal open={filePushOpen} onClose={() => setFilePushOpen(false)}
        devices={devices} groups={groups} selectedIds={selectedIds} />

      <BulkEditModal open={bulkEditOpen} onClose={() => setBulkEditOpen(false)}
        deviceIds={[...selectedIds]} devices={devices} groups={groups}
        onSaved={() => { setBulkEditOpen(false); clearSelection(); fetchAll(true) }} />

      <DeviceRegistrationModal
        device={registrationTarget}
        isOpen={!!registrationTarget}
        onClose={() => setRegistrationTarget(null)}
        onApprove={() => fetchAll(true)}
        onReject={() => fetchAll(true)} />
    </div>
  )
}