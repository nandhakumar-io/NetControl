import React from 'react'
import { Monitor, Power, RotateCcw, Zap, Pencil, Trash2, Server, TerminalSquare } from 'lucide-react'
import { useThemeStore } from '../../store/themeStore'

const STATUS_COLORS = {
  online:  'status-dot-online',
  offline: 'status-dot-offline',
  unknown: 'status-dot-unknown',
  error:   'status-dot-error',
}
const STATUS_LABELS = {
  online:  { text: 'Online',  cls: 'text-accent-green'  },
  offline: { text: 'Offline', cls: 'text-slate-500'     },
  unknown: { text: 'Unknown', cls: 'text-accent-yellow' },
  error:   { text: 'Error',   cls: 'text-accent-red'    },
}

export default function DeviceCard({
  device, selected,
  onSelect, onWake, onShutdown, onRestart, onEdit, onDelete,
}) {
  const { theme } = useThemeStore()
  const isLight = theme === 'light'

  const status      = device.status || 'unknown'
  const statusDot   = STATUS_COLORS[status]
  const statusLabel = STATUS_LABELS[status]
  const canSSH      = device.ssh_username

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
          ? isLight
            ? 'border-[#6c5ce7]/40 shadow-[0_0_0_2px_rgba(108,92,231,0.15)]'
            : 'bg-brand-500/10 border-brand-500/40 shadow-[0_0_20px_rgba(14,165,233,0.1)]'
          : 'glass glass-hover'
        }
      `}
      style={selected && isLight ? { backgroundColor: 'rgba(108,92,231,0.05)' } : {}}
    >
      {/* Selection tick */}
      {selected && (
        <div
          className="absolute top-3 right-3 w-4 h-4 rounded-full flex items-center justify-center"
          style={{ backgroundColor: isLight ? '#6c5ce7' : '#0ea5e9' }}
        >
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

      {/* Status */}
      <div className="flex items-center gap-2 mb-4">
        <span className={statusDot} />
        <span className={`text-xs font-body ${statusLabel.cls}`}>{statusLabel.text}</span>
        <span className="ml-auto text-[10px] font-mono uppercase" style={{ color: 'var(--text-faint)' }}>
          {device.os_type}
        </span>
      </div>

      {/* Action buttons */}
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
        {/* Edit / Delete — use icon-btn class which adapts to theme */}
        <button
          onClick={() => onEdit(device)}
          title="Edit"
          className="icon-btn"
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={() => onDelete(device)}
          title="Delete"
          className="icon-btn hover:!text-accent-red hover:!bg-accent-red/10 hover:!border-accent-red/20"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* SSH button */}
      {canSSH && (
        <div onClick={e => e.stopPropagation()}>
          <button
            onClick={openTerminal}
            title="Open SSH Terminal"
            className="w-full py-1.5 rounded-lg border transition-all duration-150 flex items-center justify-center gap-1.5 text-[11px] font-body font-medium"
            style={{
              backgroundColor: isLight ? 'rgba(108,92,231,0.07)' : 'rgba(14,165,233,0.08)',
              borderColor:     isLight ? 'rgba(108,92,231,0.20)' : 'rgba(14,165,233,0.20)',
              color:           isLight ? '#6c5ce7' : '#38bdf8',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.backgroundColor = isLight ? 'rgba(108,92,231,0.14)' : 'rgba(14,165,233,0.16)'
              e.currentTarget.style.borderColor     = isLight ? 'rgba(108,92,231,0.35)' : 'rgba(14,165,233,0.40)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.backgroundColor = isLight ? 'rgba(108,92,231,0.07)' : 'rgba(14,165,233,0.08)'
              e.currentTarget.style.borderColor     = isLight ? 'rgba(108,92,231,0.20)' : 'rgba(14,165,233,0.20)'
            }}
          >
            <TerminalSquare size={12} />
            Remote Access
          </button>
        </div>
      )}

      {device.group_name && (
        <div className="mt-2.5 pt-2.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <span className="text-[10px] font-body" style={{ color: 'var(--text-faint)' }}>
            <span style={{ color: 'var(--text-muted)' }}>Group: </span>{device.group_name}
          </span>
        </div>
      )}
    </div>
  )
}
