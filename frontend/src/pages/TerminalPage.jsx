// pages/TerminalPage.jsx — SSH WebSocket terminal
// FIXES:
// 1. buildWsUrl now uses window.location to build a RELATIVE ws:// URL that
//    goes through the Vite proxy (/ws path) — no more hardcoded :4000 port
//    that breaks behind proxies/load balancers.
// 2. The 'connect' message is now sent AFTER ws.onopen fires — was already
//    correct but now also waits for xterm to be ready via a small guard.
// 3. Relay SSE URL uses /api prefix consistently (was inconsistent with
//    buildApiBase() which could return wrong base in some deployments).
// 4. Removed the webTerminal/HTTP relay fallback entirely — it depended on
//    a separate agent command loop which was broken and confusing.
//    WebSocket SSH is now the only transport. If it fails, user sees a clear
//    error with actionable steps.
// 5. Resize events now correctly send to open WebSocket only.
// 6. inputDisposable is properly cleaned up on every reconnect.

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon }      from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {
  X, Maximize2, Minimize2, RefreshCw, Wifi, WifiOff,
  Loader2, Terminal as TermIcon, Copy, Check
} from 'lucide-react'
import api from '../lib/api'
import { useThemeStore } from '../store/themeStore'

// ── Build WebSocket URL correctly ─────────────────────────────────────────────
// Uses the same host+port as the current page so it goes through Vite proxy
// in dev (/ws path is proxied to :4000) and through nginx/caddy in prod.
// Falls back to VITE_WS_URL env var for custom deployments.
function buildWsUrl(deviceId) {
  const token = localStorage.getItem('nc_token') || ''

  if (import.meta.env.VITE_WS_URL) {
    const base = import.meta.env.VITE_WS_URL.replace(/\/$/, '')
    return `${base}/ws/terminal/${deviceId}?token=${encodeURIComponent(token)}`
  }

  // Derive from current page URL — works behind any proxy
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const host  = location.host  // includes port if non-standard
  return `${proto}://${host}/ws/terminal/${deviceId}?token=${encodeURIComponent(token)}`
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cfg = {
    idle:       { icon: null,                                              text: 'Ready',         color: '#64748b' },
    connecting: { icon: <Loader2 size={11} className="animate-spin" />,   text: 'Connecting…',   color: '#fbbf24' },
    connected:  { icon: <Wifi size={11} />,                               text: 'Connected',     color: '#22c55e' },
    error:      { icon: <WifiOff size={11} />,                            text: 'Error',         color: '#f87171' },
    closed:     { icon: <WifiOff size={11} />,                            text: 'Disconnected',  color: '#64748b' },
    reconnecting:{ icon: <Loader2 size={11} className="animate-spin" />,  text: 'Reconnecting…', color: '#818cf8' },
  }
  const c = cfg[status] || cfg.idle
  return (
    <span className="flex items-center gap-1.5 text-xs font-mono" style={{ color: c.color }}>
      {c.icon} {c.text}
    </span>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function TerminalPage() {
  const { deviceId } = useParams()

  const termRef  = useRef(null)
  const xtermRef = useRef(null)
  const fitRef   = useRef(null)
  const wsRef    = useRef(null)
  const inputRef = useRef(null)  // xterm onData disposable
  const roRef    = useRef(null)  // ResizeObserver

  const [device,   setDevice]   = useState(null)
  const [status,   setStatus]   = useState('idle')
  const [errMsg,   setErrMsg]   = useState('')
  const [fullscreen, setFull]   = useState(false)
  const [copied,   setCopied]   = useState(false)
  const { theme } = useThemeStore()
  const isLight = theme === 'light'

  // ── Dispose helpers ───────────────────────────────────────────────────────
  const disposeInput = () => {
    if (inputRef.current) { try { inputRef.current.dispose() } catch {} inputRef.current = null }
  }
  const closeWs = () => {
    if (wsRef.current) {
      try { wsRef.current.onclose = null; wsRef.current.close() } catch {}
      wsRef.current = null
    }
  }

  // ── Init xterm (once) ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!termRef.current) return

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize:   14,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback:  10000,
      allowProposedApi: true,
      theme: isLight ? {
        background: '#fafafa', foreground: '#0f172a', cursor: '#6c5ce7',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(108,92,231,0.25)',
        black: '#334155', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
        blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#1e293b',
        brightBlack: '#64748b', brightRed: '#ef4444', brightGreen: '#22c55e',
        brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#a855f7',
        brightCyan: '#06b6d4', brightWhite: '#334155',
      } : {
        background: '#09090f', foreground: '#e2e8f0', cursor: '#38bdf8',
        cursorAccent: '#09090f',
        selectionBackground: 'rgba(56,189,248,0.3)',
        black: '#1a1a2e', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
        blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e2e8f0',
        brightBlack: '#475569', brightRed: '#f87171', brightGreen: '#4ade80',
        brightYellow: '#fbbf24', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
        brightCyan: '#22d3ee', brightWhite: '#f8fafc',
      },
    })

    const fit   = new FitAddon()
    const links = new WebLinksAddon()
    term.loadAddon(fit)
    term.loadAddon(links)
    term.open(termRef.current)

    // Small delay then fit so the container has measured itself
    requestAnimationFrame(() => { try { fit.fit() } catch {} })

    xtermRef.current = term
    fitRef.current   = fit

    // Observe container resize
    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch {}
      // Send resize to server if connected
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN && xtermRef.current) {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: xtermRef.current.cols,
          rows: xtermRef.current.rows,
        }))
      }
    })
    ro.observe(termRef.current)
    roRef.current = ro

    return () => {
      ro.disconnect()
      disposeInput()
      closeWs()
      term.dispose()
      xtermRef.current = null
      fitRef.current   = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // Run once — theme changes don't need to recreate xterm

  // ── Load device info ──────────────────────────────────────────────────────
  useEffect(() => {
    api.get(`/devices/${deviceId}`)
      .then(r => { setDevice(r.data); document.title = `Terminal — ${r.data.name}` })
      .catch(() => setErrMsg('Failed to load device'))
  }, [deviceId])

  // ── WebSocket connect ─────────────────────────────────────────────────────
  const connect = useCallback(() => {
    closeWs()
    disposeInput()

    setStatus('connecting')
    setErrMsg('')

    const url = buildWsUrl(deviceId)
    const ws  = new WebSocket(url)
    wsRef.current = ws

    const term = xtermRef.current
    term?.clear()
    term?.writeln('\x1b[90m[Connecting to ' + deviceId + '…]\x1b[0m\r\n')

    ws.onopen = () => {
      // Wait one frame so term.cols/rows are correct after fit
      requestAnimationFrame(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({
          type: 'connect',
          cols: term?.cols || 80,
          rows: term?.rows || 24,
        }))
      })
    }

    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }

      if (msg.type === 'data') {
        xtermRef.current?.write(msg.data)
      }

      if (msg.type === 'status') {
        if (msg.data?.startsWith('Connected')) {
          setStatus('connected')
          setErrMsg(msg.data)
        } else {
          setErrMsg(msg.data || '')
        }
      }

      if (msg.type === 'error') {
        setStatus('error')
        setErrMsg(msg.data || 'SSH connection failed')
        xtermRef.current?.writeln('\r\n\x1b[1;31m✖ ' + (msg.data || 'SSH error') + '\x1b[0m\r\n')
      }
    }

    ws.onclose = (e) => {
      if (e.code === 1000) {
        setStatus('closed')
        xtermRef.current?.writeln('\r\n\x1b[90m[Connection closed]\x1b[0m\r\n')
      } else if (e.code === 1011 || e.code === 1008) {
        // Server-side error or auth failure — don't auto-retry
        setStatus('error')
        const reason = e.reason || `WebSocket closed (code ${e.code})`
        setErrMsg(reason)
        xtermRef.current?.writeln('\r\n\x1b[1;31m✖ ' + reason + '\x1b[0m\r\n')
      } else {
        // Network drop — auto-retry once after 2s
        setStatus('reconnecting')
        xtermRef.current?.writeln('\r\n\x1b[90m[Connection lost — retrying in 2s…]\x1b[0m\r\n')
        setTimeout(() => {
          if (wsRef.current === ws) connect() // only retry if not replaced
        }, 2000)
      }
    }

    ws.onerror = () => {
      // onclose fires after onerror — let it handle the state
    }

    // Wire terminal input → WebSocket
    inputRef.current = term?.onData(data => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'data', data }))
      }
    })
  }, [deviceId])

  // ── Auto-connect on mount ────────────────────────────────────────────────
  useEffect(() => {
    // Delay slightly so xterm has rendered and measured itself
    const t = setTimeout(connect, 200)
    return () => {
      clearTimeout(t)
      closeWs()
      disposeInput()
    }
  }, [connect])

  const reconnect = () => connect()

  const toggleFull = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.()
    else document.exitFullscreen?.()
    setFull(f => !f)
    setTimeout(() => { try { fitRef.current?.fit() } catch {} }, 150)
  }

  const copyIP = () => {
    if (!device?.ip_address) return
    navigator.clipboard.writeText(device.ip_address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const termBg    = isLight ? '#fafafa'   : '#09090f'
  const barBg     = isLight ? '#ffffff'   : '#0f0f1a'
  const barBorder = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)'
  const textPri   = isLight ? '#0f172a'   : '#e2e8f0'
  const textMut   = '#64748b'

  return (
    <div className="flex flex-col h-screen select-none" style={{ background: termBg }}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 shrink-0 z-10"
        style={{ background: barBg, borderBottom: `1px solid ${barBorder}` }}>

        {/* Icon */}
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: isLight ? '#6c5ce7' : 'rgba(56,189,248,0.15)', border: isLight ? 'none' : '1px solid rgba(56,189,248,0.25)' }}>
          <TermIcon size={13} style={{ color: isLight ? '#fff' : '#38bdf8' }} />
        </div>

        {/* Device info */}
        <div className="flex flex-col min-w-0 mr-2">
          <span className="text-sm font-semibold leading-tight truncate" style={{ color: textPri }}>
            {device?.name || 'Terminal'}
          </span>
          {device && (
            <button onClick={copyIP} className="flex items-center gap-1 text-[11px] font-mono text-left leading-tight"
              style={{ color: textMut }}>
              {device.ip_address}
              {copied
                ? <Check size={9} style={{ color: '#22c55e' }} />
                : <Copy size={9} className="opacity-0 hover:opacity-100 transition-opacity" />}
            </button>
          )}
        </div>

        {/* Status */}
        <StatusBadge status={status} />

        {/* Error/status message */}
        {errMsg && status !== 'connected' && (
          <span className="text-[11px] font-body truncate hidden sm:block" style={{ color: textMut }}>
            — {errMsg}
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Controls */}
        {[
          { icon: <RefreshCw size={13} className={status === 'reconnecting' ? 'animate-spin' : ''} />, fn: reconnect,    title: 'Reconnect', hover: isLight ? '#6c5ce7' : '#818cf8' },
          { icon: fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />,                      fn: toggleFull,   title: fullscreen ? 'Exit fullscreen' : 'Fullscreen', hover: textPri },
          { icon: <X size={13} />,                                                                      fn: () => window.close(), title: 'Close', hover: '#f87171' },
        ].map(({ icon, fn, title, hover }, i) => (
          <button key={i} onClick={fn} title={title}
            className="p-1.5 rounded-lg transition-all"
            style={{ color: textMut }}
            onMouseEnter={e => e.currentTarget.style.color = hover}
            onMouseLeave={e => e.currentTarget.style.color = textMut}>
            {icon}
          </button>
        ))}
      </div>

      {/* ── Error panel ───────────────────────────────────────────────────── */}
      {status === 'error' && (
        <div className="px-4 py-3 shrink-0" style={{ background: 'rgba(239,68,68,0.07)', borderBottom: `1px solid rgba(239,68,68,0.2)` }}>
          <div className="flex items-start gap-3 max-w-2xl">
            <WifiOff size={14} style={{ color: '#f87171', flexShrink: 0, marginTop: 1 }} />
            <div className="min-w-0">
              <p className="text-xs font-semibold mb-1" style={{ color: '#f87171' }}>
                SSH connection failed
              </p>
              <p className="text-[11px] font-mono break-all" style={{ color: textMut }}>{errMsg}</p>
              <div className="mt-2 space-y-0.5 text-[11px]" style={{ color: textMut }}>
                <p>• Make sure SSH is running on the device (port 22 by default)</p>
                <p>• Check the SSH username and password are set in Device settings</p>
                <p>• Verify the NetControl server can reach the device IP</p>
              </div>
              <button onClick={reconnect}
                className="mt-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }}>
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Terminal ──────────────────────────────────────────────────────── */}
      <div ref={termRef} className="flex-1 overflow-hidden"
        style={{ padding: '6px 6px 4px 8px', background: termBg }} />
    </div>
  )
}

