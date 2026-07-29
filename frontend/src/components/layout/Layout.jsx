import React, { useState, useEffect, useRef } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Monitor, Layers, Clock, ScrollText, Activity,
  LogOut, ChevronLeft, ChevronRight, Zap, Shield, Sun, Moon, Rows2, Rows3,
  Users, FolderOpen, Share2, Bell, X, AlertTriangle, ShieldAlert, Radar, ShieldCheck, Waypoints,
  ShieldBan, Archive, FileBarChart2, Wrench, Building2, Menu,
  ChevronRight as ArrowIcon, TrendingUp, TerminalSquare, Loader2, Search,
  PackageCheck, CalendarClock, CalendarDays, BellRing, ChevronDown,
  HardDrive, Gauge, Workflow, ClipboardCheck, Settings2, Network, ListChecks,
} from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'
import { useDensityStore } from '../../store/densityStore'
import { usePermissions } from '../../hooks/usePermissions'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import TwoFactorModal from '../modals/TwoFactorModal'
import SessionsModal from '../modals/SessionsModal'
import NotificationPrefsModal from '../modals/NotificationPrefsModal'
import OrgSwitcher from './OrgSwitcher'
import CommandPalette from './CommandPalette'
import ErrorBoundary from '../ErrorBoundary'

const SECTION_ICONS = {
  Devices:     HardDrive,
  Monitoring:  Gauge,
  Automation:  Workflow,
  Compliance:  ClipboardCheck,
  Admin:       Settings2,
}

// ── Notification bell — SSE listener only, no nav ─────────────────────────────
// This component handles LIVE notifications (toasts + badge count).
// The actual Alerts page is navigated to via the NavItem below.
function NotificationBell({ collapsed, isLight, variant = 'sidebar' }) {
  const [notifs, setNotifs] = useState([])
  const [open, setOpen]     = useState(false)
  const token    = localStorage.getItem('nc_token')
  const panelRef = useRef(null)
  const navigate = useNavigate()

  // Stream resilience state — mirrors BulkCommandPage's attachStream pattern.
  // Before this, a dropped connection here left the bell just silently
  // stale with no indication anything was wrong (unlike the bulk-command
  // console, which already surfaces "reconnecting…" / "stalled").
  const [streamState, setStreamState] = useState('connected') // 'connected' | 'reconnecting' | 'stalled'
  const esRef = useRef(null)
  const errorCountRef = useRef(0)
  const lastMessageRef = useRef(Date.now())

  // Load persisted notifications on mount
  useEffect(() => {
    api.get('/alerts/notifications').then(r => setNotifs(r.data || [])).catch(() => {})
  }, [])

  // SSE — live notification stream (toast popups only)
  const attachStream = () => {
    if (!token) return
    esRef.current?.close()
    errorCountRef.current = 0
    lastMessageRef.current = Date.now()
    setStreamState('connected')
    const es = new EventSource(
      `${api.defaults.baseURL}/alerts/stream?token=${encodeURIComponent(token)}`
    )
    esRef.current = es
    es.onopen = () => { errorCountRef.current = 0; setStreamState('connected') }
    // Server sends a named `ping` event every 20s to keep the connection
    // alive during quiet stretches — without listening for it, the 45s
    // watchdog below had no way to tell "no alerts right now" apart from
    // "connection silently died," so it flagged every idle period as
    // stalled. Same fix as BulkCommandPage's attachStream().
    es.addEventListener('ping', () => {
      errorCountRef.current = 0
      lastMessageRef.current = Date.now()
      setStreamState('connected')
    })
    es.onmessage = (e) => {
      errorCountRef.current = 0
      lastMessageRef.current = Date.now()
      setStreamState('connected')
      try {
        const n = JSON.parse(e.data)
        if (!n.type) return
        setNotifs(prev => [n, ...prev].slice(0, 50))
        // BUG FIX: the backend's notification payload (both the live SSE
        // push and GET /alerts/notifications) uses the field `message`,
        // never `details` — this was reading a field that never existed,
        // so every toast read "...: undefined on <device>" instead of the
        // actual alert text.
        if (n.severity === 'critical') {
          toast.error(`🚨 ${n.rule_name}: ${n.message} on ${n.device_name}`, { duration: 8000 })
        } else {
          toast(`⚠ ${n.rule_name} on ${n.device_name}`, { duration: 5000 })
        }
      } catch {}
    }
    // EventSource auto-retries on its own, so a single blip isn't worth
    // surfacing — but if it keeps failing, tell the person instead of
    // leaving the bell silently stuck.
    es.onerror = () => {
      errorCountRef.current += 1
      if (errorCountRef.current >= 3) setStreamState('reconnecting')
      if (errorCountRef.current >= 8) { setStreamState('stalled'); es.close() }
    }
  }

  useEffect(() => {
    attachStream()
    return () => esRef.current?.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // Watchdog: the bell has no "in-progress run" to gate on like bulk-command
  // does, so just check continuously — if not even a keep-alive ping has
  // arrived in 45s, the connection is silently dead (e.g. a proxy dropped it
  // without ever firing onerror).
  useEffect(() => {
    const t = setInterval(() => {
      if (Date.now() - lastMessageRef.current > 45000) setStreamState('stalled')
    }, 5000)
    return () => clearInterval(t)
  }, [])

  const reconnectStream = () => attachStream()

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const h = (e) => { if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const unread = notifs.filter(n => !n.read_at).length
  const clearAll = async () => {
    await api.delete('/alerts/notifications').catch(() => {})
    setNotifs([])
    setOpen(false)
  }
  // Mark a single notification read, in-place — the all-or-nothing "Clear
  // all" above is still there for wiping the whole list, but most nav-bell
  // UIs let you dismiss just the one you clicked without nuking the rest.
  const markRead = async (n) => {
    if (n.read_at) return
    setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read_at: Date.now() } : x))
    await api.patch(`/alerts/notifications/${n.id}/read`).catch(() => {})
  }
  // Click-through to the device the notification is about — same pattern as
  // Capacity Forecast's "Run command" deep link into Bulk Command
  // (?deviceId=...), just landing on Monitoring instead so you see live
  // status/metrics for the device that triggered the alert.
  const goToDevice = (n) => {
    markRead(n)
    setOpen(false)
    if (n.device_id) navigate(`/monitoring?deviceId=${n.device_id}`)
  }
  const sevColor = (sev) => sev === 'critical' ? '#f87171' : '#facc15'

  // Group repeats of the same rule+device within a short window — a flapping
  // device can otherwise fill all 50 slots with near-identical entries
  // ("CPU high on web-01" six times in a row), which buries everything else
  // and makes the dropdown useless during an actual incident. Adjacent-only
  // grouping (not a global bucket by key) keeps chronological order intact:
  // an unrelated alert in between still breaks the streak into two groups.
  const GROUP_WINDOW_MS = 10 * 60 * 1000
  const groups = React.useMemo(() => {
    const out = []
    for (const n of notifs) {
      const key = `${n.rule_name || ''}|${n.device_id || ''}`
      const last = out[out.length - 1]
      const ts = n.triggered_at || n.ts || 0
      const lastTs = last?.latest.triggered_at || last?.latest.ts || 0
      if (last && last.key === key && Math.abs(lastTs - ts) <= GROUP_WINDOW_MS) {
        last.items.push(n)
        // notifs is newest-first, so the first item seen for a key is
        // already the latest — no need to compare/replace `latest`.
      } else {
        out.push({ key, latest: n, items: [n] })
      }
    }
    return out
  }, [notifs])

  const markGroupRead = (group) => { group.items.forEach(markRead) }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell badge button — opens notification dropdown */}
      {variant === 'topbar' ? (
        <button onClick={() => setOpen(o => !o)} title="Notifications"
          className={`relative w-9 h-9 rounded-lg flex items-center justify-center shrink-0
            ${isLight ? 'text-slate-500 hover:bg-black/[0.04]' : 'text-slate-400 hover:bg-white/[0.06]'}`}>
          <Bell size={18} />
          {unread > 0 && (
            <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-accent-red text-white text-[9px] flex items-center justify-center font-bold">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      ) : (
      <button
        onClick={() => setOpen(o => !o)}
        title="Notifications"
        className={`relative flex items-center gap-3 px-3 py-2.5 w-full rounded-lg transition-all duration-150
          ${isLight ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'}`}
      >
        <div className="relative shrink-0">
          {isLight && unread > 0
            ? <div className="w-6 h-6 rounded-md bg-[#6c5ce7] flex items-center justify-center">
                <Bell size={13} className="text-white" />
              </div>
            : <Bell size={16} />
          }
          {unread > 0 && (
            <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-accent-red text-white text-[9px] flex items-center justify-center font-bold">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </div>
        {!collapsed && <span className="text-sm font-body font-medium whitespace-nowrap">Notifications</span>}
        {!collapsed && unread > 0 && (
          <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-accent-red/15 text-accent-red">
            {unread}
          </span>
        )}
      </button>
      )}

      {/* Notification dropdown */}
      {open && (
        <div
          className="fixed z-[200] w-[calc(100vw-2rem)] max-w-80 rounded-2xl overflow-hidden shadow-2xl animate-slide-up"
          style={variant === 'topbar'
            ? { right: '12px', top: '60px', background: isLight ? '#fff' : '#0f0f1a',
                border: isLight ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(255,255,255,0.08)' }
            : { left: collapsed ? '68px' : '228px', bottom: '80px',
                background: isLight ? '#fff' : '#0f0f1a',
                border: isLight ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: `1px solid ${isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'}` }}>
            <span className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>
              Notifications {unread > 0 && <span className="text-accent-red">({unread})</span>}
            </span>
            <div className="flex gap-1">
              {notifs.length > 0 && (
                <button onClick={clearAll} className="text-[11px] font-body px-2 py-1 rounded-lg hover:bg-accent-red/10 text-accent-red transition-colors">
                  Clear all
                </button>
              )}
              <button onClick={() => setOpen(false)} className="p-1 rounded-lg hover:bg-black/5" style={{ color: 'var(--text-muted)' }}>
                <X size={14} />
              </button>
            </div>
          </div>
          {streamState !== 'connected' && (
            <div className="flex items-center justify-between gap-2 px-4 py-2"
              style={{
                background: streamState === 'stalled' ? 'rgba(248,113,113,0.08)' : 'rgba(251,191,36,0.08)',
                borderBottom: `1px solid ${isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'}`,
              }}>
              <span className="text-[11px] font-body flex items-center gap-1.5" style={{ color: streamState === 'stalled' ? '#fca5a5' : '#fbbf24' }}>
                <Loader2 size={11} className={streamState === 'reconnecting' ? 'animate-spin' : ''} />
                {streamState === 'stalled' ? 'Live updates stopped' : 'Reconnecting…'}
              </span>
              {streamState === 'stalled' && (
                <button onClick={reconnectStream} className="text-[11px] font-body px-2 py-0.5 rounded-lg hover:bg-black/5" style={{ color: 'var(--text-muted)' }}>
                  Reconnect
                </button>
              )}
            </div>
          )}
          <div className="max-h-72 overflow-y-auto">
            {notifs.length === 0 ? (
              <div className="py-8 flex flex-col items-center gap-2 opacity-50">
                <Bell size={20} style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>No notifications</p>
              </div>
            ) : groups.map((g, i) => {
              const n = g.latest
              const count = g.items.length
              const groupUnread = g.items.some(x => !x.read_at)
              return (
                <div key={n.id || i}
                  onClick={() => markGroupRead(g)}
                  className="px-4 py-3 flex items-start gap-3 cursor-pointer transition-colors"
                  style={{
                    borderBottom: `1px solid ${isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)'}`,
                    opacity: groupUnread ? 1 : 0.5,
                    background: 'transparent',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = isLight ? 'rgba(0,0,0,0.025)' : 'rgba(255,255,255,0.025)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <AlertTriangle size={14} style={{ color: sevColor(n.severity), marginTop: 2, flexShrink: 0 }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-body font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {n.rule_name || n.message?.split(':')[0] || 'Alert'}
                      </p>
                      {count > 1 && (
                        <span className="shrink-0 text-[10px] font-bold px-1.5 rounded-full"
                          style={{ background: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)', color: 'var(--text-muted)' }}>
                          ×{count}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] font-body mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                      {n.details || n.message}
                    </p>
                    {n.device_name && (
                      n.device_id ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); goToDevice(n) }}
                          className="text-[10px] font-mono mt-0.5 hover:underline"
                          style={{ color: 'var(--text-faint)' }}
                          title="View this device in Monitoring"
                        >
                          {n.device_name}
                        </button>
                      ) : (
                        <p className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-faint)' }}>
                          {n.device_name}
                        </p>
                      )
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Layout ─────────────────────────────────────────────────────────────────────
export default function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  // Mobile off-canvas nav drawer — the sidebar below is always full-width
  // and fixed-position under the md breakpoint (see the <aside> className),
  // hidden by default and toggled by the hamburger button in the mobile
  // top bar. `collapsed` (the icon-rail mode) is a desktop-only concept and
  // is ignored on mobile — a collapsed icon rail doesn't make sense for an
  // off-canvas drawer that's either fully open or fully closed.
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()
  useEffect(() => { setMobileOpen(false) }, [location.pathname])
  // BUG FIX: TwoFactorModal (setup/disable/backup codes — routes/users.js's
  // /me/2fa/* endpoints) was fully built but never mounted or given a
  // trigger anywhere in the app — there's no Settings/Profile page, so it
  // had no home. This was the only reason 2FA was invisible even though
  // the whole backend flow already worked end to end.
  const [show2FA, setShow2FA] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  // Per-user in-app/push notification preferences (severity thresholds +
  // temporary mute) — same "backend existed, needed a home" situation as
  // TwoFactorModal above. See routes/notificationPrefs.js.
  const [showNotifPrefs, setShowNotifPrefs] = useState(false)
  // Command palette (Cmd+K / Ctrl+K) — a single fast "jump to" search across
  // devices/groups/runbooks/schedules/users instead of navigating through
  // the sidebar to find one specific thing. See CommandPalette.jsx and the
  // backend's GET /api/search.
  const [showPalette, setShowPalette] = useState(false)
  useEffect(() => {
    const onKeyDown = (e) => {
      const isMeta = e.metaKey || e.ctrlKey
      if (isMeta && e.key.toLowerCase() === 'k') {
        // Don't hijack Cmd/Ctrl+K while it's already open (let Escape inside
        // the palette handle closing) or while focus is in a contentEditable
        // area that might have its own use for the shortcut.
        e.preventDefault()
        setShowPalette(v => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  const logout   = useAuthStore(s => s.logout)
  const user     = useAuthStore(s => s.user)
  const navigate = useNavigate()

  const { theme, toggleTheme, applyTheme } = useThemeStore()
  const { density, toggleDensity } = useDensityStore()
  const isCompact = density === 'compact'
  const isLight = theme === 'light'
  const { isAdmin, can } = usePermissions()

  useEffect(() => { applyTheme(theme) }, [])

  // ── Collapsible nav sections ────────────────────────────────────────────
  // Each labeled group (Devices, Monitoring, Automation, …) starts collapsed
  // and expands on click — this is what actually shrinks the sidebar's
  // resting height instead of always showing every item in every group.
  // Whichever section contains the currently-active route is auto-expanded
  // on load / on navigation, so you're never looking at a collapsed group
  // hiding the page you're already on.
  const [expandedSections, setExpandedSections] = useState({})
  const toggleSection = (label) => setExpandedSections(s => ({ ...s, [label]: !s[label] }))

  const handleLogout = async () => {
    await logout()
    toast.success('Logged out')
    navigate('/login')
  }

  // ── Nav items — grouped into logical sections instead of one long flat list ──
  const NAV_SECTIONS = [
    {
      label: null, // ungrouped, always-visible top item
      items: [
        { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', show: true },
        { to: '/organizations', icon: Building2, label: 'Organizations', show: true },
      ],
    },
    {
      label: 'Devices',
      items: [
        { to: '/devices',       icon: Monitor,   label: 'Devices',       show: can(1) },
        { to: '/topology',      icon: Network,   label: 'Topology',      show: can(1) },
        { to: '/groups',        icon: Layers,    label: 'Labs & Groups', show: can(8) },
        { to: '/remote-access', icon: Share2,    label: 'Remote Access', show: can(1) },
        { to: '/file-push',     icon: FolderOpen,label: 'File Push',     show: can(1) },
        { to: '/bulk-command',  icon: TerminalSquare, label: 'Bulk Command', show: can(4) },
      ],
    },
    {
      label: 'Monitoring',
      items: [
        { to: '/monitoring', icon: Activity, label: 'Monitoring', show: can(1) },
        { to: '/alerts',     icon: Bell,     label: 'Alerts',     show: can(1) },
        { to: '/discovery',  icon: Radar,    label: 'Discovery',  show: can(1024) },
        { to: '/synthetic-checks', icon: Waypoints, label: 'Health Checks', show: can(65536) },
        { to: '/capacity',   icon: TrendingUp, label: 'Capacity Forecast', show: can(1) },
      ],
    },
    {
      label: 'Automation',
      items: [
        { to: '/schedules',        icon: Clock,     label: 'Schedules',     show: can(32) },
        { to: '/bulk-command-schedules', icon: CalendarClock, label: 'Command Schedules', show: can(4) },
        { to: '/ops-calendar',     icon: CalendarDays, label: 'Ops Calendar', show: can(1) },
        { to: '/process-policies', icon: ShieldBan, label: 'Process Rules', show: can(4096) },
        { to: '/runbooks',         icon: Wrench,    label: 'Runbooks',      show: can(1) },
        { to: '/backups',          icon: Archive,   label: 'Backups',       show: can(8192) },
      ],
    },
    {
      label: 'Compliance',
      items: [
        { to: '/compliance', icon: ShieldCheck, label: 'Compliance', show: can(2048) },
        { to: '/sla-reports', icon: FileBarChart2, label: 'SLA Reports', show: can(16384) },
        { to: '/audit',      icon: ScrollText,  label: 'Audit Log',  show: can(128) },
        { to: '/jobs',       icon: ListChecks,  label: 'Jobs',       show: can(128) },
      ],
    },
  ]
    .map(section => ({ ...section, items: section.items.filter(n => n.show) }))
    .filter(section => section.items.length > 0)

  const ADMIN_NAV = [
    { to: '/users',         icon: Users,        label: 'Users',         show: isAdmin },
    { to: '/security',      icon: ShieldAlert,  label: 'Security',      show: isAdmin },
    { to: '/agent-release', icon: PackageCheck, label: 'Agent Release', show: isAdmin },
  ].filter(n => n.show)

  // Auto-expand whichever section owns the current route. Runs on every
  // navigation (not just mount) so clicking a link inside a collapsed
  // section — or landing on a deep link/refresh — always reveals it.
  useEffect(() => {
    const owner = NAV_SECTIONS.find(s => s.label && s.items.some(i => location.pathname.startsWith(i.to)))
    if (owner) setExpandedSections(s => ({ ...s, [owner.label]: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  const NavItem = ({ to, icon: Icon, label }) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `group relative flex items-center gap-3 rounded-xl transition-all duration-200
         ${collapsed ? 'justify-center p-2' : 'px-2.5 py-2.5'}
         ${isActive
           ? isLight
             ? 'bg-white border border-[#6c5ce7]/25 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_14px_rgba(108,92,231,0.12)]'
             : 'bg-brand-500/10 border border-brand-500/25 shadow-[0_0_18px_rgba(124,92,245,0.10)]'
           : isLight
             ? 'border border-transparent hover:bg-white hover:border-black/[0.06] hover:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_12px_rgba(15,23,42,0.05)]'
             : 'border border-transparent hover:bg-surface-3 hover:border-white/[0.06]'
         }`
      }
      title={collapsed ? label : undefined}
    >
      {({ isActive }) => (
        <>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all duration-200
            ${isActive
              ? isLight ? 'bg-[#6c5ce7] shadow-[0_2px_8px_rgba(108,92,231,0.35)]' : 'bg-brand-500/20 border border-brand-500/30'
              : isLight ? 'bg-[#f2f1fb] group-hover:bg-[#eae7fb]' : 'bg-white/[0.04] group-hover:bg-white/[0.07]'
            }`}>
            <Icon size={15}
              className={isActive ? (isLight ? 'text-white' : 'text-brand-400') : (isLight ? 'text-[#6c5ce7]/70' : 'text-slate-400')}
            />
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1 text-left">
              <p className={`text-[15px] font-body font-semibold leading-tight truncate
                ${isActive ? (isLight ? 'text-[#1a1a2e]' : 'text-slate-100') : (isLight ? 'text-slate-600' : 'text-slate-400')}`}>
                {label}
              </p>
              <p className={`text-[12px] font-body leading-tight mt-0.5 truncate
                ${isLight ? 'text-slate-400' : 'text-slate-600'}`}>
                Click to access
              </p>
            </div>
          )}
          {!collapsed && (
            <ArrowIcon size={13}
              className={`shrink-0 transition-all duration-200
                ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 -translate-x-1 group-hover:translate-x-0'}
                ${isLight ? 'text-[#6c5ce7]' : 'text-brand-400'}`}
            />
          )}
        </>
      )}
    </NavLink>
  )

  return (
    <div className={`relative flex h-screen overflow-hidden transition-colors duration-200 ${isLight ? 'bg-[#eef0f5]' : 'grid-bg bg-surface-0'}`}>

      {/* Mobile drawer backdrop — tapping it closes the nav, same as tapping
          outside any other overlay in this app */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`flex flex-col shrink-0 h-screen max-h-screen overflow-hidden transition-transform md:transition-[width] duration-300 ease-in-out
          fixed inset-y-0 left-0 z-40 md:relative md:z-auto
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:transform-none
          ${isLight ? 'bg-white border-r border-black/[0.06]' : 'bg-surface-1 border-r border-white/6'}
          w-[240px] ${collapsed ? 'md:w-[60px]' : 'md:w-[220px]'}`}
        style={isLight ? { boxShadow: '2px 0 12px rgba(0,0,0,0.05)' } : {}}
      >
        {/* Logo */}
        <div className={`flex items-center gap-3 px-4 py-5 border-b ${isLight ? 'border-black/[0.06]' : 'border-white/6'}`}>
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0
            ${isLight ? 'bg-[#6c5ce7] text-white' : 'bg-brand-500/20 border border-brand-500/30 text-brand-400 animate-glow'}`}>
            <Zap size={16} />
          </div>
          {!collapsed && (
            <span className={`font-display text-sm tracking-wide whitespace-nowrap ${isLight ? 'text-[#1a1a2e]' : 'text-white'}`}>
              NetControl
            </span>
          )}
        </div>

        {/* Main Nav */}
        <nav className={`flex-1 py-4 px-2 flex flex-col gap-1.5 overflow-y-auto sidebar-nav-fade
          ${collapsed ? 'sidebar-nav-collapsed items-center' : 'sidebar-nav-expanded'}`}>
          {NAV_SECTIONS.map((section, idx) => {
            // The ungrouped top section (label: null, Dashboard/Organizations)
            // is always fully visible — only labeled groups collapse.
            if (!section.label) {
              return (
                <div key={`section-${idx}`} className="flex flex-col gap-1.5">
                  {section.items.map(item => <NavItem key={item.to} {...item} />)}
                </div>
              )
            }
            const isOpen = collapsed || !!expandedSections[section.label]
            // A section is "active" (highlighted header, even while collapsed)
            // if the current route lives inside it — so you can always tell
            // where you are without needing the group expanded.
            const isActiveSection = section.items.some(i => location.pathname.startsWith(i.to))
            const SectionIcon = SECTION_ICONS[section.label]
            return (
              <div key={section.label}>
                {collapsed ? (
                  <div className="flex flex-col items-center">
                    {idx > 0 && <div className="mb-2 mx-3 h-px w-6" style={{ background: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)' }} />}
                    {SectionIcon && (
                      <div title={section.label}
                        className="w-6 h-6 mb-2 rounded-md flex items-center justify-center shrink-0"
                        style={{ color: isActiveSection ? (isLight ? '#6c5ce7' : '#a78bfa') : 'var(--text-secondary)' }}>
                        <SectionIcon size={13} />
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => toggleSection(section.label)}
                    className={`mt-3 mb-1 px-3 py-1.5 w-full flex items-center justify-between rounded-lg transition-colors duration-150
                      ${isLight ? 'hover:bg-black/[0.03]' : 'hover:bg-white/[0.04]'}`}
                  >
                    <span className="flex items-center gap-1.5 text-[11px] font-body font-bold uppercase tracking-[0.12em]"
                      style={{ color: isActiveSection ? (isLight ? '#6c5ce7' : '#a78bfa') : 'var(--text-primary)' }}>
                      {SectionIcon && <SectionIcon size={12} className="shrink-0" />}
                      {section.label}
                    </span>
                    <ChevronDown
                      size={13}
                      className={`transition-transform duration-200 shrink-0
                        ${isOpen ? 'rotate-0' : '-rotate-90'}
                        ${isLight ? 'text-slate-400' : 'text-slate-600'}`}
                    />
                  </button>
                )}
                {isOpen && (
                  <div className="flex flex-col gap-1.5 overflow-hidden">
                    {section.items.map(item => <NavItem key={item.to} {...item} />)}
                  </div>
                )}
              </div>
            )
          })}

          {/* Admin section */}
          {ADMIN_NAV.length > 0 && (() => {
            const isOpen = collapsed || !!expandedSections['Admin']
            const isActiveSection = ADMIN_NAV.some(i => location.pathname.startsWith(i.to))
            const AdminIcon = SECTION_ICONS.Admin
            return (
              <>
                {collapsed ? (
                  <div className="flex flex-col items-center">
                    <div className="mb-2 mx-3 h-px w-6" style={{ background: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)' }} />
                    <div title="Admin"
                      className="w-6 h-6 mb-2 rounded-md flex items-center justify-center shrink-0"
                      style={{ color: isActiveSection ? (isLight ? '#6c5ce7' : '#a78bfa') : 'var(--text-secondary)' }}>
                      <AdminIcon size={13} />
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => toggleSection('Admin')}
                    className={`mt-3 mb-1 px-3 py-1.5 w-full flex items-center justify-between rounded-lg transition-colors duration-150
                      ${isLight ? 'hover:bg-black/[0.03]' : 'hover:bg-white/[0.04]'}`}
                  >
                    <span className="flex items-center gap-1.5 text-[11px] font-body font-bold uppercase tracking-[0.12em]"
                      style={{ color: isActiveSection ? (isLight ? '#6c5ce7' : '#a78bfa') : 'var(--text-primary)' }}>
                      <AdminIcon size={12} className="shrink-0" />
                      Admin
                    </span>
                    <ChevronDown
                      size={13}
                      className={`transition-transform duration-200 shrink-0
                        ${isOpen ? 'rotate-0' : '-rotate-90'}
                        ${isLight ? 'text-slate-400' : 'text-slate-600'}`}
                    />
                  </button>
                )}
                {isOpen && ADMIN_NAV.map(item => <NavItem key={item.to} {...item} />)}
              </>
            )
          })()}
        </nav>

        {/* Bottom section */}
        <div className={`px-2 py-4 border-t ${isLight ? 'border-black/[0.06]' : 'border-white/6'} flex flex-col gap-2`}>
          {!collapsed && user && (
            <div className={`px-3 py-2 rounded-lg flex items-center gap-2 min-w-0 ${isLight ? 'bg-[#f5f5fa]' : 'bg-surface-3'}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0
                ${isLight ? 'bg-[#6c5ce7] text-white' : 'bg-brand-500/20 text-brand-400'}`}>
                {isLight
                  ? <span className="text-white text-[12px] font-bold uppercase">{user.username?.[0] ?? 'U'}</span>
                  : <Shield size={12} />
                }
              </div>
              <div className="min-w-0">
                <p className={`text-xs font-body font-medium truncate ${isLight ? 'text-[#1a1a2e]' : 'text-slate-300'}`}>
                  {user.username}
                </p>
                <p className={`text-[12px] capitalize ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                  {user.role}
                </p>
              </div>
            </div>
          )}

          {/* Command palette trigger — Cmd+K/Ctrl+K works from anywhere, but
              the shortcut alone isn't discoverable, so this gives it a
              visible home too (same idea as GitHub/Linear's search bar). */}
          <button
            onClick={() => setShowPalette(true)}
            title="Search (Ctrl+K)"
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all duration-150 w-full
              ${isLight ? 'text-slate-500 hover:bg-black/[0.04] hover:text-[#1a1a2e]' : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'}`}
          >
            <Search size={16} className="shrink-0" />
            {!collapsed && (
              <>
                <span className="text-sm font-body font-medium flex-1 text-left">Search</span>
                <kbd className={`text-[11px] px-1.5 py-0.5 rounded border ${isLight ? 'border-black/10 text-slate-400' : 'border-white/10 text-slate-500'}`}>
                  ⌘K
                </kbd>
              </>
            )}
          </button>

          {/* Notification bell — live alerts badge, dropdown for quick view */}
          <NotificationBell collapsed={collapsed} isLight={isLight} />

          {/* Organization switcher — multi-tenant "switch client" dropdown.
              Backend (routes/orgs.js) has supported this since multi-tenancy
              was added; this was the only piece missing. */}
          <OrgSwitcher collapsed={collapsed} isLight={isLight} />

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            title={isLight ? 'Switch to Dark mode' : 'Switch to Light mode'}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150
              ${isLight ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                        : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'}`}
          >
            <div className={`relative w-9 h-5 rounded-full border transition-all duration-300 shrink-0
              ${isLight ? 'bg-[#6c5ce7] border-[#6c5ce7]' : 'bg-surface-4 border-white/10'}`}>
              <div className={`absolute top-0.5 w-4 h-4 rounded-full transition-all duration-300 flex items-center justify-center
                ${isLight ? 'left-[18px] bg-white' : 'left-0.5 bg-slate-400'}`}>
                {isLight ? <Sun size={9} className="text-[#6c5ce7]" /> : <Moon size={9} className="text-surface-1" />}
              </div>
            </div>
            {!collapsed && <span className="text-sm font-body font-medium whitespace-nowrap">{isLight ? 'Light mode' : 'Dark mode'}</span>}
          </button>

          {/* Table density toggle — compact/comfortable, persisted and
              applied globally via a class on <html> (see densityStore.js),
              so Devices/Audit/Users tables all pick it up without local
              per-page state. */}
          <button
            onClick={toggleDensity}
            title={isCompact ? 'Switch to comfortable rows' : 'Switch to compact rows'}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150
              ${isLight ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                        : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'}`}
          >
            {isCompact ? <Rows2 size={16} className="shrink-0" /> : <Rows3 size={16} className="shrink-0" />}
            {!collapsed && <span className="text-sm font-body font-medium whitespace-nowrap">{isCompact ? 'Compact rows' : 'Comfortable rows'}</span>}
          </button>

          {/* Notification preferences (per-user severity thresholds + mute) */}
          <button
            onClick={() => setShowNotifPrefs(true)}
            title="Notification preferences"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150
              ${isLight ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                        : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'}`}
          >
            <BellRing size={16} className="shrink-0" />
            {!collapsed && <span className="text-sm font-body font-medium">Notifications</span>}
          </button>

          {/* Security / 2FA */}
          <button
            onClick={() => setShow2FA(true)}
            title="Two-factor authentication"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150
              ${isLight ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                        : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'}`}
          >
            <ShieldCheck size={16} className="shrink-0" />
            {!collapsed && <span className="text-sm font-body font-medium">Security</span>}
          </button>

          {/* Active sessions — see/revoke your own logged-in devices */}
          <button
            onClick={() => setShowSessions(true)}
            title="Active sessions"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150
              ${isLight ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                        : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'}`}
          >
            <Monitor size={16} className="shrink-0" />
            {!collapsed && <span className="text-sm font-body font-medium">Sessions</span>}
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
            title="Logout"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 text-slate-500 hover:text-accent-red hover:bg-accent-red/10"
          >
            <LogOut size={16} className="shrink-0" />
            {!collapsed && <span className="text-sm font-body font-medium">Logout</span>}
          </button>
        </div>

        <TwoFactorModal open={show2FA} onClose={() => setShow2FA(false)} />
        <SessionsModal open={showSessions} onClose={() => setShowSessions(false)} />
        <NotificationPrefsModal open={showNotifPrefs} onClose={() => setShowNotifPrefs(false)} />

        {/* Edge affordance — the whole right border of the sidebar is a
            click target that shrinks/expands it, not just the small round
            button. Gives a much bigger, more discoverable hit area (the
            way a resizable panel's drag edge works), while the actual
            resize/collapse action here is a simple toggle rather than a
            drag. */}
        <button
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden md:block absolute top-0 right-0 h-full w-2.5 translate-x-1/2 z-40 cursor-col-resize group"
        >
          <span className={`block h-full w-px mx-auto transition-colors duration-150
            ${isLight ? 'bg-black/[0.06] group-hover:bg-[#6c5ce7]/40' : 'bg-white/6 group-hover:bg-brand-400/40'}`} />
        </button>
      </aside>

      {/* Collapse toggle — deliberately rendered OUTSIDE <aside> (which has
          overflow-hidden for its own scrolling nav content) and positioned
          against the relative root container instead. A button placed at
          right:-12px *inside* an overflow-hidden ancestor gets clipped and
          is invisible — that was the whole reason it "wasn't showing up."
          Anchored to a fixed top offset near the logo header (not top-1/2
          of the sidebar's own height, which drifts if <aside>'s computed
          height ever exceeds the viewport) and animates its left offset in
          lockstep with the sidebar's own width transition so it never
          looks detached mid-animation. */}
      <button
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={`hidden md:flex absolute top-8 w-6 h-6 rounded-full border items-center justify-center transition-all duration-300 z-50
          ${isLight ? 'bg-white border-black/10 text-slate-400 hover:text-[#6c5ce7] hover:border-[#6c5ce7]/30'
                    : 'bg-surface-4 border-white/10 text-slate-400 hover:text-slate-200'}`}
        style={{ left: collapsed ? '48px' : '208px' }}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      {/* Mounted outside <aside> deliberately: that element gets a CSS
          transform (translate-x-full) on mobile when the drawer is closed,
          and a transform on an ancestor creates a new containing block for
          position:fixed descendants — a modal mounted inside it would end
          up positioned relative to the (offscreen) sidebar instead of the
          viewport. Keeping it here means Cmd+K works identically whether
          the mobile drawer happens to be open or closed. */}
      <CommandPalette open={showPalette} onClose={() => setShowPalette(false)} />

      {/* Mobile top bar — the sidebar is off-canvas by default under md, so
          this is the only way to reach it (hamburger) and to know which
          page you're on without the always-visible desktop sidebar. */}
      <div className={`md:hidden fixed top-0 inset-x-0 z-20 flex items-center gap-3 px-4 h-14 border-b
        ${isLight ? 'bg-white/95 border-black/[0.06] backdrop-blur' : 'bg-surface-1/95 border-white/6 backdrop-blur'}`}>
        <button
          onClick={() => setMobileOpen(o => !o)}
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0
            ${isLight ? 'text-slate-500 hover:bg-black/[0.04]' : 'text-slate-400 hover:bg-white/[0.06]'}`}
          aria-label="Toggle navigation"
        >
          <Menu size={18} />
        </button>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0
          ${isLight ? 'bg-[#6c5ce7] text-white' : 'bg-brand-500/20 border border-brand-500/30 text-brand-400'}`}>
          <Zap size={14} />
        </div>
        <span className={`font-display text-sm tracking-wide ${isLight ? 'text-[#1a1a2e]' : 'text-white'}`}>
          NetControl
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setShowPalette(true)}
            title="Search"
            className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0
              ${isLight ? 'text-slate-500 hover:bg-black/[0.04]' : 'text-slate-400 hover:bg-white/[0.06]'}`}
            aria-label="Search"
          >
            <Search size={18} />
          </button>
          <NotificationBell collapsed={true} isLight={isLight} variant="topbar" />
        </div>
      </div>

      {/* Main content */}
      <main className={`flex-1 overflow-y-auto overflow-x-hidden transition-colors duration-200 pt-14 md:pt-0 pb-6 ${isLight ? 'text-[#1a1a2e]' : ''}`}>
        {/* resetKey=pathname: a crash on one page can't follow you to the
            next — every navigation (including browser forward/back) mounts
            a clean boundary instead of re-showing a stale error state.
            pb-6 above is a small scroll-safe buffer so a page's last card
            never sits flush against the bottom edge, on top of whatever
            bottom padding that page already applies internally. */}
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}