// pages/RemoteAccessPage.jsx — SSH remote access as a full page
// Left panel: device picker. Right panel: embedded terminal.
import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Terminal as TermIcon, Monitor, Search, Wifi, WifiOff,
  Loader2, RefreshCw, Maximize2, ChevronRight, X, Zap
} from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon }      from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'

// ─── WS URL builder ──────────────────────────────────────────────────────────
function buildWsUrl(deviceId) {
  const token  = localStorage.getItem('nc_token') || ''
  const wsBase = import.meta.env.VITE_WS_URL
    || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:4000`
  return `${wsBase}/ws/terminal/${deviceId}?token=${encodeURIComponent(token)}`
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cfg = {
    connecting: { icon: <Loader2 size={11} className="animate-spin" />, text: 'Connecting…', cls: 'text-accent-yellow' },
    connected:  { icon: <Wifi size={11} />,    text: 'Connected',    cls: 'text-accent-green' },
    error:      { icon: <WifiOff size={11} />, text: 'Error',        cls: 'text-accent-red'   },
    closed:     { icon: <WifiOff size={11} />, text: 'Disconnected', cls: 'text-slate-500'    },
    idle:       { icon: null,                   text: 'Select a device', cls: 'text-slate-500' },
  }
  const { icon, text, cls } = cfg[status] || cfg.idle
  return (
    <span className={`flex items-center gap-1.5 text-xs font-body ${cls}`}>
      {icon} {text}
    </span>
  )
}

// ─── Device list item ─────────────────────────────────────────────────────────
function DeviceItem({ device, active, onClick }) {
  const statusDot = {
    online:  'bg-accent-green',
    offline: 'bg-slate-600',
    unknown: 'bg-accent-yellow',
  }[device.status] || 'bg-slate-600'

  const canConnect = device.os_type === 'linux'
    ? (device.has_ssh_password || device.has_ssh_key)
    : (device.has_ssh_password || device.has_rpc_password)

  return (
    <button
      onClick={() => canConnect && onClick(device)}
      disabled={!canConnect}
      title={!canConnect ? 'No SSH credentials configured' : `Connect to ${device.name}`}
      className={`
        w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all duration-150
        ${active
          ? 'bg-brand-500/15 border border-brand-500/30'
          : canConnect
            ? 'hover:bg-surface-3 border border-transparent'
            : 'opacity-40 cursor-not-allowed border border-transparent'
        }
      `}
    >
      <div className="relative shrink-0">
        <div className="w-8 h-8 rounded-lg bg-surface-3 border border-white/8 flex items-center justify-center">
          <Monitor size={14} style={{ color: active ? 'var(--color-brand-400, #38bdf8)' : 'var(--text-muted)' }} />
        </div>
        <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 ${statusDot}`}
          style={{ borderColor: 'var(--bg-surface-1)' }} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-body font-medium truncate" style={{ color: active ? 'var(--color-brand-300, #7dd3fc)' : 'var(--text-primary)' }}>
          {device.name}
        </p>
        <p className="text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
          {device.ip_address}
        </p>
      </div>
      {active && <ChevronRight size={13} className="shrink-0 text-brand-400" />}
    </button>
  )
}

// ─── Embedded terminal ────────────────────────────────────────────────────────
function EmbeddedTerminal({ device, onClose }) {
  const termRef   = useRef(null)
  const xtermRef  = useRef(null)
  const fitRef    = useRef(null)
  const wsRef     = useRef(null)

  const [status,    setStatus]    = useState('connecting')
  const [statusMsg, setStatusMsg] = useState('')

  // Init xterm
  useEffect(() => {
    if (!termRef.current) return

    const isDark = document.documentElement.getAttribute('data-theme') !== 'light'

    const term = new Terminal({
      fontFamily:  '"JetBrains Mono", "Fira Code", monospace',
      fontSize:    13,
      lineHeight:  1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback:  5000,
      theme: isDark ? {
        background:  '#09090f',
        foreground:  '#e2e8f0',
        cursor:      '#38bdf8',
        selectionBackground: 'rgba(56,189,248,0.25)',
        black:   '#1a1a2e', red:     '#ef4444',
        green:   '#22c55e', yellow:  '#eab308',
        blue:    '#3b82f6', magenta: '#a855f7',
        cyan:    '#06b6d4', white:   '#e2e8f0',
        brightBlack: '#475569', brightRed:    '#f87171',
        brightGreen: '#4ade80', brightYellow: '#fbbf24',
        brightBlue:  '#60a5fa', brightMagenta:'#c084fc',
        brightCyan:  '#22d3ee', brightWhite:  '#f8fafc',
      } : {
        background:  '#f8fafc',
        foreground:  '#0f172a',
        cursor:      '#0ea5e9',
        selectionBackground: 'rgba(14,165,233,0.2)',
        black:   '#334155', red:     '#dc2626',
        green:   '#16a34a', yellow:  '#ca8a04',
        blue:    '#2563eb', magenta: '#9333ea',
        cyan:    '#0891b2', white:   '#1e293b',
        brightBlack: '#64748b', brightRed:    '#ef4444',
        brightGreen: '#22c55e', brightYellow: '#eab308',
        brightBlue:  '#3b82f6', brightMagenta:'#a855f7',
        brightCyan:  '#06b6d4', brightWhite:  '#334155',
      },
    })

    const fitAddon      = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(termRef.current)
    fitAddon.fit()

    xtermRef.current = term
    fitRef.current   = fitAddon

    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    ro.observe(termRef.current)

    return () => {
      ro.disconnect()
      term.dispose()
      xtermRef.current = null
    }
  }, [])

  // Connect WS
  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
    }
    setStatus('connecting')
    setStatusMsg('')

    const ws = new WebSocket(buildWsUrl(device.id))
    wsRef.current = ws

    ws.onopen = () => {
      const term = xtermRef.current
      ws.send(JSON.stringify({ type: 'connect', cols: term?.cols || 80, rows: term?.rows || 24 }))
    }

    ws.onmessage = (evt) => {
      let msg
      try { msg = JSON.parse(evt.data) } catch { return }
      if (msg.type === 'data' && xtermRef.current) {
        xtermRef.current.write(msg.data)
      } else if (msg.type === 'status') {
        setStatusMsg(msg.data)
        if (msg.data.startsWith('Connected')) setStatus('connected')
      } else if (msg.type === 'error') {
        setStatus('error')
        setStatusMsg(msg.data)
        xtermRef.current?.writeln(`\r\n\x1b[1;31m✖ ${msg.data}\x1b[0m\r\n`)
      }
    }

    ws.onclose = () => {
      setStatus('closed')
      xtermRef.current?.writeln('\r\n\x1b[90m[Connection closed]\x1b[0m\r\n')
    }

    ws.onerror = () => {
      setStatus('error')
      setStatusMsg('WebSocket connection failed')
    }

    if (xtermRef.current) {
      xtermRef.current.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data }))
        }
      })
    }
  }, [device.id])

  useEffect(() => {
    const t = setTimeout(connect, 100)
    return () => {
      clearTimeout(t)
      if (wsRef.current) wsRef.current.close()
    }
  }, [connect])

  const openNewTab = () => {
    window.open(`/terminal/${device.id}`, '_blank')
  }

  return (
    <div className="flex flex-col h-full">
      {/* Terminal top bar */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 shrink-0 border-b"
        style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-surface-2)' }}
      >
        <div className="w-6 h-6 rounded-md bg-brand-500/20 border border-brand-500/30 flex items-center justify-center shrink-0">
          <TermIcon size={12} className="text-brand-400" />
        </div>

        <div className="min-w-0">
          <span className="text-sm font-body font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {device.name}
          </span>
          <span className="text-[11px] font-mono ml-2" style={{ color: 'var(--text-muted)' }}>
            {device.ssh_username || ''}@{device.ip_address}
          </span>
        </div>

        <StatusBadge status={status} />

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={connect}
            title="Reconnect"
            className="p-1.5 rounded-lg text-slate-500 hover:text-brand-400 hover:bg-brand-500/10 transition-colors"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={openNewTab}
            title="Open in new tab"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-surface-3 transition-colors"
          >
            <Maximize2 size={13} />
          </button>
          <button
            onClick={onClose}
            title="Close terminal"
            className="p-1.5 rounded-lg text-slate-500 hover:text-accent-red hover:bg-accent-red/10 transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* xterm container */}
      <div
        ref={termRef}
        className="flex-1 overflow-hidden"
        style={{ padding: '6px 4px 4px 8px', backgroundColor: '#09090f' }}
      />
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function RemoteAccessPage() {
  const [devices, setDevices]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [searchQ, setSearchQ]   = useState('')
  const [filterOS, setFilterOS] = useState('all')    // 'all' | 'linux' | 'windows'
  const [filterSt, setFilterSt] = useState('all')    // 'all' | 'online' | 'offline'
  const [activeDevice, setActiveDevice] = useState(null)
  const [termKey, setTermKey]   = useState(0)         // force re-mount terminal on new device

  useEffect(() => {
    api.get('/devices')
      .then(r => setDevices(r.data))
      .catch(() => toast.error('Failed to load devices'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = devices.filter(d => {
    const matchQ  = d.name.toLowerCase().includes(searchQ.toLowerCase()) || d.ip_address.includes(searchQ)
    const matchOS = filterOS === 'all' || d.os_type === filterOS
    const matchSt = filterSt === 'all' || d.status === filterSt
    return matchQ && matchOS && matchSt
  })

  const handleSelectDevice = (device) => {
    setActiveDevice(device)
    setTermKey(k => k + 1)
  }

  const handleClose = () => {
    setActiveDevice(null)
  }

  const onlineCnt  = devices.filter(d => d.status === 'online').length
  const sshReady   = devices.filter(d =>
    d.os_type === 'linux' ? (d.has_ssh_password || d.has_ssh_key) : (d.has_ssh_password || d.has_rpc_password)
  ).length

  return (
    <div className="flex flex-col h-full" style={{ height: 'calc(100vh - 0px)' }}>
      {/* Page header */}
      <div className="px-6 pt-6 pb-4 shrink-0">
        <PageHeader
          icon={TermIcon}
          title="Remote Access"
          description="SSH into devices directly from your browser"
        />

        {/* Stats row */}
        <div className="flex items-center gap-4 mt-2 mb-1 flex-wrap">
          <span className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
            <span className="text-accent-green font-semibold">{onlineCnt}</span> online
          </span>
          <span className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
            <span className="text-brand-400 font-semibold">{sshReady}</span> SSH-ready
          </span>
          <span className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
            <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>{devices.length}</span> total
          </span>
        </div>
      </div>

      {/* Main split pane */}
      <div className="flex flex-1 overflow-hidden gap-0 px-6 pb-6">

        {/* LEFT: Device list */}
        <div
          className="flex flex-col shrink-0 rounded-xl border overflow-hidden"
          style={{
            width: '280px',
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--bg-surface-1)',
          }}
        >
          {/* Search + filters */}
          <div className="p-3 border-b space-y-2 shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                className="input-field pl-8 py-2 text-sm w-full"
                placeholder="Search devices…"
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
              />
            </div>
            <div className="flex gap-1">
              {[['all', 'All'], ['linux', 'Linux'], ['windows', 'Win']].map(([val, lbl]) => (
                <button
                  key={val}
                  onClick={() => setFilterOS(val)}
                  className={`flex-1 px-2 py-1 rounded-md text-xs font-body transition-all ${
                    filterOS === val ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  style={filterOS !== val ? { backgroundColor: 'var(--bg-surface-3)' } : {}}
                >
                  {lbl}
                </button>
              ))}
              <div className="w-px" style={{ backgroundColor: 'var(--border-subtle)' }} />
              {[['all', 'All'], ['online', '🟢'], ['offline', '⚫']].map(([val, lbl]) => (
                <button
                  key={val}
                  onClick={() => setFilterSt(val)}
                  className={`flex-1 px-2 py-1 rounded-md text-xs font-body transition-all ${
                    filterSt === val ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  style={filterSt !== val ? { backgroundColor: 'var(--bg-surface-3)' } : {}}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {/* Device list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-14 rounded-lg bg-surface-3 animate-pulse" />
              ))
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: 'var(--text-muted)' }}>
                <Monitor size={28} className="opacity-30" />
                <p className="text-xs font-body">No devices found</p>
              </div>
            ) : (
              filtered.map(d => (
                <DeviceItem
                  key={d.id}
                  device={d}
                  active={activeDevice?.id === d.id}
                  onClick={handleSelectDevice}
                />
              ))
            )}
          </div>

          {/* Footer hint */}
          <div className="px-3 py-2.5 border-t shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
            <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
              Dimmed devices have no SSH credentials configured.
            </p>
          </div>
        </div>

        {/* RIGHT: Terminal panel */}
        <div
          className="flex-1 ml-4 rounded-xl border overflow-hidden"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: '#09090f',
            minWidth: 0,
          }}
        >
          {activeDevice ? (
            <EmbeddedTerminal
              key={`${activeDevice.id}-${termKey}`}
              device={activeDevice}
              onClose={handleClose}
            />
          ) : (
            /* Empty state */
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="w-16 h-16 rounded-2xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center">
                <TermIcon size={28} className="text-brand-400 opacity-60" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-sm font-body font-medium text-slate-400">No session open</p>
                <p className="text-xs font-body text-slate-600">Select a device from the list to start an SSH session</p>
              </div>
              <div className="flex items-center gap-6 mt-2">
                {[
                  { icon: <Zap size={13} />, text: 'Instant connection' },
                  { icon: <Wifi size={13} />, text: 'WebSocket-based SSH' },
                  { icon: <Maximize2 size={13} />, text: 'Pop out to full tab' },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs font-body text-slate-600">
                    {item.icon} {item.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
