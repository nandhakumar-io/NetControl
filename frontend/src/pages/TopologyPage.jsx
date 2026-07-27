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
  Maximize, Minimize, HelpCircle,
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

// ── Radial layout, with collapsible sites ───────────────────────────────
// core (org) at the center → one hub per group on an outer ring. A group
// only fans out its subnets (and each subnet its devices) when its id is
// present in `expanded` — collapsed sites stay a single compact hub, which
// is what keeps a 300-device map from turning into a wall of icons.
//
// Layout footprints — each tier's on-screen size plus a comfortable
// margin, used below to work out how much room a *ring* of that many
// siblings actually needs, instead of assuming a fixed radius fits any
// count. This is the fix for the "too closely packed" complaint: the
// previous version capped every fan's radius at a small constant no
// matter how many nodes it held, so a subnet with 100+ devices had no
// choice but to overlap them into a solid blob.
const GROUP_GAP  = 190 // 152px card + margin
const SUBNET_GAP = 168 // 136px card + margin
const DEVICE_GAP = 58  // 30px icon + label headroom + margin
const BAND_STEP  = { subnet: 118, device: 66 } // radial distance between successive bands

// Places `count` children in concentric arc "bands" fanned out from
// `originAngle`, opening a new band (one step further from the parent)
// whenever the current band can't fit any more children at the minimum
// safe spacing. This is what a real NOC map does with a large fan-out —
// e.g. NetBox and LibreUI-style topology views ring large sets of leaves
// around their parent in tiers rather than squeezing them into one arc —
// so density stays readable at 5 devices or 500.
function placeRadialBand({ count, originAngle, spreadCap, baseR, minGap, ringStep }) {
  const placements = []
  let placed = 0
  let band = 0
  while (placed < count) {
    const r = baseR + band * ringStep
    const isSingle = count === 1 && band === 0
    const angle = isSingle ? 0 : spreadCap
    // How many siblings fit on this band's arc without crowding, given the
    // chord distance at this radius — i.e. more room further out.
    const capacity = isSingle ? 1 : Math.max(1, Math.floor((angle * r) / minGap) + 1)
    const take = Math.min(capacity, count - placed)
    for (let i = 0; i < take; i++) {
      const a = take <= 1 ? originAngle : originAngle - angle / 2 + (angle * i) / (take - 1)
      placements.push({ x: r * Math.cos(a), y: r * Math.sin(a), angle: a })
      placed++
    }
    band++
  }
  return placements
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
  // Full ring around the core: radius derived from how much circumference
  // n cards actually need, not a constant that only happens to work for a
  // handful of sites.
  const ringR = Math.max(240, (n * GROUP_GAP) / (2 * Math.PI))

  const nodes = [{ id: 'core', type: 'core', x: 0, y: 0, label: 'Core' }]
  const edges = []

  groupMeta.forEach((g, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    const gx = ringR * Math.cos(angle)
    const gy = ringR * Math.sin(angle)
    const devs = byGroup.get(g.id) || []
    const isExpanded = expanded.has(g.id)
    nodes.push({
      id: `grp:${g.id}`, type: 'group', x: gx, y: gy, angle,
      label: g.name, expanded: isExpanded, deviceType: g.deviceType,
    })
    edges.push({ id: `e-core-${g.id}`, from: 'core', to: `grp:${g.id}`, kind: 'trunk' })

    if (!isExpanded || devs.length === 0) return

    const bySubnet = new Map()
    devs.forEach(d => {
      const key = cidr24(d.ip_address) || 'Unassigned'
      if (!bySubnet.has(key)) bySubnet.set(key, [])
      bySubnet.get(key).push(d)
    })
    const subnetKeys = [...bySubnet.keys()].sort((a, b) =>
      a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b))

    // Subnets fan outward from the site, away from the core, rather than
    // wrapping a full circle (a site's children belong "beyond" it on the
    // map, not looping back toward the org center).
    const subnetSpots = placeRadialBand({
      count: subnetKeys.length, originAngle: angle,
      spreadCap: Math.min(Math.PI * 1.6, 0.7 + subnetKeys.length * 0.12),
      baseR: 130, minGap: SUBNET_GAP, ringStep: BAND_STEP.subnet,
    })

    subnetKeys.forEach((key, si) => {
      const spot = subnetSpots[si]
      const sx = gx + spot.x, sy = gy + spot.y
      const sdevs = bySubnet.get(key)
      const subnetId = `sub:${g.id}:${key}`
      nodes.push({
        id: subnetId, type: 'subnet', x: sx, y: sy,
        label: key, groupId: g.id, siteLabel: g.name,
      })
      edges.push({ id: `e-grp-${subnetId}`, from: `grp:${g.id}`, to: subnetId, kind: 'trunk' })

      const deviceSpots = placeRadialBand({
        count: sdevs.length, originAngle: spot.angle,
        spreadCap: Math.min(Math.PI * 1.7, 0.6 + sdevs.length * 0.1),
        baseR: 72, minGap: DEVICE_GAP, ringStep: BAND_STEP.device,
      })
      sdevs.forEach((d, di) => {
        const dSpot = deviceSpots[di]
        const dx = sx + dSpot.x, dy = sy + dSpot.y
        nodes.push({
          id: `dev:${d.id}`, type: 'device', x: dx, y: dy,
          device: d, groupId: g.id, subnetKey: key,
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

// ── Node components ──────────────────────────────────────────────────────

function DeviceNode({ node, selected, dimmed, onClick, onHover, onLeave, isLight }) {
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
      <circle r={r} fill={isLight ? '#ffffff' : 'rgba(20,20,36,0.95)'} stroke={color} strokeWidth="2.5" />
      <foreignObject x={-8} y={-8} width={16} height={16} style={{ pointerEvents: 'none' }}>
        <Icon size={16} color={color} />
      </foreignObject>
      <text y={r + 14} textAnchor="middle" fontSize="10.5" fontFamily="DM Sans, sans-serif"
        fill="var(--text-secondary)" style={{ pointerEvents: 'none' }}>
        {device.name.length > 15 ? device.name.slice(0, 14) + '…' : device.name}
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
  const [search, setSearch]     = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [isolatedGroup, setIsolatedGroup] = useState(null)
  const [selectedNode, setSelectedNode] = useState(null)
  const [hover, setHover] = useState(null)
  const [fullscreen, setFullscreen] = useState(false)
  // Sites start collapsed — this is the whole fix for "too much on screen
  // at once": nothing fans out until the person asks for it.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())
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

  const deviceMatches = useCallback((d) => {
    if (statusFilter !== 'all' && (d.status || 'unknown') !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (!d.name.toLowerCase().includes(q) && !(d.ip_address || '').toLowerCase().includes(q) &&
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

  // ── Pan / zoom handlers ────────────────────────────────────────────────
  const zoomBy = (factor, cx = VIEW_W / 2, cy = VIEW_H / 2) => {
    setView(v => {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
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

  const handleHover = useCallback((node, e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    setHover({ node, cx, cy, flipX: cx > rect.width - 250, flipY: cy > rect.height - 180 })
  }, [])
  const handleLeaveHover = useCallback(() => setHover(null), [])

  const focusNode = (node) => {
    setSelectedNode(node)
    setHover(null)
    setView(v => ({
      scale: Math.max(v.scale, 1.1),
      x: VIEW_W / 2 - node.x * Math.max(v.scale, 1.1),
      y: VIEW_H / 2 - node.y * Math.max(v.scale, 1.1),
    }))
  }
  // Clicking a site both toggles its expansion and pans/selects it — one
  // click reveals its subnets & devices, a second click tidies it away.
  const onSiteClick = (node) => {
    toggleExpand(node.id.slice(4))
    focusNode(node)
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
    const pad = 70
    return {
      minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad,
      minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad,
    }
  }, [nodesWithCounts])
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

  const wrapperClasses = fullscreen
    ? 'fixed inset-0 z-40 p-4 sm:p-6 overflow-auto'
    : ''

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
            className="input-field pl-9"
            placeholder="Search device, IP, or site… (auto-expands matching sites)"
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
        style={{ height: fullscreen ? 'calc(100vh - 260px)' : '640px' }}
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
                  const fromH = nodeHalfSize(from.type), toH = nodeHalfSize(to.type)
                  // aim the edge from the near edge of each card toward the other, not center-to-center
                  const dx0 = to.x - from.x, dy0 = to.y - from.y
                  const dist = Math.max(1, Math.hypot(dx0, dy0))
                  const x1 = from.x + (dx0 / dist) * fromH, y1 = from.y + (dy0 / dist) * fromH
                  const x2 = to.x - (dx0 / dist) * toH, y2 = to.y - (dy0 / dist) * toH
                  const d = linkPath(x1, y1, x2, y2)
                  if (e.kind === 'trunk') {
                    const color = e.to.startsWith('sub:') ? SUBNET_COLOR : SITE_COLOR
                    return (
                      <path key={e.id} d={d} fill="none" stroke={color} strokeWidth="2"
                        strokeDasharray="7 5" opacity={visible ? 0.55 : 0.08}>
                        <animate attributeName="stroke-dashoffset" values="24;0" dur="1.4s" repeatCount="indefinite" />
                      </path>
                    )
                  }
                  const color = statusColor(e.status)
                  return (
                    <path key={e.id} d={d} fill="none" stroke={color} strokeWidth="1.5"
                      strokeDasharray={e.status === 'online' ? '4 3' : 'none'}
                      opacity={visible ? 0.55 : 0.08} />
                  )
                })}
                {/* nodes */}
                {nodesWithCounts.map(n => {
                  if (n.type === 'core') {
                    return <CoreNode key={n.id} node={n} orgName={orgName} isLight={isLight}
                      onHover={handleHover} onLeave={handleLeaveHover} stats={stats} />
                  }
                  const visible = matchesFilters(n)
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

            {/* Status legend */}
            <div className="absolute top-3 left-3 rounded-xl px-3 py-2 flex items-center gap-3 glass-sm flex-wrap max-w-[55%]">
              <LegendDot color={STATUS_COLOR.online} label="Online" />
              <LegendDot color={STATUS_COLOR.offline} label="Offline" />
              <LegendDot color={STATUS_COLOR.unknown} label="Unknown" />
              <LegendDot color={STATUS_COLOR.error} label="Error" />
            </div>

            {/* Network tier legend */}
            <div className="absolute top-3 right-3 rounded-xl px-3 py-2 flex items-center gap-3 glass-sm flex-wrap max-w-[42%]">
              <LegendRole Icon={Network} color={CORE_COLOR} label="Core" />
              <LegendRole Icon={Router} color={SITE_COLOR} label="Site" />
              <LegendRole Icon={Waypoints} color={SUBNET_COLOR} label="Subnet" />
            </div>

            {/* Minimap */}
            <div className="absolute bottom-3 right-3 rounded-xl overflow-hidden glass-sm"
              style={{ width: mapW, height: mapH }}>
              <svg width={mapW} height={mapH}>
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