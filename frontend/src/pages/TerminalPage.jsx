// pages/TerminalPage.jsx
// Transport priority:
//   1. WebSocket SSH (direct ssh2 on server) — fastest, full PTY
//   2. HTTP relay fallback (webTerminal.js agent polling) — works when
//      port 22 is blocked or WebSocket is unavailable (e.g. corporate proxy)
//
// The fallback kicks in automatically after WS fails — user sees a notice
// but the terminal still works.

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon }      from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {
  X, Maximize2, Minimize2, RefreshCw, Wifi, WifiOff,
  Loader2, Terminal as TermIcon, Copy, Check, AlertTriangle
} from 'lucide-react'
import api from '../lib/api'
import { useThemeStore } from '../store/themeStore'

// ── WebSocket URL ─────────────────────────────────────────────────────────────
function buildWsUrl(deviceId) {
  const token = localStorage.getItem('nc_token') || ''
  if (import.meta.env.VITE_WS_URL) {
    const base = import.meta.env.VITE_WS_URL.replace(/\/$/, '')
    return `${base}/ws/terminal/${deviceId}?token=${encodeURIComponent(token)}`
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws/terminal/${deviceId}?token=${encodeURIComponent(token)}`
}

// ── SSE URL for relay output ──────────────────────────────────────────────────
function buildSseUrl(sessionId) {
  const token = localStorage.getItem('nc_token') || ''
  return `/api/terminal/session/${sessionId}/output?token=${encodeURIComponent(token)}`
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status, transport }) {
  const cfg = {
    idle:         { icon: null,                                            text: 'Ready',          color: '#64748b' },
    connecting:   { icon: <Loader2 size={11} className="animate-spin"/>,  text: 'Connecting…',    color: '#fbbf24' },
    connected:    { icon: <Wifi size={11}/>,                              text: 'Connected',      color: '#22c55e' },
    relay:        { icon: <Wifi size={11}/>,                              text: 'Relay',          color: '#f97316' },
    error:        { icon: <WifiOff size={11}/>,                           text: 'Error',          color: '#f87171' },
    closed:       { icon: <WifiOff size={11}/>,                           text: 'Disconnected',   color: '#64748b' },
    reconnecting: { icon: <Loader2 size={11} className="animate-spin"/>,  text: 'Reconnecting…',  color: '#a78bfa' },
    relay_wait:   { icon: <Loader2 size={11} className="animate-spin"/>,  text: 'Waiting for agent…', color: '#f97316' },
  }
  const c = cfg[status] || cfg.idle
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-xs font-mono" style={{color: c.color}}>
        {c.icon} {c.text}
      </span>
      {transport === 'relay' && (
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
          style={{background:'rgba(249,115,22,0.15)',color:'#f97316',border:'1px solid rgba(249,115,22,0.3)'}}>
          HTTP relay
        </span>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function TerminalPage() {
  const { deviceId } = useParams()

  const termRef  = useRef(null)
  const xtermRef = useRef(null)
  const fitRef   = useRef(null)
  const wsRef    = useRef(null)
  const inputRef = useRef(null)
  const roRef    = useRef(null)

  // Relay state
  const relaySessionRef  = useRef(null)
  const relaySseRef      = useRef(null)
  const relaySseRetries  = useRef(0)
  const relayPollRef     = useRef(null)
  const relayActiveRef   = useRef(false)

  const [device,    setDevice]    = useState(null)
  const [status,    setStatus]    = useState('idle')
  const [transport, setTransport] = useState('ws')   // 'ws' | 'relay'
  const [errMsg,    setErrMsg]    = useState('')
  const [fullscreen,setFull]      = useState(false)
  const [copied,    setCopied]    = useState(false)
  const [showRelayBanner, setShowRelayBanner] = useState(false)

  const { theme } = useThemeStore()
  const isLight = theme === 'light'

  // ── Dispose ───────────────────────────────────────────────────────────────
  const disposeInput = () => {
    if (inputRef.current) { try { inputRef.current.dispose() } catch {} inputRef.current = null }
  }
  const closeWs = () => {
    if (wsRef.current) {
      try { wsRef.current.onclose = null; wsRef.current.close() } catch {}
      wsRef.current = null
    }
  }
  const stopRelay = useCallback(() => {
    relayActiveRef.current = false
    relaySseRetries.current = 0
    if (relaySseRef.current) { try { relaySseRef.current.close() } catch {} relaySseRef.current = null }
    if (relayPollRef.current) { clearInterval(relayPollRef.current); relayPollRef.current = null }
    if (relaySessionRef.current) {
      api.delete(`/terminal/session/${relaySessionRef.current}`).catch(() => {})
      relaySessionRef.current = null
    }
  }, [])

  // ── Init xterm (once) ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!termRef.current) return

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14, lineHeight: 1.4,
      cursorBlink: true, cursorStyle: 'bar',
      scrollback: 10000, allowProposedApi: true,
      theme: isLight ? {
        background:'#fafafa', foreground:'#0f172a', cursor:'#6c5ce7',
        cursorAccent:'#ffffff', selectionBackground:'rgba(108,92,231,0.25)',
        black:'#334155', red:'#dc2626', green:'#16a34a', yellow:'#ca8a04',
        blue:'#2563eb', magenta:'#9333ea', cyan:'#0891b2', white:'#1e293b',
        brightBlack:'#64748b', brightRed:'#ef4444', brightGreen:'#22c55e',
        brightYellow:'#eab308', brightBlue:'#3b82f6', brightMagenta:'#a855f7',
        brightCyan:'#06b6d4', brightWhite:'#334155',
      } : {
        background:'#09090f', foreground:'#e2e8f0', cursor:'#38bdf8',
        cursorAccent:'#09090f', selectionBackground:'rgba(56,189,248,0.3)',
        black:'#1a1a2e', red:'#ef4444', green:'#22c55e', yellow:'#eab308',
        blue:'#3b82f6', magenta:'#a855f7', cyan:'#06b6d4', white:'#e2e8f0',
        brightBlack:'#475569', brightRed:'#f87171', brightGreen:'#4ade80',
        brightYellow:'#fbbf24', brightBlue:'#60a5fa', brightMagenta:'#c084fc',
        brightCyan:'#22d3ee', brightWhite:'#f8fafc',
      },
    })

    const fit   = new FitAddon()
    const links = new WebLinksAddon()
    term.loadAddon(fit); term.loadAddon(links)
    term.open(termRef.current)
    requestAnimationFrame(() => { try { fit.fit() } catch {} })
    xtermRef.current = term; fitRef.current = fit

    const ro = new ResizeObserver(() => {
      try { fit.fit() } catch {}
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN && xtermRef.current) {
        ws.send(JSON.stringify({ type:'resize', cols: xtermRef.current.cols, rows: xtermRef.current.rows }))
      }
    })
    ro.observe(termRef.current); roRef.current = ro

    return () => {
      ro.disconnect(); disposeInput(); closeWs(); stopRelay()
      term.dispose(); xtermRef.current = null; fitRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load device ───────────────────────────────────────────────────────────
  useEffect(() => {
    api.get(`/devices/${deviceId}`)
      .then(r => { setDevice(r.data); document.title = `Terminal — ${r.data.name}` })
      .catch(() => setErrMsg('Failed to load device'))
  }, [deviceId])

  // ── HTTP Relay fallback ────────────────────────────────────────────────────
  // Called when WebSocket SSH fails. Opens an HTTP relay session that the
  // netcontrol-agent on the device polls and proxies to a local shell.
  const startRelay = useCallback(async () => {
    const term = xtermRef.current
    term?.writeln('\r\n\x1b[90m[WebSocket unavailable — falling back to HTTP relay…]\x1b[0m\r\n')
    term?.writeln('\x1b[90m[The device agent must be running for this to work]\x1b[0m\r\n')

    setStatus('relay_wait')
    setTransport('relay')
    setShowRelayBanner(true)

    try {
      // Open session on backend
      const { data } = await api.post(`/terminal/open/${deviceId}`)
      const { sessionId } = data
      relaySessionRef.current = sessionId
      relayActiveRef.current  = true

      // SSE stream for output from agent → browser.
      //
      // Retries transient failures instead of declaring the whole relay dead
      // on the first onerror. Two very different things can trigger onerror:
      //   1. A genuine "session not found" 404 (e.g. this GET happened to
      //      reach a worker mid-restart, or arrived a beat before the
      //      backend finished writing session state) — per the EventSource
      //      spec, a non-2xx response is FATAL: readyState goes straight to
      //      CLOSED and the browser will never retry on its own. Previously
      //      any onerror was treated as unrecoverable and immediately tore
      //      the whole relay down — so a single blip anywhere in that path
      //      permanently killed the session from the browser's point of
      //      view, even though the session itself was often still alive
      //      server-side (see services/webTerminal.js's Redis-backed state).
      //   2. A real, sustained disconnect (agent actually gone, session
      //      actually closed/expired) — this should still fail visibly.
      // So: reopen a fresh EventSource against the same sessionId with a
      // short backoff, up to a few attempts, before giving up for good.
      relaySseRetries.current = 0
      const MAX_SSE_RETRIES = 4
      const openSse = () => {
        const es = new EventSource(buildSseUrl(sessionId))
        relaySseRef.current = es

        es.onopen = () => { relaySseRetries.current = 0 }

        es.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data)
            if (msg.type === 'data')   { xtermRef.current?.write(msg.data) }
            if (msg.type === 'status') {
              if (msg.data?.includes('starting shell')) setStatus('relay')
              term?.writeln(`\r\n\x1b[90m${msg.data}\x1b[0m\r\n`)
            }
            if (msg.type === 'closed') { setStatus('closed'); stopRelay() }
          } catch {}
        }

        es.onerror = () => {
          if (!relayActiveRef.current) return
          try { es.close() } catch {}

          if (relaySseRetries.current < MAX_SSE_RETRIES) {
            relaySseRetries.current += 1
            const delay = Math.min(500 * 2 ** relaySseRetries.current, 5000)
            term?.writeln(`\r\n\x1b[90m[Relay stream hiccup — reconnecting… (${relaySseRetries.current}/${MAX_SSE_RETRIES})]\x1b[0m\r\n`)
            setTimeout(() => { if (relayActiveRef.current) openSse() }, delay)
            return
          }

          term?.writeln('\r\n\x1b[91m[Relay output stream lost]\x1b[0m\r\n')
          setStatus('error')
          setErrMsg('HTTP relay stream disconnected')
          stopRelay()
        }
      }
      openSse()

      // Wire terminal input → relay input endpoint
      disposeInput()
      inputRef.current = xtermRef.current?.onData(async (data) => {
        if (!relaySessionRef.current || !relayActiveRef.current) return
        try {
          await api.post(`/terminal/session/${sessionId}/input`, { data })
        } catch {}
      })

    } catch (e) {
      setStatus('error')
      setErrMsg(`Relay failed: ${e.response?.data?.error || e.message}`)
      term?.writeln(`\r\n\x1b[1;31m✖ Relay error: ${e.message}\x1b[0m\r\n`)
      term?.writeln('\x1b[90mMake sure the netcontrol-agent is running on the device.\x1b[0m\r\n')
    }
  }, [deviceId, stopRelay])

  // ── WebSocket connect ─────────────────────────────────────────────────────
  const connect = useCallback(() => {
    closeWs(); disposeInput(); stopRelay()

    setStatus('connecting')
    setTransport('ws')
    setErrMsg('')
    setShowRelayBanner(false)

    const url  = buildWsUrl(deviceId)
    const ws   = new WebSocket(url)
    wsRef.current = ws

    const term = xtermRef.current
    term?.clear()
    term?.writeln('\x1b[90m[Connecting via SSH…]\x1b[0m\r\n')

    // Track if we should attempt relay on failure
    let wsFailedClean = false

    ws.onopen = () => {
      requestAnimationFrame(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ type:'connect', cols: term?.cols||80, rows: term?.rows||24 }))
      })
    }

    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type === 'data')   { xtermRef.current?.write(msg.data) }
      if (msg.type === 'status') {
        if (msg.data?.startsWith('Connected')) { setStatus('connected'); setErrMsg(msg.data) }
        else setErrMsg(msg.data || '')
      }
      if (msg.type === 'error') {
        wsFailedClean = true  // SSH auth/network error — try relay
        setErrMsg(msg.data || 'SSH error')
        xtermRef.current?.writeln(`\r\n\x1b[1;31m✖ ${msg.data || 'SSH error'}\x1b[0m\r\n`)
      }
    }

    ws.onclose = (e) => {
      if (e.code === 1000) {
        // Normal close
        setStatus('closed')
        xtermRef.current?.writeln('\r\n\x1b[90m[Connection closed]\x1b[0m\r\n')
      } else if (e.code === 1011 || e.code === 1008) {
        // Server error / SSH failure (e.g. connection refused, auth failed,
        // sshd not running). This used to just report the error and stop —
        // but "SSH service not working" is exactly the case the HTTP relay
        // exists for, so fall back to it here too, same as the network-level
        // (1006) case below.
        const reason = e.reason || `SSH failed (${e.code})`
        setErrMsg(reason)
        if (!relayActiveRef.current) {
          startRelay()
        } else {
          setStatus('error')
        }
      } else if (e.code === 1006 || e.code === 0) {
        // Abnormal close / network failure — try HTTP relay automatically
        if (!relayActiveRef.current) {
          startRelay()
        }
      } else {
        // Unknown close — auto-retry WS once, then relay
        setStatus('reconnecting')
        xtermRef.current?.writeln('\r\n\x1b[90m[Connection lost — retrying…]\x1b[0m\r\n')
        setTimeout(() => {
          if (wsRef.current === ws) {
            // If still on same dead socket, try relay
            startRelay()
          }
        }, 2000)
      }
    }

    ws.onerror = () => { /* handled in onclose */ }

    inputRef.current = term?.onData(data => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type:'data', data }))
      }
    })
  }, [deviceId, startRelay, stopRelay])

  useEffect(() => {
    const t = setTimeout(connect, 200)
    return () => { clearTimeout(t); closeWs(); disposeInput(); stopRelay() }
  }, [connect, stopRelay])

  const reconnect = () => { stopRelay(); connect() }
  const useRelay  = () => { closeWs(); disposeInput(); startRelay() }

  const toggleFull = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.()
    else document.exitFullscreen?.()
    setFull(f => !f)
    setTimeout(() => { try { fitRef.current?.fit() } catch {} }, 150)
  }

  const copyIP = () => {
    if (!device?.ip_address) return
    navigator.clipboard.writeText(device.ip_address).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }

  const termBg    = isLight ? '#fafafa'   : '#09090f'
  const barBg     = isLight ? '#ffffff'   : '#0f0f1a'
  const barBorder = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)'
  const textPri   = isLight ? '#0f172a'   : '#e2e8f0'
  const textMut   = '#64748b'

  return (
    <div className="flex flex-col h-screen select-none" style={{background: termBg}}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 shrink-0 z-10"
        style={{background: barBg, borderBottom: `1px solid ${barBorder}`}}>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style={{background: isLight ? '#6c5ce7' : 'rgba(56,189,248,0.15)', border: isLight ? 'none' : '1px solid rgba(56,189,248,0.25)'}}>
          <TermIcon size={13} style={{color: isLight ? '#fff' : '#38bdf8'}}/>
        </div>
        <div className="flex flex-col min-w-0 mr-2">
          <span className="text-sm font-semibold leading-tight truncate" style={{color: textPri}}>
            {device?.name || 'Terminal'}
          </span>
          {device && (
            <button onClick={copyIP} className="flex items-center gap-1 text-[11px] font-mono text-left leading-tight" style={{color: textMut}}>
              {device.ip_address}
              {copied ? <Check size={9} style={{color:'#22c55e'}}/> : <Copy size={9} className="opacity-0 hover:opacity-100 transition-opacity"/>}
            </button>
          )}
        </div>
        <StatusBadge status={status} transport={transport}/>
        {errMsg && status !== 'connected' && status !== 'relay' && (
          <span className="text-[11px] font-body truncate hidden sm:block" style={{color: textMut}}>— {errMsg}</span>
        )}
        <div className="flex-1"/>
        {[
          { icon: <RefreshCw size={13} className={status==='reconnecting'||status==='relay_wait'?'animate-spin':''}/>, fn: reconnect, title:'Reconnect via SSH', hover: isLight ? '#6c5ce7' : '#a78bfa' },
          { icon: fullscreen ? <Minimize2 size={13}/> : <Maximize2 size={13}/>, fn: toggleFull, title: fullscreen?'Exit fullscreen':'Fullscreen', hover: textPri },
          { icon: <X size={13}/>, fn: () => window.close(), title:'Close', hover:'#f87171' },
        ].map(({icon,fn,title,hover},i) => (
          <button key={i} onClick={fn} title={title} className="p-1.5 rounded-lg transition-all" style={{color: textMut}}
            onMouseEnter={e=>e.currentTarget.style.color=hover}
            onMouseLeave={e=>e.currentTarget.style.color=textMut}>
            {icon}
          </button>
        ))}
      </div>

      {/* ── Relay info banner ─────────────────────────────────────────────── */}
      {showRelayBanner && (
        <div className="px-4 py-2 shrink-0 flex items-center gap-3"
          style={{background:'rgba(249,115,22,0.06)',borderBottom:'1px solid rgba(249,115,22,0.2)'}}>
          <AlertTriangle size={12} style={{color:'#f97316',flexShrink:0}}/>
          <p className="text-[11px] font-body flex-1" style={{color:'#f97316'}}>
            Using HTTP relay — direct SSH unavailable. Performance may be lower.
          </p>
          <button onClick={reconnect} className="text-[11px] font-semibold px-2 py-1 rounded-lg"
            style={{background:'rgba(249,115,22,0.15)',color:'#f97316',border:'1px solid rgba(249,115,22,0.3)'}}>
            Try SSH
          </button>
        </div>
      )}

      {/* ── Error panel ───────────────────────────────────────────────────── */}
      {status === 'error' && !relayActiveRef.current && (
        <div className="px-4 py-3 shrink-0" style={{background:'rgba(239,68,68,0.07)',borderBottom:'1px solid rgba(239,68,68,0.2)'}}>
          <div className="flex items-start gap-3 max-w-2xl">
            <WifiOff size={14} style={{color:'#f87171',flexShrink:0,marginTop:1}}/>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold mb-1" style={{color:'#f87171'}}>SSH connection failed</p>
              <p className="text-[11px] font-mono break-all" style={{color:textMut}}>{errMsg}</p>
              <div className="mt-2 space-y-0.5 text-[11px]" style={{color:textMut}}>
                <p>• Make sure SSH is running on the device (port 22)</p>
                <p>• Check SSH credentials are correct in Device settings</p>
                <p>• Verify the NetControl server can reach the device IP</p>
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={reconnect} className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                  style={{background:'rgba(239,68,68,0.15)',color:'#f87171',border:'1px solid rgba(239,68,68,0.3)'}}>
                  Retry SSH
                </button>
                <button onClick={useRelay} className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                  style={{background:'rgba(249,115,22,0.12)',color:'#f97316',border:'1px solid rgba(249,115,22,0.3)'}}>
                  Use HTTP relay (requires agent)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Terminal ──────────────────────────────────────────────────────── */}
      <div ref={termRef} className="flex-1 overflow-hidden"
        style={{padding:'6px 6px 4px 8px', background: termBg}}/>
    </div>
  )
}