// pages/TerminalPage.jsx — In-browser SSH terminal
// Opens at /terminal/:deviceId  (new tab from DeviceCard)

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon }      from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {
  X, Maximize2, Minimize2, RefreshCw,
  Wifi, WifiOff, Loader2, Terminal as TermIcon
} from 'lucide-react'
import api from '../lib/api'

// ── Build the WS URL ─────────────────────────────────────────────────────────
function buildWsUrl(deviceId) {
  const token  = localStorage.getItem('nc_token') || ''
  const wsBase = import.meta.env.VITE_WS_URL
    || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:4000`
  return `${wsBase}/ws/terminal/${deviceId}?token=${encodeURIComponent(token)}`
}

// ── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cfg = {
    connecting: { icon: <Loader2 size={12} className="animate-spin" />, text: 'Connecting…',  cls: 'text-accent-yellow' },
    connected:  { icon: <Wifi size={12} />,    text: 'Connected',     cls: 'text-accent-green' },
    error:      { icon: <WifiOff size={12} />, text: 'Error',         cls: 'text-accent-red'   },
    closed:     { icon: <WifiOff size={12} />, text: 'Disconnected',  cls: 'text-slate-500'    },
  }
  const { icon, text, cls } = cfg[status] || cfg.connecting
  return (
    <span className={`flex items-center gap-1.5 text-xs font-body ${cls}`}>
      {icon} {text}
    </span>
  )
}

export default function TerminalPage() {
  const { deviceId } = useParams()
  const navigate     = useNavigate()

  const termRef      = useRef(null)   // DOM container
  const xtermRef     = useRef(null)   // xterm instance
  const fitRef       = useRef(null)   // fit addon
  const wsRef        = useRef(null)   // WebSocket
  const reconnectRef = useRef(null)   // reconnect timer

  const [device,     setDevice]     = useState(null)
  const [status,     setStatus]     = useState('connecting')
  const [statusMsg,  setStatusMsg]  = useState('')
  const [fullscreen, setFullscreen] = useState(false)

  // ── Load device info ────────────────────────────────────────────────────────
  useEffect(() => {
    api.get(`/devices/${deviceId}`)
      .then(r => setDevice(r.data))
      .catch(() => setStatusMsg('Failed to load device info'))
  }, [deviceId])

  // ── Init xterm ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!termRef.current) return

    const isDark = document.documentElement.getAttribute('data-theme') !== 'light'

    const term = new Terminal({
      fontFamily:  '"JetBrains Mono", "Fira Code", monospace',
      fontSize:    14,
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
        background:  '#ffffff',
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

    // Resize observer → tell SSH server about new dimensions
    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }))
      }
    })
    ro.observe(termRef.current)

    return () => {
      ro.disconnect()
      term.dispose()
      xtermRef.current = null
    }
  }, [])

  // ── Connect WebSocket ───────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
    }
    clearTimeout(reconnectRef.current)
    setStatus('connecting')

    const ws = new WebSocket(buildWsUrl(deviceId))
    wsRef.current = ws

    ws.onopen = () => {
      const term = xtermRef.current
      ws.send(JSON.stringify({
        type: 'connect',
        cols: term?.cols || 80,
        rows: term?.rows || 24,
      }))
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

    // Wire terminal input → WS
    if (xtermRef.current) {
      xtermRef.current.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data }))
        }
      })
    }
  }, [deviceId])

  useEffect(() => {
    // Wait a tick for xterm to mount
    const t = setTimeout(connect, 100)
    return () => {
      clearTimeout(t)
      clearTimeout(reconnectRef.current)
      if (wsRef.current) wsRef.current.close()
    }
  }, [connect])

  // ── Fullscreen ──────────────────────────────────────────────────────────────
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
    setFullscreen(f => !f)
    setTimeout(() => fitRef.current?.fit(), 100)
  }

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light'

  return (
    <div
      className="flex flex-col h-screen"
      style={{ backgroundColor: isDark ? '#09090f' : '#f1f5f9' }}
    >
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 shrink-0 border-b"
        style={{
          backgroundColor: isDark ? '#0f0f1a' : '#ffffff',
          borderColor:     isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)',
        }}
      >
        {/* Icon + title */}
        <div className="w-7 h-7 rounded-lg bg-brand-500/20 border border-brand-500/30 flex items-center justify-center">
          <TermIcon size={14} className="text-brand-400" />
        </div>

        <div className="flex flex-col min-w-0">
          <span className="text-sm font-body font-semibold truncate" style={{ color: isDark ? '#e2e8f0' : '#0f172a' }}>
            {device ? device.name : 'SSH Terminal'}
          </span>
          {device && (
            <span className="text-[11px] font-mono" style={{ color: isDark ? '#64748b' : '#94a3b8' }}>
              {device.ssh_username || device.ip_address}@{device.ip_address}
            </span>
          )}
        </div>

        <div className="ml-2">
          <StatusBadge status={status} />
        </div>

        {statusMsg && status !== 'connected' && (
          <span className="text-xs font-body text-slate-500 truncate hidden sm:block ml-1">
            — {statusMsg}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* Reconnect */}
          <button
            onClick={connect}
            title="Reconnect"
            className="p-1.5 rounded-lg transition-all hover:bg-brand-500/15 text-slate-500 hover:text-brand-400"
          >
            <RefreshCw size={14} />
          </button>

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            className="p-1.5 rounded-lg transition-all hover:bg-surface-3 text-slate-500 hover:text-slate-300"
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>

          {/* Close tab */}
          <button
            onClick={() => window.close()}
            title="Close"
            className="p-1.5 rounded-lg transition-all hover:bg-accent-red/15 text-slate-500 hover:text-accent-red"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ── Terminal container ───────────────────────────────────────────── */}
      <div
        ref={termRef}
        className="flex-1 overflow-hidden"
        style={{ padding: '8px 4px 4px 8px' }}
      />
    </div>
  )
}

