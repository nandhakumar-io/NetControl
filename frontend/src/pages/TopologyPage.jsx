// pages/TopologyPage.jsx — live, interactive network topology map.
//
// Renders devices as a hub-and-spoke graph: Organization (core) → Group/Site
// hubs → individual devices, positioned with a radial auto-layout so it
// reads the same whether you have 3 devices or 300. Built on plain SVG (no
// new dependency) so it matches the zero-extra-bundle approach the rest of
// the frontend uses.
//
// Data comes from the same endpoints DevicesPage/GroupsPage already use
// (GET /devices, GET /groups) — there is no separate "topology" table, the
// graph is derived client-side from group membership + live status. This
// keeps it truthful: a device can never drift out of sync with what
// Devices/Monitoring show, because it's the same rows.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Network, Search, RefreshCw, Loader2, ZoomIn, ZoomOut, Maximize2, Minimize2,
  Download, X, TerminalSquare, Activity, HardDrive, Layers, Filter,
  LocateFixed, Building2, Wifi, WifiOff, Ban,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'
import { useThemeStore } from '../store/themeStore'

// ── Status → color, matches the dot palette used on DevicesPage ────────────
const STATUS_COLOR = {
  online:         '#22c55e',
  offline:        '#64748b',
  needs_approval: '#fbbf24',
  unknown:        '#fbbf24',
  error:          '#ef4444',
}
const STATUS_LABEL = {
  online: 'Online', offline: 'Offline', needs_approval: 'Pending Approval',
  unknown: 'Unknown', error: 'Error',
}
function statusColor(s) { return STATUS_COLOR[s] || STATUS_COLOR.unknown }

const VIEW_W = 1200
const VIEW_H = 760
const MIN_SCALE = 0.35
const MAX_SCALE = 2.5

// ── Radial auto-layout ───────────────────────────────────────────────────────
// core (org) at the center → one hub per group on an outer ring → devices
// fanned out in an arc behind each hub, facing away from the core. Ring/arc
// radii scale with the number of groups/devices so the graph stays legible
// from a 3-device lab to a few hundred devices across a dozen sites.
function computeLayout(devices, groups) {
  const byGroup = new Map()
  for (const d of devices) {
    const gid = d.group_id || '__ungrouped'
    if (!byGroup.has(gid)) byGroup.set(gid, [])
    byGroup.get(gid).push(d)
  }
  const groupMeta = groups.filter(g => byGroup.has(g.id))
  if (byGroup.has('__ungrouped')) groupMeta.push({ id: '__ungrouped', name: 'Ungrouped' })

  const n = Math.max(groupMeta.length, 1)
  const ringR = Math.max(200, Math.min(340, 130 + n * 26))

  const nodes = [{ id: 'core', type: 'core', x: 0, y: 0, label: 'Core' }]
  const edges = []

  groupMeta.forEach((g, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    const gx = ringR * Math.cos(angle)
    const gy = ringR * Math.sin(angle)
    const devs = byGroup.get(g.id) || []
    nodes.push({
      id: `grp:${g.id}`, type: 'group', x: gx, y: gy, angle,
      label: g.name, count: devs.length,
    })
    edges.push({ id: `e-core-${g.id}`, from: 'core', to: `grp:${g.id}`, status: 'core' })

    const m = devs.length
    const armR = Math.max(70, Math.min(210, 46 + m * 10))
    const spread = m <= 1 ? 0 : Math.min(Math.PI * 1.7, 0.6 + m * 0.28)
    devs.forEach((d, j) => {
      const a = m <= 1 ? angle : angle - spread / 2 + (spread * j) / (m - 1)
      nodes.push({
        id: `dev:${d.id}`, type: 'device', x: gx + armR * Math.cos(a), y: gy + armR * Math.sin(a),
        device: d, groupId: g.id,
      })
      edges.push({ id: `e-${g.id}-${d.id}`, from: `grp:${g.id}`, to: `dev:${d.id}`, status: d.status || 'unknown' })
    })
  })

  return { nodes, edges }
}

// ── Small building blocks ────────────────────────────────────────────────────

function LegendDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

function DeviceNode({ node, selected, dimmed, onClick, isLight }) {
  const color = statusColor(node.device.status)
  const r = 15
  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      onClick={(e) => { e.stopPropagation(); onClick(node) }}
      style={{ cursor: 'pointer', opacity: dimmed ? 0.28 : 1, transition: 'opacity 0.15s ease' }}
    >
      {selected && <circle r={r + 6} fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.6" />}
      {node.device.status === 'online' && (
        <circle r={r} fill={color} opacity="0.18">
          <animate attributeName="r" values={`${r};${r + 8};${r}`} dur="2.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.18;0;0.18" dur="2.6s" repeatCount="indefinite" />
        </circle>
      )}
      <circle r={r} fill={isLight ? '#ffffff' : 'rgba(20,20,36,0.95)'} stroke={color} strokeWidth="2.5" />
      <foreignObject x={-8} y={-8} width={16} height={16} style={{ pointerEvents: 'none' }}>
        <HardDrive size={16} color={color} />
      </foreignObject>
      <text y={r + 14} textAnchor="middle" fontSize="10.5" fontFamily="DM Sans, sans-serif"
        fill="var(--text-secondary)" style={{ pointerEvents: 'none' }}>
        {node.device.name.length > 16 ? node.device.name.slice(0, 15) + '…' : node.device.name}
      </text>
    </g>
  )
}

function GroupNode({ node, selected, dimmed, onClick, isLight }) {
  const r = 26
  const onlineCount = node.onlineCount ?? 0
  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      onClick={(e) => { e.stopPropagation(); onClick(node) }}
      style={{ cursor: 'pointer', opacity: dimmed ? 0.3 : 1, transition: 'opacity 0.15s ease' }}
    >
      {selected && <circle r={r + 7} fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.6" />}
      <circle r={r} fill={isLight ? '#ffffff' : 'rgba(28,28,48,0.92)'} stroke="var(--accent)" strokeWidth="2" />
      <foreignObject x={-11} y={-11} width={22} height={22} style={{ pointerEvents: 'none' }}>
        <Layers size={22} color="var(--accent)" />
      </foreignObject>
      <text y={r + 16} textAnchor="middle" fontSize="12" fontWeight="600" fontFamily="DM Sans, sans-serif"
        fill="var(--text-primary)" style={{ pointerEvents: 'none' }}>
        {node.label.length > 20 ? node.label.slice(0, 19) + '…' : node.label}
      </text>
      <text y={r + 30} textAnchor="middle" fontSize="10" fontFamily="DM Sans, sans-serif"
        fill="var(--text-muted)" style={{ pointerEvents: 'none' }}>
        {onlineCount}/{node.count} online
      </text>
    </g>
  )
}

function CoreNode({ node, orgName, isLight }) {
  const r = 34
  const size = r * 2
  return (
    <g transform={`translate(${node.x},${node.y})`} style={{ cursor: 'default' }}>
      <circle r={r + 10} fill="var(--accent)" opacity="0.10" />
      <circle r={r} fill={isLight ? '#6c5ce7' : 'rgba(167,139,250,0.16)'}
        stroke="var(--accent)" strokeWidth="2" />
      <foreignObject x={-14} y={-14} width={28} height={28} style={{ pointerEvents: 'none' }}>
        <Network size={28} color={isLight ? '#ffffff' : '#a78bfa'} />
      </foreignObject>
      <text y={r + 18} textAnchor="middle" fontSize="12.5" fontWeight="700" fontFamily="DM Sans, sans-serif"
        fill="var(--text-primary)" style={{ pointerEvents: 'none' }}>
        {orgName || 'Organization'}
      </text>
    </g>
  )
}

// ── Device detail drawer ────────────────────────────────────────────────────
function DeviceDrawer({ device, onClose, isLight }) {
  const navigate = useNavigate()
  if (!device) return null
  const status = device.status || 'unknown'
  return (
    <div className="absolute top-0 right-0 h-full w-full sm:w-80 z-20 animate-fade-in"
      style={{
        background: isLight ? '#ffffff' : 'rgba(14,14,26,0.97)',
        borderLeft: '1px solid var(--border-subtle)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
      }}>
      <div className="flex items-start justify-between p-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0">
          <p className="font-display text-base truncate" style={{ color: 'var(--text-primary)' }}>{device.name}</p>
          <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>{device.group_name || 'Ungrouped'}</p>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ color: 'var(--text-muted)' }}>
          <X size={16} />
        </button>
      </div>

      <div className="p-4 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(100% - 130px)' }}>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: statusColor(status) }} />
          <span className="text-sm font-body font-medium" style={{ color: statusColor(status) }}>
            {STATUS_LABEL[status] || 'Unknown'}
          </span>
        </div>

        <dl className="space-y-2 text-sm font-body">
          <div className="flex justify-between"><dt style={{ color: 'var(--text-muted)' }}>IP address</dt><dd style={{ color: 'var(--text-primary)' }}>{device.ip_address || '—'}</dd></div>
          <div className="flex justify-between"><dt style={{ color: 'var(--text-muted)' }}>MAC address</dt><dd style={{ color: 'var(--text-primary)' }}>{device.mac_address || '—'}</dd></div>
          <div className="flex justify-between"><dt style={{ color: 'var(--text-muted)' }}>OS type</dt><dd style={{ color: 'var(--text-primary)' }} className="capitalize">{device.os_type || '—'}</dd></div>
          <div className="flex justify-between"><dt style={{ color: 'var(--text-muted)' }}>Agent version</dt><dd style={{ color: 'var(--text-primary)' }}>{device.agent_version || '—'}</dd></div>
        </dl>

        <div className="flex flex-col gap-2 pt-2">
          <button className="btn-ghost w-full justify-center" onClick={() => navigate(`/monitoring?deviceId=${device.id}`)}>
            <Activity size={15} /> View monitoring
          </button>
          {device.ssh_username && (
            <button className="btn-ghost w-full justify-center"
              onClick={() => window.open(`/terminal/${device.id}`, '_blank', 'noopener,noreferrer')}>
              <TerminalSquare size={15} /> Open terminal
            </button>
          )}
          <button className="btn-ghost w-full justify-center" onClick={() => navigate(`/devices?highlight=${device.id}`)}>
            <HardDrive size={15} /> Open in Devices
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Group detail drawer (lighter — summary + jump-to-group) ─────────────────
function GroupDrawer({ node, onClose, onIsolate, isolated, isLight, navigate }) {
  if (!node) return null
  const offline = node.count - (node.onlineCount ?? 0)
  return (
    <div className="absolute top-0 right-0 h-full w-full sm:w-80 z-20 animate-fade-in"
      style={{
        background: isLight ? '#ffffff' : 'rgba(14,14,26,0.97)',
        borderLeft: '1px solid var(--border-subtle)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
      }}>
      <div className="flex items-start justify-between p-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0">
          <p className="font-display text-base truncate" style={{ color: 'var(--text-primary)' }}>{node.label}</p>
          <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>{node.count} device{node.count === 1 ? '' : 's'}</p>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ color: 'var(--text-muted)' }}>
          <X size={16} />
        </button>
      </div>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-surface-3)' }}>
            <p className="text-lg font-display" style={{ color: '#22c55e' }}>{node.onlineCount ?? 0}</p>
            <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>Online</p>
          </div>
          <div className="rounded-xl p-3 text-center" style={{ background: 'var(--bg-surface-3)' }}>
            <p className="text-lg font-display" style={{ color: 'var(--text-secondary)' }}>{offline}</p>
            <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>Offline / other</p>
          </div>
        </div>
        <button className="btn-ghost w-full justify-center" onClick={() => onIsolate(isolated ? null : node.id)}>
          <Filter size={15} /> {isolated ? 'Show full topology' : 'Isolate this site'}
        </button>
        <button className="btn-ghost w-full justify-center" onClick={() => navigate(`/groups?highlight=${node.id.replace('grp:', '')}`)}>
          <Layers size={15} /> Open in Groups
        </button>
      </div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function TopologyPage() {
  const { theme } = useThemeStore()
  const isLight = theme === 'light'
  const navigate = useNavigate()

  const [devices, setDevices]   = useState([])
  const [groups, setGroups]     = useState([])
  const [loading, setLoading]   = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch]     = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [isolatedGroup, setIsolatedGroup] = useState(null)
  const [selectedNode, setSelectedNode] = useState(null)
  const [fullscreen, setFullscreen] = useState(false)
  const containerRef = useRef(null)

  // pan/zoom transform
  const [view, setView] = useState({ scale: 1, x: VIEW_W / 2, y: VIEW_H / 2 })
  const dragRef = useRef(null)

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true); else setRefreshing(true)
    try {
      const [dRes, gRes] = await Promise.all([api.get('/devices'), api.get('/groups')])
      setDevices(dRes.data || [])
      setGroups(gRes.data || [])
    } catch (e) {
      toast.error('Failed to load topology data')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [])

  useEffect(() => { load(false) }, [load])

  // Auto-refresh statuses in the background, same 20s cadence DevicesPage
  // uses — the map should reflect live health without the person doing
  // anything, since "is this thing actually up right now" is the whole point.
  useEffect(() => {
    const t = setInterval(() => load(true), 20000)
    return () => clearInterval(t)
  }, [load])

  const { nodes, edges } = useMemo(() => computeLayout(devices, groups), [devices, groups])

  // Attach onlineCount to group nodes now that we have the full node list
  const nodesWithCounts = useMemo(() => {
    return nodes.map(n => {
      if (n.type !== 'group') return n
      const online = nodes.filter(d => d.type === 'device' && d.groupId === n.id.slice(4) && d.device.status === 'online').length
      return { ...n, onlineCount: online }
    })
  }, [nodes])

  const matchesFilters = useCallback((node) => {
    if (node.type === 'core') return true
    if (isolatedGroup && node.type === 'group' && node.id !== isolatedGroup) return false
    if (isolatedGroup && node.type === 'device' && `grp:${node.groupId}` !== isolatedGroup) return false
    if (node.type !== 'device') return true
    const d = node.device
    if (statusFilter !== 'all' && (d.status || 'unknown') !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (!d.name.toLowerCase().includes(q) && !(d.ip_address || '').includes(q) && !(d.group_name || '').toLowerCase().includes(q)) return false
    }
    return true
  }, [statusFilter, search, isolatedGroup])

  const nodeById = useMemo(() => {
    const m = new Map()
    nodesWithCounts.forEach(n => m.set(n.id, n))
    return m
  }, [nodesWithCounts])

  const stats = useMemo(() => {
    const total = devices.length
    const online = devices.filter(d => d.status === 'online').length
    const offline = devices.filter(d => d.status === 'offline').length
    return { total, online, offline, sites: groups.length }
  }, [devices, groups])

  // ── Pan / zoom handlers ────────────────────────────────────────────────
  const zoomBy = (factor, cx = VIEW_W / 2, cy = VIEW_H / 2) => {
    setView(v => {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
      // keep the point under (cx,cy) fixed while zooming
      const k = nextScale / v.scale
      return { scale: nextScale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })
  }
  const resetView = () => setView({ scale: 1, x: VIEW_W / 2, y: VIEW_H / 2 })

  const onWheel = (e) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = ((e.clientX - rect.left) / rect.width) * VIEW_W
    const cy = ((e.clientY - rect.top) / rect.height) * VIEW_H
    zoomBy(e.deltaY < 0 ? 1.12 : 0.89, cx, cy)
  }
  const onMouseDown = (e) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y }
  }
  const onMouseMove = (e) => {
    if (!dragRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const dx = ((e.clientX - dragRef.current.startX) / rect.width) * VIEW_W
    const dy = ((e.clientY - dragRef.current.startY) / rect.height) * VIEW_H
    setView(v => ({ ...v, x: dragRef.current.origX + dx, y: dragRef.current.origY + dy }))
  }
  const endDrag = () => { dragRef.current = null }

  const focusNode = (node) => {
    setSelectedNode(node)
    setView(v => ({
      scale: Math.max(v.scale, 1.1),
      x: VIEW_W / 2 - node.x * Math.max(v.scale, 1.1),
      y: VIEW_H / 2 - node.y * Math.max(v.scale, 1.1),
    }))
  }

  const exportSvg = () => {
    const svgEl = containerRef.current?.querySelector('svg')
    if (!svgEl) return
    const clone = svgEl.cloneNode(true)
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'network-topology.svg'; a.click()
    URL.revokeObjectURL(url)
  }

  // ── Minimap geometry ─────────────────────────────────────────────────────
  const mapW = 150, mapH = 96
  const bounds = useMemo(() => {
    const xs = nodesWithCounts.map(n => n.x), ys = nodesWithCounts.map(n => n.y)
    const pad = 60
    return {
      minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad,
      minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad,
    }
  }, [nodesWithCounts])
  const bw = Math.max(1, bounds.maxX - bounds.minX)
  const bh = Math.max(1, bounds.maxY - bounds.minY)
  const mScale = Math.min(mapW / bw, mapH / bh)
  const toMap = (x, y) => [ (x - bounds.minX) * mScale, (y - bounds.minY) * mScale ]
  // viewport rect in world coords: the visible VIEW_W x VIEW_H window given current transform
  const vpX0 = -view.x / view.scale, vpY0 = -view.y / view.scale
  const vpW = VIEW_W / view.scale, vpH = VIEW_H / view.scale
  const [vx0, vy0] = toMap(vpX0, vpY0)
  const vpMapW = vpW * mScale, vpMapH = vpH * mScale

  const orgName = useMemo(() => {
    // Best-effort: if any device carries an org name field, use it; else generic label.
    return devices[0]?.org_name || null
  }, [devices])

  const wrapperClasses = fullscreen
    ? 'fixed inset-0 z-40 p-4 sm:p-6 overflow-auto'
    : ''

  return (
    <div className={wrapperClasses} style={fullscreen ? { background: 'var(--bg-page)' } : {}}>
      <PageHeader
        icon={Network}
        title="Network Topology"
        description="Live map of every site and device, derived from your groups and monitoring status"
        actions={
          <>
            <button className="btn-ghost" onClick={() => load(true)} disabled={refreshing}>
              {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Refresh
            </button>
            <button className="btn-ghost" onClick={exportSvg}>
              <Download size={15} /> Export SVG
            </button>
            <button className="btn-ghost" onClick={() => setFullscreen(f => !f)}>
              {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </button>
          </>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <StatCard icon={HardDrive} label="Devices" value={stats.total} iconColor="text-brand-400" iconBg="bg-brand-500/15" />
        <StatCard icon={Wifi} label="Online" value={stats.online} iconColor="text-accent-green" iconBg="bg-accent-green/15" accent="text-accent-green" />
        <StatCard icon={WifiOff} label="Offline" value={stats.offline} iconColor="text-slate-400" iconBg="bg-slate-400/15" />
        <StatCard icon={Building2} label="Sites / Groups" value={stats.sites} iconColor="text-brand-400" iconBg="bg-brand-500/15" />
      </div>

      {/* Toolbar */}
      <div className="card mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input
            className="input-field pl-9"
            placeholder="Search device, IP, or site…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {['all', 'online', 'offline', 'unknown'].map(v => (
            <button
              key={v}
              onClick={() => setStatusFilter(v)}
              className="px-3 py-1.5 rounded-lg text-xs font-body font-medium capitalize transition-colors"
              style={{
                background: statusFilter === v ? 'var(--accent)' : 'var(--bg-surface-3)',
                color: statusFilter === v ? '#fff' : 'var(--text-secondary)',
              }}
            >
              {v}
            </button>
          ))}
          {isolatedGroup && (
            <button onClick={() => setIsolatedGroup(null)}
              className="px-3 py-1.5 rounded-lg text-xs font-body font-medium flex items-center gap-1"
              style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>
              <Ban size={12} /> Clear isolation
            </button>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="card relative p-0 overflow-hidden select-none"
        style={{ height: fullscreen ? 'calc(100vh - 260px)' : '620px' }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        {loading ? (
          <div className="w-full h-full flex items-center justify-center">
            <Loader2 size={28} className="animate-spin" style={{ color: 'var(--accent)' }} />
          </div>
        ) : devices.length === 0 ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-center px-6">
            <Network size={32} style={{ color: 'var(--text-faint)' }} />
            <p className="font-body text-sm" style={{ color: 'var(--text-muted)' }}>
              No devices yet — add devices to see them appear on the map.
            </p>
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              width="100%" height="100%"
              style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
              onClick={() => setSelectedNode(null)}
            >
              <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
                {/* edges */}
                {edges.map(e => {
                  const from = nodeById.get(e.from), to = nodeById.get(e.to)
                  if (!from || !to) return null
                  const visible = matchesFilters(from) && matchesFilters(to)
                  const color = e.status === 'core' ? 'var(--border-mid)' : statusColor(e.status)
                  return (
                    <line key={e.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                      stroke={color} strokeWidth={e.status === 'core' ? 2 : 1.5}
                      opacity={visible ? (e.status === 'core' ? 0.5 : 0.55) : 0.08} />
                  )
                })}
                {/* nodes */}
                {nodesWithCounts.map(n => {
                  if (n.type === 'core') return <CoreNode key={n.id} node={n} orgName={orgName} isLight={isLight} />
                  const visible = matchesFilters(n)
                  if (n.type === 'group') {
                    return (
                      <GroupNode key={n.id} node={n} isLight={isLight}
                        selected={selectedNode?.id === n.id}
                        dimmed={!visible}
                        onClick={(node) => focusNode(node)} />
                    )
                  }
                  return (
                    <DeviceNode key={n.id} node={n} isLight={isLight}
                      selected={selectedNode?.id === n.id}
                      dimmed={!visible}
                      onClick={(node) => focusNode(node)} />
                  )
                })}
              </g>
            </svg>

            {/* Zoom controls */}
            <div className="absolute bottom-3 left-3 flex flex-col gap-1.5">
              <button onClick={() => zoomBy(1.2)} className="w-8 h-8 rounded-lg flex items-center justify-center glass-sm"
                style={{ color: 'var(--text-secondary)' }}><ZoomIn size={15} /></button>
              <button onClick={() => zoomBy(0.83)} className="w-8 h-8 rounded-lg flex items-center justify-center glass-sm"
                style={{ color: 'var(--text-secondary)' }}><ZoomOut size={15} /></button>
              <button onClick={resetView} className="w-8 h-8 rounded-lg flex items-center justify-center glass-sm"
                style={{ color: 'var(--text-secondary)' }}><LocateFixed size={15} /></button>
            </div>

            {/* Legend */}
            <div className="absolute top-3 left-3 rounded-xl px-3 py-2 flex items-center gap-3 glass-sm flex-wrap max-w-[80%]">
              <LegendDot color={STATUS_COLOR.online} label="Online" />
              <LegendDot color={STATUS_COLOR.offline} label="Offline" />
              <LegendDot color={STATUS_COLOR.unknown} label="Unknown" />
              <LegendDot color={STATUS_COLOR.error} label="Error" />
            </div>

            {/* Minimap */}
            <div className="absolute bottom-3 right-3 rounded-xl overflow-hidden glass-sm"
              style={{ width: mapW, height: mapH }}>
              <svg width={mapW} height={mapH}>
                {nodesWithCounts.map(n => {
                  const [mx, my] = toMap(n.x, n.y)
                  return <circle key={n.id} cx={mx} cy={my}
                    r={n.type === 'core' ? 3.5 : n.type === 'group' ? 2.6 : 1.4}
                    fill={n.type === 'device' ? statusColor(n.device.status) : 'var(--accent)'} />
                })}
                <rect x={vx0} y={vy0} width={vpMapW} height={vpMapH}
                  fill="none" stroke="var(--accent)" strokeWidth="1.2" />
              </svg>
            </div>

            {/* Drawers */}
            {selectedNode?.type === 'device' && (
              <DeviceDrawer device={selectedNode.device} onClose={() => setSelectedNode(null)} isLight={isLight} />
            )}
            {selectedNode?.type === 'group' && (
              <GroupDrawer node={selectedNode} onClose={() => setSelectedNode(null)} isLight={isLight}
                isolated={isolatedGroup === selectedNode.id}
                onIsolate={(id) => setIsolatedGroup(id)}
                navigate={navigate} />
            )}
          </>
        )}
      </div>
    </div>
  )
}