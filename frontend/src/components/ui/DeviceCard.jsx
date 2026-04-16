import React from 'react'
import { Monitor, Power, RotateCcw, Zap, Pencil, Trash2, Server, TerminalSquare } from 'lucide-react'

const STATUS_COLORS = {
  online:  'status-dot-online',
  offline: 'status-dot-offline',
  unknown: 'status-dot-unknown',
  error:   'status-dot-error',
}
const STATUS_LABELS = {
  online:  { text: 'Online',  color: 'text-accent-green'  },
  offline: { text: 'Offline', color: 'text-slate-500'     },
  unknown: { text: 'Unknown', color: 'text-accent-yellow' },
  error:   { text: 'Error',   color: 'text-accent-red'    },
}

export default function DeviceCard({
  device, selected,
  onSelect, onWake, onShutdown, onRestart, onEdit, onDelete
}) {
  const status      = device.status || 'unknown'
  const statusDot   = STATUS_COLORS[status]
  const statusLabel = STATUS_LABELS[status]

  // "Remote Access" only shown for Linux devices that have SSH credentials
  const canSSH = device.ssh_username

  const openTerminal = (e) => {
    e.stopPropagation()
    window.open(`/terminal/${device.id}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      onClick={() => onSelect(device.id)}
      className={`
        relative rounded-xl border transition-all duration-200 cursor-pointer p-4
        ${selected
          ? 'bg-brand-500/10 border-brand-500/40 shadow-[0_0_20px_rgba(14,165,233,0.1)]'
          : 'glass glass-hover border-white/8'
        }
      `}
    >
      {/* Selection indicator */}
      {selected && (
        <div className="absolute top-3 right-3 w-4 h-4 rounded-full bg-brand-500 flex items-center justify-center">
          <span className="text-white text-[10px]">✓</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className={`
          w-9 h-9 rounded-lg flex items-center justify-center shrink-0
          ${device.os_type === 'windows'
            ? 'bg-accent-cyan/10 border border-accent-cyan/20'
            : 'bg-accent-green/10 border border-accent-green/20'
          }
        `}>
          {device.os_type === 'windows'
            ? <Server size={16} className="text-accent-cyan" />
            : <Monitor size={16} className="text-accent-green" />
          }
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-body font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {device.name}
          </p>
          <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {device.ip_address}
          </p>
        </div>
      </div>

      {/* Status row */}
      <div className="flex items-center gap-2 mb-4">
        <span className={statusDot} />
        <span className={`text-xs font-body ${statusLabel.color}`}>{statusLabel.text}</span>
        <span className="ml-auto text-[10px] font-mono uppercase" style={{ color: 'var(--text-faint)' }}>
          {device.os_type}
        </span>
      </div>

      {/* Power actions */}
      <div className="flex gap-1.5 mb-1.5" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => onWake(device)}
          title="Wake On LAN"
          className="flex-1 py-1.5 rounded-lg bg-accent-green/10 hover:bg-accent-green/20 border border-accent-green/20 hover:border-accent-green/40 text-accent-green transition-all duration-150 flex items-center justify-center gap-1"
        >
          <Zap size={12} />
          <span className="text-[11px] font-body font-medium">Wake</span>
        </button>
        <button
          onClick={() => onShutdown(device)}
          title="Shutdown"
          className="flex-1 py-1.5 rounded-lg bg-accent-red/10 hover:bg-accent-red/20 border border-accent-red/20 hover:border-accent-red/40 text-accent-red transition-all duration-150 flex items-center justify-center gap-1"
        >
          <Power size={12} />
          <span className="text-[11px] font-body font-medium">Off</span>
        </button>
        <button
          onClick={() => onRestart(device)}
          title="Restart"
          className="flex-1 py-1.5 rounded-lg bg-accent-yellow/10 hover:bg-accent-yellow/20 border border-accent-yellow/20 hover:border-accent-yellow/40 text-accent-yellow transition-all duration-150 flex items-center justify-center gap-1"
        >
          <RotateCcw size={12} />
          <span className="text-[11px] font-body font-medium">Restart</span>
        </button>
        <button
          onClick={() => onEdit(device)}
          title="Edit"
          className="px-2 py-1.5 rounded-lg bg-surface-3 hover:bg-surface-4 border border-white/6 text-slate-400 hover:text-slate-200 transition-all duration-150"
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={() => onDelete(device)}
          title="Delete"
          className="px-2 py-1.5 rounded-lg bg-surface-3 hover:bg-accent-red/10 border border-white/6 hover:border-accent-red/20 text-slate-500 hover:text-accent-red transition-all duration-150"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* SSH Terminal button — Linux only, only when ssh_username is set */}
      {canSSH && (
        <div onClick={e => e.stopPropagation()}>
          <button
            onClick={openTerminal}
            title="Open SSH Terminal"
            className="w-full py-1.5 rounded-lg border transition-all duration-150 flex items-center justify-center gap-1.5 text-[11px] font-body font-medium"
            style={{
              backgroundColor: 'rgba(14,165,233,0.08)',
              borderColor:     'rgba(14,165,233,0.20)',
              color:           '#38bdf8',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.backgroundColor = 'rgba(14,165,233,0.16)'
              e.currentTarget.style.borderColor     = 'rgba(14,165,233,0.40)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = 'rgba(14,165,233,0.08)'
              e.currentTarget.style.borderColor     = 'rgba(14,165,233,0.20)'
            }}
          >
            <TerminalSquare size={12} />
            Remote Access
          </button>
        </div>
      )}

      {device.group_name && (
        <div className="mt-2.5 pt-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <span className="text-[10px] font-body" style={{ color: 'var(--text-faint)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Group: </span>{device.group_name}
          </span>
        </div>
      )}
    </div>
  )
}

