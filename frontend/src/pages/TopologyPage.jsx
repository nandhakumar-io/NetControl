// pages/TopologyPage.jsx — live, interactive network topology map.
//
// Radial hub-and-spoke map: Organization (core) at the center → one Site
// Router hub per group on an outer ring. Sites start collapsed (just the
// hub + a device count) — click a site to expand it, fanning out its
// Subnet Switches (derived from IP /24) and their Devices around it. This
// keeps the map readable at a glance no matter how many devices a site
// has: nothing is drawn until you ask to see it, so nodes never get
// cramped into a single narrow lane.
//
// Data comes from the same endpoints DevicesPage/GroupsPage already use
// (GET /devices, GET /groups) — there is no separate "topology" table, and
// no subnet table either: the subnet tier is derived client-side from each
// device's IP address. This keeps it truthful — a device can never drift
// out of sync with what Devices/Monitoring show, because it's the same
// rows, and the subnet grouping is just arithmetic on ip_address.
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Network, Search, RefreshCw, Loader2, ZoomIn, ZoomOut, Maximize2, Minimize2,
  Download, X, TerminalSquare, Activity, HardDrive, Layers, Filter,
  LocateFixed, Wifi, WifiOff, Ban, Router, Waypoints, ShieldCheck,
  Printer, Camera, Database, Monitor, Server, ChevronRight, ChevronDown,
  Maximize, Minimize, HelpCircle, AlertTriangle, Link2,
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

// Role colors — gives each network tier a distinct identity, the way real
// NOC maps color-code routers vs switches vs endpoints.
const CORE_COLOR   = '#a78bfa' // violet — organization core
const SITE_COLOR   = '#818cf8' // indigo — site router
const SUBNET_COLOR = '#38bdf8' // sky — subnet switch

// A site's hub used to be hardcoded as "Site Router" everywhere on the
// map — wrong the moment a site's actual gateway is a firewall, an L3
// switch, or anything else. groups.device_type (set by an admin in
// Groups → Edit) now drives both the icon and the label here. Keep this
// map in sync with GROUP_DEVICE_TYPE_OPTIONS in pages/GroupsPage.jsx and
// DEVICE_TYPES in backend/db/migrate-group-device-type.js.
const GROUP_DEVICE_TYPES = {
  router:       { Icon: Router,      label: 'Router' },
  switch:       { Icon: Waypoints,   label: 'Switch' },
  firewall:     { Icon: ShieldCheck, label: 'Firewall' },
  access_point: { Icon: Wifi,        label: 'Access Point' },
  server:       { Icon: Server,      label: 'Server' },
  other:        { Icon: HelpCircle,  label: 'Site Hub' },
}
function groupKind(deviceType) {
  return GROUP_DEVICE_TYPES[deviceType] || GROUP_DEVICE_TYPES.router
}

const VIEW_W = 1200
const VIEW_H = 760
const MIN_SCALE = 0.3
const MAX_SCALE = 2.5

// ── Subnet derivation ────────────────────────────────────────────────────
// No subnet column exists on devices — we derive a /24 from the IP so the
// map can group endpoints the way a real LAN segment would, without
// requiring anyone to configure it.
function cidr24(ip) {
  if (!ip) return null
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(String(ip).trim())
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3]}.0/24`
}

function timeAgo(ts) {
  if (!ts) return 'Never seen'
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (secs < 60) return 'Just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

// Best-effort device role guess from its name / OS — purely cosmetic, lets
// routers/switches/APs/etc that people have added as "devices" render with
// a fitting icon instead of a generic workstation glyph.
function deviceKind(d) {
  const n = (d.name || '').toLowerCase()
  if (/\brouter\b|\bgateway\b|\bgw\b/.test(n)) return { Icon: Router, label: 'Router' }
  if (/\bswitch\b|\bsw[-_]?\d/.test(n)) return { Icon: Waypoints, label: 'Switch' }
  if (/\bfirewall\b|\bfw\b|\butm\b/.test(n)) return { Icon: ShieldCheck, label: 'Firewall' }
  if (/\bap\b|wifi|wireless|access.?point/.test(n)) return { Icon: Wifi, label: 'Access Point' }
  if (/printer|\bprint\b/.test(n)) return { Icon: Printer, label: 'Printer' }
  if (/camera|cctv|\bnvr\b/.test(n)) return { Icon: Camera, label: 'Camera' }
  if (/\bnas\b|storage|\bsan\b/.test(n)) return { Icon: Database, label: 'Storage' }
  if (d.os_type === 'linux') return { Icon: Server, label: 'Linux Server' }
  return { Icon: Monitor, label: 'Workstation' }
}

// ── Non-overlapping "orbital" layout, with collapsible sites ────────────
// core (org) at the center → one hub per group on an outer ring. A group
// only fans out its subnets (and each subnet its devices) when its id is
// present in `expanded` — collapsed sites stay a single compact hub, which
// is what keeps a 300-device map from turning into a wall of icons.
//
// Every tier below is placed with an explicit minimum-clearance guarantee
// instead of an approximate chord formula. The old approach only checked
// how many siblings fit on one arc — fine for a handful of nodes, but a
// subnet with 100–300 devices (real-world here) still ended up with bands
// overlapping into a solid blob. The fix:
//   • Devices ring their subnet in full concentric "shells" — like
//     electrons around a nucleus, hence the globe look — each shell
//     filled to its actual chord capacity before opening the next one
//     further out. Zero pairwise checks needed: it can't overlap by
//     construction, whether a subnet has 3 devices or 300.
//   • Subnets ring their site with real pairwise distance checks against
//     every previously placed subnet's full device-cloud radius, since
//     subnets vary hugely in size (one might hold 4 devices, the next
//     200) — a formulaic ring can't safely assume uniform spacing there.
const GROUP_GAP        = 190 // 152px site card + margin, used for ring spacing
const DEVICE_R         = 15  // device node radius
const DEVICE_CHORD     = 50  // min center-to-center spacing on a device shell
const DEVICE_SHELL_STEP = 56 // radial gap between successive device shells
const DEVICE_BASE_R    = 62  // first device shell's radius (clears the subnet card)
const SITE_CLEARANCE   = 92  // distance from a site hub where its subnets start
const SUBNET_GAP       = 40  // min gap between two subnet clusters' outer edges

// Rings `count` devices in full concentric circles ("shells") around a
// subnet's local origin. Returns both the placements and the cluster's
// total footprint radius, which the subnet-packing step below treats as
// that subnet's "personal space" when placing it among its siblings.
function orbitDevices(count) {
  if (count === 0) return { placements: [], footprint: SITE_CLEARANCE * 0.4 }
  const placements = []
  let placed = 0, shell = 0, lastR = DEVICE_BASE_R
  while (placed < count) {
    const r = DEVICE_BASE_R + shell * DEVICE_SHELL_STEP
    lastR = r
    const capacity = Math.max(1, Math.floor((2 * Math.PI * r) / DEVICE_CHORD))
    const take = Math.min(capacity, count - placed)
    // Stagger alternating shells by half a step so shells don't line up
    // into visible spokes — reads as an organic globe, not a dartboard.
    const offset = (shell % 2) * (Math.PI / take)
    for (let i = 0; i < take; i++) {
      const a = offset + (2 * Math.PI * i) / take
      placements.push({ x: r * Math.cos(a), y: r * Math.sin(a) })
      placed++
    }
    shell++
  }
  return { placements, footprint: lastR + DEVICE_R + 22 }
}

// Places `items` (each carrying its own required clearance radius `r`)
// around a local origin, fanning out from `biasAngle` first and pushing
// each new item further out — along its own angle — until it actually
// clears every previously placed item's footprint. This keeps the classic
// "fan away from the parent" look while making overlap structurally
// impossible, regardless of how differently-sized the clusters are.
function packClusters(items, biasAngle) {
  const placed = []
  const n = items.length
  const spreadCap = Math.min(Math.PI * 1.7, 0.7 + n * 0.16)
  items.forEach((item, idx) => {
    const angle = n <= 1 ? biasAngle
      : biasAngle - spreadCap / 2 + (spreadCap * idx) / (n - 1)
    let r = SITE_CLEARANCE + item.r + 40
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = r * Math.cos(angle), y = r * Math.sin(angle)
      const clear = placed.every(p => Math.hypot(x - p.x, y - p.y) >= item.r + p.r + SUBNET_GAP)
      if (clear) { placed.push({ ...item, x, y }); return }
      r += 24
    }
    placed.push({ ...item, x: r * Math.cos(angle), y: r * Math.sin(angle) })
  })
  return placed
}

function computeLayout(devices, groups, expanded) {
  const byGroup = new Map()
  for (const d of devices) {
    const gid = d.group_id || '__ungrouped'
    if (!byGroup.has(gid)) byGroup.set(gid, [])
    byGroup.get(gid).push(d)
  }
  const groupMeta = groups.filter(g => byGroup.has(g.id))
    .map(g => ({ id: g.id, name: g.name, deviceType: g.device_type || 'router' }))
  if (byGroup.has('__ungrouped')) {
    groupMeta.push({ id: '__ungrouped', name: 'Ungrouped devices', deviceType: 'other' })
  }

  const n = Math.max(groupMeta.length, 1)

  // Pass 1 — build each expanded site's subnet/device cluster in *local*
  // coordinates (relative to that site's own hub, fanned along the local
  // +x axis) and measure its total footprint. This has to happen before
  // we know the site's final angle on the ring, so the fan is rotated
  // into the site's real "away from the core" direction afterward — pure
  // rotation, so the clearance math done here stays valid either way.
  const siteClusters = new Map()
  groupMeta.forEach(g => {
    const devs = byGroup.get(g.id) || []
    if (!expanded.has(g.id) || devs.length === 0) return
    const bySubnet = new Map()
    devs.forEach(d => {
      const key = cidr24(d.ip_address) || 'Unassigned'
      if (!bySubnet.has(key)) bySubnet.set(key, [])
      bySubnet.get(key).push(d)
    })
    const subnetKeys = [...bySubnet.keys()].sort((a, b) =>
      a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b))

    const subnetItems = subnetKeys.map(key => {
      const sdevs = bySubnet.get(key)
      const { placements, footprint } = orbitDevices(sdevs.length)
      return { key, sdevs, placements, r: footprint }
    })
    const packed = packClusters(subnetItems, 0)
    const footprint = packed.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y) + p.r), SITE_CLEARANCE)
    siteClusters.set(g.id, { packed, footprint })
  })

  // A site's own subnet cloud can dwarf the site card itself (a 200+
  // device subnet reaches hundreds of px out) — grow the site ring so a
  // big expanded site's cloud can't reach into its neighbor's hub.
  const maxFootprint = [...siteClusters.values()].reduce((m, c) => Math.max(m, c.footprint), 0)
  const ringR = Math.max(240, (n * GROUP_GAP) / (2 * Math.PI), maxFootprint ? maxFootprint + GROUP_GAP * 0.7 : 0)

  const nodes = [{ id: 'core', type: 'core', x: 0, y: 0, label: 'Core' }]
  const edges = []

  groupMeta.forEach((g, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    const gx = ringR * Math.cos(angle)
    const gy = ringR * Math.sin(angle)
    const isExpanded = expanded.has(g.id)
    nodes.push({
      id: `grp:${g.id}`, type: 'group', x: gx, y: gy, angle,
      label: g.name, expanded: isExpanded, deviceType: g.deviceType,
    })
    edges.push({ id: `e-core-${g.id}`, from: 'core', to: `grp:${g.id}`, kind: 'trunk' })

    const cluster = siteClusters.get(g.id)
    if (!cluster) return

    // Rotate the pass-1 cluster (fanned along local +x) into the site's
    // actual outward direction. Device shells are full 360° rings, so
    // they're rotationally symmetric already — no extra rotation needed
    // for them, only for each subnet's own offset from the site hub.
    const cosA = Math.cos(angle), sinA = Math.sin(angle)
    cluster.packed.forEach(sub => {
      const sx = gx + (sub.x * cosA - sub.y * sinA)
      const sy = gy + (sub.x * sinA + sub.y * cosA)
      const subnetId = `sub:${g.id}:${sub.key}`
      nodes.push({
        id: subnetId, type: 'subnet', x: sx, y: sy,
        label: sub.key, groupId: g.id, siteLabel: g.name,
      })
      edges.push({ id: `e-grp-${subnetId}`, from: `grp:${g.id}`, to: subnetId, kind: 'trunk' })

      sub.sdevs.forEach((d, di) => {
        const dp = sub.placements[di]
        nodes.push({
          id: `dev:${d.id}`, type: 'device', x: sx + dp.x, y: sy + dp.y,
          device: d, groupId: g.id, subnetKey: sub.key,
        })
        edges.push({
          id: `e-${subnetId}-${d.id}`, from: subnetId, to: `dev:${d.id}`,
          kind: 'leaf', status: d.status || 'unknown',
        })
      })
    })
  })

  return { nodes, edges }
}


function nodeHalfSize(type) {
  if (type === 'core') return 37
  if (type === 'group') return 32
  if (type === 'subnet') return 28
  return 15 // device circle radius
}

function linkPath(x1, y1, x2, y2) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
  return `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`
}

// ── Small building blocks ────────────────────────────────────────────────

function LegendDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      {label}
    </span>
  )
}
function LegendRole({ Icon, color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-body" style={{ color: 'var(--text-secondary)' }}>
      <span className="w-4 h-4 rounded-md flex items-center justify-center shrink-0"
        style={{ background: `${color}22`, border: `1px solid ${color}55` }}>
        <Icon size={10} color={color} />
      </span>
      {label}
    </span>
  )
}

// Small triage list of everything that isn't online — the whole point is
// to answer "what needs attention" without scanning a few hundred dots
// for the handful of gray/red/amber ones. Clicking a row jumps the map
// straight to that device (expanding its site first if it's collapsed).
function AlertsPanel({ devices, open, onToggle, onJump, isLight }) {
  const errorCount = devices.filter(d => d.status === 'error').length
  const offlineCount = devices.filter(d => d.status === 'offline').length
  const otherCount = devices.length - errorCount - offlineCount
  return (
    <div className="rounded-xl glass-sm overflow-hidden" style={{ width: 240 }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        style={{ color: 'var(--text-secondary)' }}
      >
        <AlertTriangle size={13} color={STATUS_COLOR.error} />
        <span className="text-xs font-body font-semibold flex-1">
          {devices.length} need{devices.length === 1 ? 's' : ''} attention
        </span>
        <ChevronDown size={13} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
      </button>
      {open && (
        <div className="max-h-[220px] overflow-y-auto" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {devices.map(d => (
            <button
              key={d.id}
              onClick={() => onJump(d)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-black/5"
              style={{ fontSize: 11 }}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor(d.status) }} />
              <span className="flex-1 min-w-0 truncate font-body" style={{ color: 'var(--text-primary)' }}>{d.name}</span>
              <span className="shrink-0 font-body" style={{ color: 'var(--text-faint)' }}>{timeAgo(d.last_seen)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Node components ──────────────────────────────────────────────────────

function DeviceNode({ node, selected, dimmed, pulsing, onClick, onHover, onLeave, isLight }) {
  const { device } = node
  const { Icon } = deviceKind(device)
  const color = statusColor(device.status)
  const r = 15
  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      onClick={(e) => { e.stopPropagation(); onClick(node) }}
      onMouseEnter={(e) => onHover(node, e)}
      onMouseMove={(e) => onHover(node, e)}
      onMouseLeave={onLeave}
      style={{ cursor: 'pointer', opacity: dimmed ? 0.25 : 1, transition: 'opacity 0.15s ease' }}
    >
      {selected && <circle r={r + 6} fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.6" />}
      {device.status === 'online' && (
        <circle r={r} fill={color} opacity="0.18">
          <animate attributeName="r" values={`${r};${r + 8};${r}`} dur="2.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.18;0;0.18" dur="2.6s" repeatCount="indefinite" />
        </circle>
      )}
      {/* Status-transition flash — a brief expanding ring the moment this
          device's status changes on a background refresh, so a device
          going offline is noticeable without staring at the map. */}
      {pulsing && (
        <circle r={r} fill="none" stroke={color} strokeWidth="3" opacity="0.9">
          <animate attributeName="r" values={`${r};${r + 16}`} dur="1.3s" repeatCount="2" />
          <animate attributeName="opacity" values="0.9;0" dur="1.3s" repeatCount="2" />
        </circle>
      )}
      <circle r={r} fill={isLight ? '#ffffff' : 'rgba(20,20,36,0.95)'} stroke={color} strokeWidth="2.5" />
      <foreignObject x={-8} y={-8} width={16} height={16} style={{ pointerEvents: 'none' }}>
        <Icon size={16} color={color} />
      </foreignObject>
      <title>{device.name || 'Unnamed device'}</title>
      <text y={r + 14} textAnchor="middle" fontSize="10.5" fontFamily="DM Sans, sans-serif"
        fill="var(--text-secondary)" style={{ pointerEvents: 'none' }}>
        {(() => {
          const name = device.name || 'Unnamed device'
          return name.length > 15 ? name.slice(0, 14) + '…' : name
        })()}
      </text>
    </g>
  )
}

// Shared "rich card" renderer for Core / Site-router / Subnet-switch tiers —
// an HTML card dropped into the SVG via foreignObject, the way enterprise
// dashboards render hub nodes, instead of a plain SVG circle.
function TierCard({ node, w, h, color, roleLabel, Icon, title, subtitle, badge, corner, selected, dimmed, onClick, onHover, onLeave, isLight, glow }) {
  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(node) } : undefined}
      onMouseEnter={(e) => onHover(node, e)}
      onMouseMove={(e) => onHover(node, e)}
      onMouseLeave={onLeave}
      style={{ cursor: onClick ? 'pointer' : 'default', opacity: dimmed ? 0.3 : 1, transition: 'opacity 0.15s ease' }}
    >
      {selected && (
        <rect x={-w / 2 - 5} y={-h / 2 - 5} width={w + 10} height={h + 10} rx={16}
          fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.65" />
      )}
      {glow && (
        <rect x={-w / 2 - 10} y={-h / 2 - 10} width={w + 20} height={h + 20} rx={20} fill={color} opacity="0.08" />
      )}
      <foreignObject x={-w / 2} y={-h / 2} width={w} height={h} style={{ overflow: 'visible' }}>
        <div
          title={subtitle ? `${title} — ${subtitle}` : title}
          style={{
            width: w, height: h, borderRadius: 14,
            background: isLight ? '#ffffff' : 'rgba(22,22,40,0.92)',
            border: `1.5px solid ${color}55`,
            boxShadow: isLight ? '0 1px 3px rgba(15,23,42,0.08)' : '0 4px 14px rgba(0,0,0,0.35)',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            padding: '6px 10px', position: 'relative', fontFamily: 'DM Sans, sans-serif',
          }}
        >
          <span style={{
            position: 'absolute', top: 4, left: 8, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
            color, textTransform: 'uppercase', opacity: 0.85,
          }}>{roleLabel}</span>
          {corner}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <div style={{
              width: 26, height: 26, borderRadius: 8, flexShrink: 0,
              background: `${color}22`, border: `1px solid ${color}66`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icon size={14} color={color} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: 12, fontWeight: 700, color: 'var(--text-primary)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: w - 60,
              }}>{title}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{subtitle}</div>
            </div>
          </div>
          {badge}
        </div>
      </foreignObject>
    </g>
  )
}

function SiteNode({ node, selected, dimmed, onClick, onHover, onLeave, isLight }) {
  const online = node.onlineCount ?? 0
  const total = node.count ?? 0
  const pct = total ? Math.round((online / total) * 100) : 0
  const ChevIcon = node.expanded ? ChevronDown : ChevronRight
  const { Icon: KindIcon, label: kindLabel } = groupKind(node.deviceType)
  return (
    <TierCard
      node={node} w={152} h={66} color={SITE_COLOR} roleLabel={kindLabel} Icon={KindIcon}
      title={node.label} subtitle={node.expanded ? `${online}/${total} online` : `${total} device${total === 1 ? '' : 's'} · tap to expand`}
      selected={selected} dimmed={dimmed} onClick={onClick} onHover={onHover} onLeave={onLeave} isLight={isLight}
      corner={
        <span style={{
          position: 'absolute', top: 3, right: 5, width: 16, height: 16, borderRadius: 5,
          background: 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <ChevIcon size={11} color={SITE_COLOR} />
        </span>
      }
      badge={
        <div style={{ marginTop: 6, height: 3, borderRadius: 2, background: 'var(--bg-surface-3)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: '#22c55e', transition: 'width 0.3s ease' }} />
        </div>
      }
    />
  )
}

function SubnetNode({ node, selected, dimmed, onClick, onHover, onLeave, isLight }) {
  const online = node.onlineCount ?? 0
  const total = node.count ?? 0
  const dots = Math.min(total, 10)
  return (
    <TierCard
      node={node} w={136} h={56} color={SUBNET_COLOR} roleLabel="Subnet Switch" Icon={Waypoints}
      title={node.label} subtitle={`${total} device${total === 1 ? '' : 's'}`}
      selected={selected} dimmed={dimmed} onClick={onClick} onHover={onHover} onLeave={onLeave} isLight={isLight}
      badge={
        <div style={{ display: 'flex', gap: 2.5, marginTop: 5 }}>
          {Array.from({ length: dots }).map((_, i) => (
            <span key={i} style={{
              width: 4, height: 4, borderRadius: 1,
              background: i < online ? '#22c55e' : 'var(--bg-surface-4)',
            }} />
          ))}
          {total > dots && <span style={{ fontSize: 8, color: 'var(--text-faint)', marginLeft: 2 }}>+{total - dots}</span>}
        </div>
      }
    />
  )
}

function CoreNode({ node, orgName, isLight, onHover, onLeave, stats }) {
  return (
    <TierCard
      node={node} w={178} h={76} color={CORE_COLOR} roleLabel="Network Core" Icon={Network}
      title={orgName || 'Organization'} subtitle={`${stats.total} devices · ${stats.sites} sites`}
      onHover={onHover} onLeave={onLeave} isLight={isLight} glow
    />
  )
}

// ── Hover popover — quick-glance info that follows the cursor ──────────────
function HoverCard({ hover }) {
  if (!hover) return null
  const { node, cx, cy, flipX, flipY } = hover
  const style = {
    position: 'absolute',
    left: flipX ? undefined : cx + 16,
    right: flipX ? `calc(100% - ${cx - 16}px)` : undefined,
    top: flipY ? undefined : cy + 16,
    bottom: flipY ? `calc(100% - ${cy - 16}px)` : undefined,
    width: 224, zIndex: 30, pointerEvents: 'none',
  }

  let body = null
  if (node.type === 'device') {
    const d = node.device
    const status = d.status || 'unknown'
    const { label: kindLabel } = deviceKind(d)
    body = (
      <>
        <p className="font-display text-sm truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="w-2 h-2 rounded-full" style={{ background: statusColor(status) }} />
          <span className="text-xs font-body font-medium" style={{ color: statusColor(status) }}>{STATUS_LABEL[status]}</span>
        </div>
        <div className="mt-2 space-y-1 text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
          <div className="flex justify-between"><span>IP</span><span style={{ color: 'var(--text-secondary)' }}>{d.ip_address || '—'}</span></div>
          <div className="flex justify-between"><span>Role</span><span style={{ color: 'var(--text-secondary)' }}>{kindLabel}</span></div>
          <div className="flex justify-between"><span>Last seen</span><span style={{ color: 'var(--text-secondary)' }}>{timeAgo(d.last_seen)}</span></div>
        </div>
        <p className="mt-2 text-[10px] font-body" style={{ color: 'var(--text-faint)' }}>Click for full details</p>
      </>
    )
  } else if (node.type === 'subnet') {
    body = (
      <>
        <p className="font-display text-sm truncate" style={{ color: SUBNET_COLOR }}>{node.label}</p>
        <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>{node.siteLabel}</p>
        <div className="mt-2 flex gap-3 text-[11px] font-body">
          <span style={{ color: 'var(--text-secondary)' }}>{node.count ?? 0} devices</span>
          <span style={{ color: '#22c55e' }}>{node.onlineCount ?? 0} online</span>
        </div>
        <p className="mt-2 text-[10px] font-body" style={{ color: 'var(--text-faint)' }}>Click to inspect subnet</p>
      </>
    )
  } else if (node.type === 'group') {
    const { label: kindLabel } = groupKind(node.deviceType)
    body = (
      <>
        <p className="font-display text-sm truncate" style={{ color: SITE_COLOR }}>{node.label}</p>
        <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>{kindLabel}</p>
        <div className="mt-2 flex gap-3 text-[11px] font-body">
          <span style={{ color: 'var(--text-secondary)' }}>{node.count ?? 0} devices</span>
          <span style={{ color: '#22c55e' }}>{node.onlineCount ?? 0} online</span>
        </div>
        <p className="mt-2 text-[10px] font-body" style={{ color: 'var(--text-faint)' }}>
          Click to {node.expanded ? 'collapse' : 'expand'}
        </p>
      </>
    )
  } else {
    body = (
      <>
        <p className="font-display text-sm truncate" style={{ color: CORE_COLOR }}>{node.label === 'Core' ? 'Network Core' : node.label}</p>
        <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>Organization root</p>
      </>
    )
  }

  return (
    <div style={style}>
      <div className="rounded-xl p-3 glass-sm animate-fade-in" style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.25)' }}>
        {body}
      </div>
    </div>
  )
}

// ── Device detail drawer ────────────────────────────────────────────────────
function DeviceDrawer({ device, onClose, isLight }) {
  const navigate = useNavigate()
  if (!device) return null
  const status = device.status || 'unknown'
  const { Icon, label: kindLabel } = deviceKind(device)
  return (
    <div className="absolute top-0 right-0 h-full w-full sm:w-80 z-20 animate-fade-in"
      style={{
        background: isLight ? '#ffffff' : 'rgba(14,14,26,0.97)',
        borderLeft: '1px solid var(--border-subtle)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
      }}>
      <div className="flex items-start justify-between p-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0 flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
            style={{ background: `${statusColor(status)}1a`, border: `1px solid ${statusColor(status)}55` }}>
            <Icon size={15} color={statusColor(status)} />
          </div>
          <div className="min-w-0">
            <p className="font-display text-base truncate" style={{ color: 'var(--text-primary)' }}>{device.name}</p>
            <p className="text-xs font-body mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
              {device.group_name || 'Ungrouped'} · {kindLabel}
            </p>
          </div>
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
          <div className="flex justify-between"><dt style={{ color: 'var(--text-muted)' }}>Subnet</dt><dd style={{ color: 'var(--text-primary)' }}>{cidr24(device.ip_address) || '—'}</dd></div>
          <div className="flex justify-between"><dt style={{ color: 'var(--text-muted)' }}>MAC address</dt><dd style={{ color: 'var(--text-primary)' }}>{device.mac_address || '—'}</dd></div>
          <div className="flex justify-between"><dt style={{ color: 'var(--text-muted)' }}>OS type</dt><dd style={{ color: 'var(--text-primary)' }} className="capitalize">{device.os_type || '—'}</dd></div>
          <div className="flex justify-between"><dt style={{ color: 'var(--text-muted)' }}>Agent version</dt><dd style={{ color: 'var(--text-primary)' }}>{device.agent_version || '—'}</dd></div>
          <div className="flex justify-between"><dt style={{ color: 'var(--text-muted)' }}>Last seen</dt><dd style={{ color: 'var(--text-primary)' }}>{timeAgo(device.last_seen)}</dd></div>
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

// ── Site (group) detail drawer ──────────────────────────────────────────────
function SiteDrawer({ node, onClose, onIsolate, onToggleExpand, isolated, isLight, navigate }) {
  if (!node) return null
  const offline = (node.count ?? 0) - (node.onlineCount ?? 0)
  const { Icon: KindIcon, label: kindLabel } = groupKind(node.deviceType)
  return (
    <div className="absolute top-0 right-0 h-full w-full sm:w-80 z-20 animate-fade-in"
      style={{
        background: isLight ? '#ffffff' : 'rgba(14,14,26,0.97)',
        borderLeft: '1px solid var(--border-subtle)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
      }}>
      <div className="flex items-start justify-between p-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0 flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
            style={{ background: `${SITE_COLOR}22`, border: `1px solid ${SITE_COLOR}66` }}>
            <KindIcon size={15} color={SITE_COLOR} />
          </div>
          <div className="min-w-0">
            <p className="font-display text-base truncate" style={{ color: 'var(--text-primary)' }}>{node.label}</p>
            <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>{kindLabel} · {node.count} device{node.count === 1 ? '' : 's'}</p>
          </div>
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
        <button className="btn-ghost w-full justify-center" onClick={onToggleExpand}>
          {node.expanded ? <Minimize size={15} /> : <Maximize size={15} />}
          {node.expanded ? 'Collapse this site' : 'Expand this site'}
        </button>
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

// ── Subnet detail drawer — lists the actual devices on that segment ────────
function SubnetDrawer({ node, devices, onClose, onSelectDevice, isLight }) {
  if (!node) return null
  return (
    <div className="absolute top-0 right-0 h-full w-full sm:w-80 z-20 animate-fade-in"
      style={{
        background: isLight ? '#ffffff' : 'rgba(14,14,26,0.97)',
        borderLeft: '1px solid var(--border-subtle)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
      }}>
      <div className="flex items-start justify-between p-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0 flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
            style={{ background: `${SUBNET_COLOR}22`, border: `1px solid ${SUBNET_COLOR}66` }}>
            <Waypoints size={15} color={SUBNET_COLOR} />
          </div>
          <div className="min-w-0">
            <p className="font-display text-base truncate" style={{ color: 'var(--text-primary)' }}>{node.label}</p>
            <p className="text-xs font-body mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{node.siteLabel} · {devices.length} device{devices.length === 1 ? '' : 's'}</p>
          </div>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ color: 'var(--text-muted)' }}>
          <X size={16} />
        </button>
      </div>
      <div className="p-4 space-y-1.5 overflow-y-auto" style={{ maxHeight: 'calc(100% - 82px)' }}>
        {devices.map(dn => {
          const d = dn.device
          const status = d.status || 'unknown'
          const { Icon } = deviceKind(d)
          return (
            <button key={dn.id} onClick={() => onSelectDevice(dn)}
              className="w-full flex items-center gap-2.5 p-2.5 rounded-lg text-left transition-colors"
              style={{ background: 'var(--bg-surface-3)' }}>
              <Icon size={14} color={statusColor(status)} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-body truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</p>
                <p className="text-[11px] font-body truncate" style={{ color: 'var(--text-muted)' }}>{d.ip_address || '—'}</p>
              </div>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor(status) }} />
              <ChevronRight size={13} style={{ color: 'var(--text-faint)' }} className="shrink-0" />
            </button>
          )
        })}
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
  // Read a previously-shared view out of the URL once on load (see
  // shareView() below) so a link can drop a teammate straight into "this
  // site, zoomed in, offline devices only" instead of a blank map.
  const urlInit = useMemo(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      return {
        search: p.get('q') || '',
        status: p.get('status') || 'all',
        iso: p.get('iso') || null,
        exp: p.get('exp') ? new Set(p.get('exp').split(',').filter(Boolean)) : new Set(),
        scale: p.has('scale') ? parseFloat(p.get('scale')) : null,
        x: p.has('x') ? parseFloat(p.get('x')) : null,
        y: p.has('y') ? parseFloat(p.get('y')) : null,
      }
    } catch { return null }
  }, [])
  const [search, setSearch]     = useState(urlInit?.search || '')
  const [statusFilter, setStatusFilter] = useState(urlInit?.status || 'all')
  const [isolatedGroup, setIsolatedGroup] = useState(urlInit?.iso || null)
  const [selectedNode, setSelectedNode] = useState(null)
  const [hover, setHover] = useState(null)
  const [fullscreen, setFullscreen] = useState(false)
  // Sites start collapsed — this is the whole fix for "too much on screen
  // at once": nothing fans out until the person asks for it.
  const [expandedGroups, setExpandedGroups] = useState(() => urlInit?.exp || new Set())
  const [pendingFocusId, setPendingFocusId] = useState(null)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [pulsingIds, setPulsingIds] = useState(() => new Set())
  const prevStatusRef = useRef(new Map())
  const containerRef = useRef(null)
  const searchInputRef = useRef(null)

  // Keyboard shortcuts — Esc backs out (closes a drawer, then exits
  // fullscreen), and "/" jumps into search without reaching for the mouse.
  // Skipped while typing anywhere else so it doesn't hijack other inputs.
  useEffect(() => {
    const onKeyDown = (e) => {
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)
      if (e.key === 'Escape') {
        if (selectedNode) setSelectedNode(null)
        else if (fullscreen) setFullscreen(false)
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedNode, fullscreen])

  // pan/zoom transform
  const [view, setView] = useState({
    scale: urlInit?.scale ?? 1,
    x: urlInit?.x ?? VIEW_W / 2,
    y: urlInit?.y ?? VIEW_H / 2,
  })
  const dragRef = useRef(null)

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true); else setRefreshing(true)
    try {
      const [dRes, gRes] = await Promise.all([api.get('/devices'), api.get('/groups')])
      const nextDevices = dRes.data || []
      // Flag any device whose status just changed since the last poll —
      // DeviceNode renders a brief flash ring for these so a device going
      // offline is noticeable without staring at the map. Skipped on the
      // very first load (nothing to compare against yet).
      if (prevStatusRef.current.size > 0) {
        const changed = nextDevices
          .filter(d => prevStatusRef.current.has(d.id) && prevStatusRef.current.get(d.id) !== d.status)
          .map(d => d.id)
        if (changed.length) {
          setPulsingIds(new Set(changed))
          setTimeout(() => setPulsingIds(new Set()), 2600)
        }
      }
      prevStatusRef.current = new Map(nextDevices.map(d => [d.id, d.status]))
      setDevices(nextDevices)
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

  const deviceMatches = useCallback((d) => {
    if (statusFilter !== 'all' && (d.status || 'unknown') !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (!(d.name || '').toLowerCase().includes(q) && !(d.ip_address || '').toLowerCase().includes(q) &&
          !(d.group_name || '').toLowerCase().includes(q)) return false
    }
    return true
  }, [statusFilter, search])
  const activeFilter = statusFilter !== 'all' || !!search

  // Per-site totals computed from the raw device list (not the tree), so a
  // *collapsed* site still shows an accurate online/total count and search
  // match indicator even though its devices aren't in the node tree yet.
  const groupStatsById = useMemo(() => {
    const m = new Map()
    devices.forEach(d => {
      const gid = d.group_id || '__ungrouped'
      if (!m.has(gid)) m.set(gid, { total: 0, online: 0, matches: false })
      const s = m.get(gid)
      s.total += 1
      if (d.status === 'online') s.online += 1
      if (deviceMatches(d)) s.matches = true
    })
    return m
  }, [devices, deviceMatches])

  const allGroupIds = useMemo(() => [...groupStatsById.keys()], [groupStatsById])

  // A site auto-expands while it's isolated, or while it contains a search
  // / status match — so filtering actually surfaces the matching device
  // instead of leaving it hidden inside a collapsed hub.
  const effectiveExpanded = useMemo(() => {
    const s = new Set(expandedGroups)
    if (isolatedGroup) s.add(isolatedGroup.slice(4))
    if (activeFilter) groupStatsById.forEach((v, gid) => { if (v.matches) s.add(gid) })
    return s
  }, [expandedGroups, isolatedGroup, activeFilter, groupStatsById])

  const { nodes, edges } = useMemo(() => computeLayout(devices, groups, effectiveExpanded), [devices, groups, effectiveExpanded])

  const nodesWithCounts = useMemo(() => {
    const bySubnetDevices = new Map()
    nodes.forEach(n => {
      if (n.type !== 'device') return
      const subId = `sub:${n.groupId}:${n.subnetKey}`
      if (!bySubnetDevices.has(subId)) bySubnetDevices.set(subId, [])
      bySubnetDevices.get(subId).push(n)
    })
    return nodes.map(n => {
      if (n.type === 'subnet') {
        const devs = bySubnetDevices.get(n.id) || []
        const online = devs.filter(d => d.device.status === 'online').length
        return { ...n, count: devs.length, onlineCount: online, hasMatch: devs.some(d => deviceMatches(d.device)) }
      }
      if (n.type === 'group') {
        const gs = groupStatsById.get(n.id.slice(4)) || { total: 0, online: 0, matches: false }
        return { ...n, count: gs.total, onlineCount: gs.online, hasMatch: gs.matches }
      }
      return n
    })
  }, [nodes, deviceMatches, groupStatsById])

  const matchesFilters = useCallback((node) => {
    if (node.type === 'core') return true
    if (isolatedGroup) {
      if (node.type === 'group' && node.id !== isolatedGroup) return false
      if (node.type !== 'group' && node.groupId && `grp:${node.groupId}` !== isolatedGroup) return false
    }
    if (node.type === 'device') return deviceMatches(node.device)
    if (!activeFilter) return true
    return !!node.hasMatch
  }, [isolatedGroup, deviceMatches, activeFilter])

  const nodeById = useMemo(() => {
    const m = new Map()
    nodesWithCounts.forEach(n => m.set(n.id, n))
    return m
  }, [nodesWithCounts])

  // When a device is selected, trace its route back to the core (device →
  // subnet → site → org) so the render pass can dim everything else —
  // makes "how does this thing actually connect" a glance instead of a
  // manual trace across the map.
  const highlightPath = useMemo(() => {
    if (selectedNode?.type !== 'device') return null
    return new Set(['core', `grp:${selectedNode.groupId}`, `sub:${selectedNode.groupId}:${selectedNode.subnetKey}`, selectedNode.id])
  }, [selectedNode])

  const stats = useMemo(() => {
    const total = devices.length
    const online = devices.filter(d => d.status === 'online').length
    const offline = devices.filter(d => d.status === 'offline').length
    const subnets = new Set(devices.map(d => cidr24(d.ip_address) || 'unassigned')).size
    return { total, online, offline, sites: groups.length, subnets }
  }, [devices, groups])

  const toggleExpand = useCallback((groupId) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId)
      return next
    })
  }, [])
  const expandAll = () => setExpandedGroups(new Set(allGroupIds))
  const collapseAll = () => setExpandedGroups(new Set())

  // ── Pan bounds ───────────────────────────────────────────────────────────
  // Content bounds in local layout units — this is what stops the map from
  // being dragged arbitrarily far off into empty space with nothing but the
  // recenter button to find your way back.
  const bounds = useMemo(() => {
    const xs = nodesWithCounts.map(n => n.x), ys = nodesWithCounts.map(n => n.y)
    const pad = 70
    return {
      minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad,
      minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad,
    }
  }, [nodesWithCounts])

  // Keeps a soft margin of real content on-screen at all times. Panning
  // still feels free — there's genuine travel before you hit an edge — it
  // just can't be dragged out into open space with no way back except the
  // recenter button. Falls back to centering when the whole map already
  // fits inside the viewport (so it doesn't fight a zoomed-out view).
  const clampView = useCallback((v) => {
    const margin = 220
    const minX = VIEW_W - bounds.maxX * v.scale - margin
    const maxX = -bounds.minX * v.scale + margin
    const minY = VIEW_H - bounds.maxY * v.scale - margin
    const maxY = -bounds.minY * v.scale + margin
    return {
      scale: v.scale,
      x: minX <= maxX ? Math.min(maxX, Math.max(minX, v.x)) : (minX + maxX) / 2,
      y: minY <= maxY ? Math.min(maxY, Math.max(minY, v.y)) : (minY + maxY) / 2,
    }
  }, [bounds])
  const setViewClamped = useCallback((updater) => {
    setView(v => clampView(typeof updater === 'function' ? updater(v) : updater))
  }, [clampView])

  // ── Pan / zoom handlers ────────────────────────────────────────────────
  const zoomBy = (factor, cx = VIEW_W / 2, cy = VIEW_H / 2) => {
    setViewClamped(v => {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
      const k = nextScale / v.scale
      return { scale: nextScale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })
  }
  const resetView = () => setView({ scale: 1, x: VIEW_W / 2, y: VIEW_H / 2 })

  // A trackpad reports a pinch-zoom gesture as a wheel event with
  // ctrlKey/metaKey set to true (this is a real, if odd, browser
  // convention) — a plain two-finger scroll/swipe fires the same wheel
  // event but WITHOUT that flag. Previously every wheel event was treated
  // as zoom, so a normal two-finger swipe forward/back got misread as
  // "zoom in/out" instead of panning. Now: pinch → zoom, swipe → pan.
  const onWheel = (e) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    if (e.ctrlKey || e.metaKey) {
      const cx = ((e.clientX - rect.left) / rect.width) * VIEW_W
      const cy = ((e.clientY - rect.top) / rect.height) * VIEW_H
      zoomBy(e.deltaY < 0 ? 1.12 : 0.89, cx, cy)
    } else {
      const scaleX = VIEW_W / rect.width, scaleY = VIEW_H / rect.height
      setViewClamped(v => ({ ...v, x: v.x - e.deltaX * scaleX, y: v.y - e.deltaY * scaleY }))
    }
  }
  const onMouseDown = (e) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y }
  }
  const onMouseMove = (e) => {
    if (!dragRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const dx = ((e.clientX - dragRef.current.startX) / rect.width) * VIEW_W
    const dy = ((e.clientY - dragRef.current.startY) / rect.height) * VIEW_H
    setViewClamped(v => ({ ...v, x: dragRef.current.origX + dx, y: dragRef.current.origY + dy }))
  }
  const endDrag = () => { dragRef.current = null }

  // ── Touch: one finger pans, two fingers pinch-zoom ──────────────────────
  // There was previously no touch handling at all, so on any touchscreen
  // the browser's own page-zoom took over a pinch gesture instead of the
  // map — that's the "expands instead of moving" behaviour on touch
  // devices. touchAction: 'none' (set on the canvas div below) hands the
  // gesture to us instead of the browser.
  const touchRef = useRef(null)
  const touchDist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
  const touchMid  = (t0, t1) => ({ x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 })

  const onTouchStart = (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0]
      touchRef.current = { mode: 'pan', startX: t.clientX, startY: t.clientY, origX: view.x, origY: view.y }
    } else if (e.touches.length === 2) {
      const [t0, t1] = e.touches
      touchRef.current = {
        mode: 'pinch',
        startDist: touchDist(t0, t1),
        startMid: touchMid(t0, t1),
        origScale: view.scale, origX: view.x, origY: view.y,
      }
    }
  }
  const onTouchMove = (e) => {
    if (!touchRef.current || !containerRef.current) return
    e.preventDefault()
    const rect = containerRef.current.getBoundingClientRect()
    const scaleX = VIEW_W / rect.width, scaleY = VIEW_H / rect.height
    if (touchRef.current.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0]
      const dx = (t.clientX - touchRef.current.startX) * scaleX
      const dy = (t.clientY - touchRef.current.startY) * scaleY
      setViewClamped(v => ({ ...v, x: touchRef.current.origX + dx, y: touchRef.current.origY + dy }))
    } else if (touchRef.current.mode === 'pinch' && e.touches.length === 2) {
      const [t0, t1] = e.touches
      const dist = touchDist(t0, t1)
      const mid = touchMid(t0, t1)
      const ratio = dist / touchRef.current.startDist
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, touchRef.current.origScale * ratio))
      const k = nextScale / touchRef.current.origScale
      const cx = (touchRef.current.startMid.x - rect.left) * scaleX
      const cy = (touchRef.current.startMid.y - rect.top) * scaleY
      // also let the two-finger midpoint drift (so pinch + shift pans too)
      const dmx = (mid.x - touchRef.current.startMid.x) * scaleX
      const dmy = (mid.y - touchRef.current.startMid.y) * scaleY
      setViewClamped({
        scale: nextScale,
        x: cx - (cx - touchRef.current.origX) * k + dmx,
        y: cy - (cy - touchRef.current.origY) * k + dmy,
      })
    }
  }
  const onTouchEnd = (e) => {
    if (e.touches.length === 0) {
      touchRef.current = null
    } else if (e.touches.length === 1) {
      // pinch → pan hand-off: one finger lifted, keep panning with the other
      const t = e.touches[0]
      touchRef.current = { mode: 'pan', startX: t.clientX, startY: t.clientY, origX: view.x, origY: view.y }
    }
  }

  const handleHover = useCallback((node, e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    setHover({ node, cx, cy, flipX: cx > rect.width - 250, flipY: cy > rect.height - 180 })
  }, [])
  const handleLeaveHover = useCallback(() => setHover(null), [])

  // Selecting a node just opens its drawer and gently recenters the map on
  // it — it used to also force-zoom to at least 110%, which is what made
  // tapping a device feel like the whole map "jumped" or spilled past the
  // canvas edge. Zoom level is the person's choice (pinch / scroll / +−
  // buttons); clicking a node should never change it on their behalf.
  const focusNode = (node) => {
    setSelectedNode(node)
    setHover(null)
    setViewClamped(v => ({
      scale: v.scale,
      x: VIEW_W / 2 - node.x * v.scale,
      y: VIEW_H / 2 - node.y * v.scale,
    }))
  }
  // Clicking a site both toggles its expansion and pans/selects it — one
  // click reveals its subnets & devices, a second click tidies it away.
  const onSiteClick = (node) => {
    toggleExpand(node.id.slice(4))
    focusNode(node)
  }

  // Everything that isn't cleanly online, worst-first — feeds the Alerts
  // panel so triage is a glance-and-click instead of a visual hunt.
  const problemDevices = useMemo(() => {
    const rank = { error: 0, offline: 1, needs_approval: 2, unknown: 2 }
    return devices
      .filter(d => (d.status || 'unknown') !== 'online')
      .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3))
  }, [devices])

  // Jumping to a device from the Alerts panel (or anywhere off-canvas) has
  // to expand its site first if collapsed — the device has no coordinates
  // in the tree until then — so the actual focus happens a tick later,
  // once nodeById has the freshly-expanded node.
  const jumpToDevice = useCallback((d) => {
    const gid = d.group_id || '__ungrouped'
    setExpandedGroups(prev => (prev.has(gid) ? prev : new Set(prev).add(gid)))
    setPendingFocusId(`dev:${d.id}`)
    setAlertsOpen(false)
  }, [])

  useEffect(() => {
    if (!pendingFocusId) return
    const n = nodeById.get(pendingFocusId)
    if (n) { focusNode(n); setPendingFocusId(null) }
  }, [pendingFocusId, nodeById])

  // Typing a search term jumps the map to the first matching device
  // instead of leaving the person to hunt for a highlighted dot across a
  // few hundred nodes — the auto-expand alone only got a matching site
  // open, it never actually brought the match into view.
  useEffect(() => {
    if (!search.trim()) return
    const match = nodesWithCounts.find(n => n.type === 'device' && deviceMatches(n.device))
    if (match) focusNode(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Bundles the current pan/zoom, expanded sites, isolation, filter and
  // search into a link a teammate can open to land in exactly this view —
  // "this site, zoomed in, offline only" — instead of a blank map.
  const shareView = async () => {
    const p = new URLSearchParams()
    if (search) p.set('q', search)
    if (statusFilter !== 'all') p.set('status', statusFilter)
    if (isolatedGroup) p.set('iso', isolatedGroup)
    if (expandedGroups.size) p.set('exp', [...expandedGroups].join(','))
    p.set('scale', view.scale.toFixed(3)); p.set('x', view.x.toFixed(1)); p.set('y', view.y.toFixed(1))
    const url = `${window.location.origin}${window.location.pathname}?${p.toString()}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Link copied — opens to this exact view')
    } catch {
      toast.error('Could not copy link')
    }
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
  const bw = Math.max(1, bounds.maxX - bounds.minX)
  const bh = Math.max(1, bounds.maxY - bounds.minY)
  const mScale = Math.min(mapW / bw, mapH / bh)
  const toMap = (x, y) => [(x - bounds.minX) * mScale, (y - bounds.minY) * mScale]
  const vpX0 = -view.x / view.scale, vpY0 = -view.y / view.scale
  const vpW = VIEW_W / view.scale, vpH = VIEW_H / view.scale
  const [vx0, vy0] = toMap(vpX0, vpY0)
  const vpMapW = vpW * mScale, vpMapH = vpH * mScale

  const orgName = useMemo(() => devices[0]?.org_name || null, [devices])

  // Devices belonging to the currently-selected subnet, for the SubnetDrawer.
  const selectedSubnetDevices = useMemo(() => {
    if (selectedNode?.type !== 'subnet') return []
    return nodesWithCounts.filter(n => n.type === 'device' &&
      n.groupId === selectedNode.groupId && n.subnetKey === selectedNode.label)
  }, [selectedNode, nodesWithCounts])

  // Same page-wrapper pattern every other page in the app uses (Devices,
  // Groups, etc.) — top/side padding so content doesn't run up under the
  // nav bar, a max width, and bottom padding so the page doesn't end flush
  // against the viewport edge. This page was the only one missing it,
  // which is why it looked jammed against the nav bar with no breathing
  // room at the bottom.
  const wrapperClasses = fullscreen
    ? 'fixed inset-0 z-40 p-4 sm:p-6 overflow-auto'
    : 'p-4 sm:p-6 max-w-[1600px] mx-auto animate-fade-in pb-28'

  return (
    <div className={wrapperClasses} style={fullscreen ? { background: 'var(--bg-page)' } : {}}>
      <PageHeader
        icon={Network}
        title="Network Topology"
        description="Organization-centered map — click a site to expand its subnets and devices"
        actions={
          <>
            <button className="btn-ghost" onClick={expandAll}>
              <Maximize size={15} /> Expand all
            </button>
            <button className="btn-ghost" onClick={collapseAll}>
              <Minimize size={15} /> Collapse all
            </button>
            <button className="btn-ghost" onClick={() => load(true)} disabled={refreshing}>
              {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Refresh
            </button>
            <button className="btn-ghost" onClick={shareView}>
              <Link2 size={15} /> Share view
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

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
        <StatCard icon={HardDrive} label="Devices" value={stats.total} iconColor="text-brand-400" iconBg="bg-brand-500/15" />
        <StatCard icon={Wifi} label="Online" value={stats.online} iconColor="text-accent-green" iconBg="bg-accent-green/15" accent="text-accent-green" />
        <StatCard icon={WifiOff} label="Offline" value={stats.offline} iconColor="text-slate-400" iconBg="bg-slate-400/15" />
        <StatCard icon={Router} label="Sites" value={stats.sites} iconColor="text-brand-400" iconBg="bg-brand-500/15" />
        <StatCard icon={Waypoints} label="Subnets" value={stats.subnets} iconColor="text-sky-400" iconBg="bg-sky-400/15" />
      </div>

      {/* Toolbar */}
      <div className="card mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input
            ref={searchInputRef}
            className="input-field pl-9"
            placeholder="Search device, IP, or site… (auto-expands matching sites)"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {!search && (
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 rounded font-body"
              style={{ background: 'var(--bg-surface-3)', color: 'var(--text-faint)' }}>/</kbd>
          )}
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

      {/* Canvas — fills whatever vertical space is left in the viewport
          instead of a fixed 640px box, so large screens don't end up with
          a stretch of dead space under the map (min-height keeps it usable
          on short viewports). */}
      <div
        ref={containerRef}
        className="card relative p-0 overflow-hidden select-none"
        style={{
          height: fullscreen ? 'calc(100vh - 260px)' : 'calc(100vh - 330px)',
          minHeight: 520,
          touchAction: 'none',
        }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
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
              <defs>
                <pattern id="topo-dots" width="24" height="24" patternUnits="userSpaceOnUse">
                  <circle cx="1.5" cy="1.5" r="1.4" fill="var(--border-subtle)" />
                </pattern>
              </defs>
              <rect x="0" y="0" width={VIEW_W} height={VIEW_H} fill="url(#topo-dots)" />

              <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
                {/* edges */}
                {edges.map(e => {
                  const from = nodeById.get(e.from), to = nodeById.get(e.to)
                  if (!from || !to) return null
                  const visible = matchesFilters(from) && matchesFilters(to)
                  const onPath = highlightPath && highlightPath.has(e.from) && highlightPath.has(e.to)
                  const fromH = nodeHalfSize(from.type), toH = nodeHalfSize(to.type)
                  // aim the edge from the near edge of each card toward the other, not center-to-center
                  const dx0 = to.x - from.x, dy0 = to.y - from.y
                  const dist = Math.max(1, Math.hypot(dx0, dy0))
                  const x1 = from.x + (dx0 / dist) * fromH, y1 = from.y + (dy0 / dist) * fromH
                  const x2 = to.x - (dx0 / dist) * toH, y2 = to.y - (dy0 / dist) * toH
                  const d = linkPath(x1, y1, x2, y2)
                  if (e.kind === 'trunk') {
                    const color = e.to.startsWith('sub:') ? SUBNET_COLOR : SITE_COLOR
                    const opacity = highlightPath ? (onPath ? 0.95 : 0.06) : (visible ? 0.55 : 0.08)
                    return (
                      <path key={e.id} d={d} fill="none" stroke={color} strokeWidth={onPath ? 3 : 2}
                        strokeDasharray="7 5" opacity={opacity}>
                        <animate attributeName="stroke-dashoffset" values="24;0" dur="1.4s" repeatCount="indefinite" />
                      </path>
                    )
                  }
                  const color = statusColor(e.status)
                  const opacity = highlightPath ? (onPath ? 0.95 : 0.06) : (visible ? 0.55 : 0.08)
                  return (
                    <path key={e.id} d={d} fill="none" stroke={color} strokeWidth={onPath ? 2.5 : 1.5}
                      strokeDasharray={e.status === 'online' ? '4 3' : 'none'}
                      opacity={opacity} />
                  )
                })}
                {/* nodes */}
                {nodesWithCounts.map(n => {
                  if (n.type === 'core') {
                    return <CoreNode key={n.id} node={n} orgName={orgName} isLight={isLight}
                      onHover={handleHover} onLeave={handleLeaveHover} stats={stats} />
                  }
                  const visible = matchesFilters(n) && (!highlightPath || highlightPath.has(n.id))
                  if (n.type === 'group') {
                    return (
                      <SiteNode key={n.id} node={n} isLight={isLight}
                        selected={selectedNode?.id === n.id}
                        dimmed={!visible}
                        onClick={onSiteClick} onHover={handleHover} onLeave={handleLeaveHover} />
                    )
                  }
                  if (n.type === 'subnet') {
                    return (
                      <SubnetNode key={n.id} node={n} isLight={isLight}
                        selected={selectedNode?.id === n.id}
                        dimmed={!visible}
                        onClick={focusNode} onHover={handleHover} onLeave={handleLeaveHover} />
                    )
                  }
                  return (
                    <DeviceNode key={n.id} node={n} isLight={isLight}
                      selected={selectedNode?.id === n.id}
                      dimmed={!visible}
                      pulsing={pulsingIds.has(n.device.id)}
                      onClick={focusNode} onHover={handleHover} onLeave={handleLeaveHover} />
                  )
                })}
              </g>
            </svg>

            {/* Hover popover */}
            <HoverCard hover={hover} />

            {/* Zoom controls */}
            <div className="absolute bottom-3 left-3 flex flex-col gap-1.5">
              <button onClick={() => zoomBy(1.2)} className="w-8 h-8 rounded-lg flex items-center justify-center glass-sm"
                style={{ color: 'var(--text-secondary)' }}><ZoomIn size={15} /></button>
              <button onClick={() => zoomBy(0.83)} className="w-8 h-8 rounded-lg flex items-center justify-center glass-sm"
                style={{ color: 'var(--text-secondary)' }}><ZoomOut size={15} /></button>
              <button onClick={resetView} className="w-8 h-8 rounded-lg flex items-center justify-center glass-sm"
                style={{ color: 'var(--text-secondary)' }}><LocateFixed size={15} /></button>
            </div>

            {/* Pan/zoom hint — the canvas already pans on scroll/drag and
                zooms on ctrl+scroll, but nothing on screen said so. */}
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg px-2.5 py-1 text-[10px] font-body glass-sm"
              style={{ color: 'var(--text-muted)' }}>
              Scroll or drag to pan · Ctrl/⌘ + scroll to zoom · / to search · Esc to close
            </div>

            {/* Status legend + Alerts panel */}
            <div className="absolute top-3 left-3 flex flex-col items-start gap-2 max-w-[70%]">
              <div className="rounded-xl px-3 py-2 flex items-center gap-3 glass-sm flex-wrap">
                <LegendDot color={STATUS_COLOR.online} label="Online" />
                <LegendDot color={STATUS_COLOR.offline} label="Offline" />
                <LegendDot color={STATUS_COLOR.unknown} label="Unknown" />
                <LegendDot color={STATUS_COLOR.error} label="Error" />
              </div>
              {problemDevices.length > 0 && (
                <AlertsPanel
                  devices={problemDevices}
                  open={alertsOpen}
                  onToggle={() => setAlertsOpen(o => !o)}
                  onJump={jumpToDevice}
                  isLight={isLight}
                />
              )}
            </div>

            {/* Network tier legend */}
            <div className="absolute top-3 right-3 rounded-xl px-3 py-2 flex items-center gap-3 glass-sm flex-wrap max-w-[42%]">
              <LegendRole Icon={Network} color={CORE_COLOR} label="Core" />
              <LegendRole Icon={Router} color={SITE_COLOR} label="Site" />
              <LegendRole Icon={Waypoints} color={SUBNET_COLOR} label="Subnet" />
            </div>

            {/* Minimap — click anywhere on it to jump the main view there,
                the way real NOC dashboards let you navigate a big topology
                without hunting through it node by node. */}
            <div className="absolute bottom-3 right-3 rounded-xl overflow-hidden glass-sm"
              style={{ width: mapW, height: mapH }}>
              <svg width={mapW} height={mapH} style={{ cursor: 'pointer' }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const mx = e.clientX - rect.left, my = e.clientY - rect.top
                  const worldX = mx / mScale + bounds.minX, worldY = my / mScale + bounds.minY
                  setViewClamped(v => ({ scale: v.scale, x: VIEW_W / 2 - worldX * v.scale, y: VIEW_H / 2 - worldY * v.scale }))
                }}>
                {nodesWithCounts.map(n => {
                  const [mx, my] = toMap(n.x, n.y)
                  const r = n.type === 'core' ? 3.5 : n.type === 'group' ? 2.8 : n.type === 'subnet' ? 2.2 : 1.3
                  const fill = n.type === 'device' ? statusColor(n.device.status)
                    : n.type === 'subnet' ? SUBNET_COLOR : n.type === 'group' ? SITE_COLOR : CORE_COLOR
                  return <circle key={n.id} cx={mx} cy={my} r={r} fill={fill} />
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
              <SiteDrawer node={nodeById.get(selectedNode.id) || selectedNode} onClose={() => setSelectedNode(null)} isLight={isLight}
                isolated={isolatedGroup === selectedNode.id}
                onIsolate={(id) => setIsolatedGroup(id)}
                onToggleExpand={() => toggleExpand(selectedNode.id.slice(4))}
                navigate={navigate} />
            )}
            {selectedNode?.type === 'subnet' && (
              <SubnetDrawer node={nodeById.get(selectedNode.id) || selectedNode} devices={selectedSubnetDevices}
                onClose={() => setSelectedNode(null)} isLight={isLight}
                onSelectDevice={(dn) => setSelectedNode(dn)} />
            )}
          </>
        )}
      </div>
    </div>
  )
}