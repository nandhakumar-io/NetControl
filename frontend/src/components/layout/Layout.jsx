import React, { useState, useEffect, useRef } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Monitor, Layers, Clock, ScrollText, Activity,
  LogOut, ChevronLeft, ChevronRight, Zap, Shield, Sun, Moon,
  Users, FolderOpen, Share2, Bell, X, AlertTriangle
} from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'
import { usePermissions } from '../../hooks/usePermissions'
import api from '../../lib/api'
import toast from 'react-hot-toast'

// ── Notification bell — SSE listener only, no nav ─────────────────────────────
// This component handles LIVE notifications (toasts + badge count).
// The actual Alerts page is navigated to via the NavItem below.
function NotificationBell({ collapsed, isLight }) {
  const [notifs, setNotifs] = useState([])
  const [open, setOpen]     = useState(false)
  const token    = localStorage.getItem('nc_token')
  const panelRef = useRef(null)

  // Load persisted notifications on mount
  useEffect(() => {
    api.get('/alerts/notifications').then(r => setNotifs(r.data || [])).catch(() => {})
  }, [])

  // SSE — live notification stream (toast popups only)
  useEffect(() => {
    if (!token) return
    const es = new EventSource(
      `${api.defaults.baseURL}/alerts/stream?token=${encodeURIComponent(token)}`
    )
    es.onmessage = (e) => {
      try {
        const n = JSON.parse(e.data)
        if (!n.type) return
        setNotifs(prev => [n, ...prev].slice(0, 50))
        if (n.severity === 'critical') {
          toast.error(`🚨 ${n.rule_name}: ${n.details} on ${n.device_name}`, { duration: 8000 })
        } else {
          toast(`⚠ ${n.rule_name} on ${n.device_name}`, { duration: 5000 })
        }
      } catch {}
    }
    return () => es.close()
  }, [token])

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
  const sevColor = (sev) => sev === 'critical' ? '#f87171' : '#facc15'

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell badge button — opens notification dropdown */}
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

      {/* Notification dropdown */}
      {open && (
        <div
          className="fixed z-[200] w-80 rounded-2xl overflow-hidden shadow-2xl animate-slide-up"
          style={{
            left: collapsed ? '68px' : '228px',
            bottom: '80px',
            background: isLight ? '#fff' : '#0f0f1a',
            border: isLight ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(255,255,255,0.08)',
          }}
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
          <div className="max-h-72 overflow-y-auto">
            {notifs.length === 0 ? (
              <div className="py-8 flex flex-col items-center gap-2 opacity-50">
                <Bell size={20} style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>No notifications</p>
              </div>
            ) : notifs.map((n, i) => (
              <div key={n.id || i} className="px-4 py-3 flex items-start gap-3"
                style={{ borderBottom: `1px solid ${isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)'}` }}>
                <AlertTriangle size={14} style={{ color: sevColor(n.severity), marginTop: 2, flexShrink: 0 }} />
                <div className="min-w-0">
                  <p className="text-xs font-body font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {n.rule_name || n.message?.split(':')[0] || 'Alert'}
                  </p>
                  <p className="text-[11px] font-body mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                    {n.details || n.message}
                  </p>
                  {n.device_name && (
                    <p className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-faint)' }}>
                      {n.device_name}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Layout ─────────────────────────────────────────────────────────────────────
export default function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  const logout   = useAuthStore(s => s.logout)
  const user     = useAuthStore(s => s.user)
  const navigate = useNavigate()

  const { theme, toggleTheme, applyTheme } = useThemeStore()
  const isLight = theme === 'light'
  const { isAdmin, can } = usePermissions()

  useEffect(() => { applyTheme(theme) }, [])

  const handleLogout = async () => {
    await logout()
    toast.success('Logged out')
    navigate('/login')
  }

  // ── Nav items — Alerts is now a proper NavLink to /alerts ─────────────────
  const NAV = [
    { to: '/dashboard',     icon: LayoutDashboard, label: 'Dashboard',     show: true },
    { to: '/devices',       icon: Monitor,         label: 'Devices',       show: can(1) },
    { to: '/groups',        icon: Layers,          label: 'Labs & Groups', show: can(8) },
    { to: '/remote-access', icon: Share2,           label: 'Remote Access', show: can(1) },
    { to: '/file-push',     icon: FolderOpen,      label: 'File Push',     show: can(1) },
    { to: '/schedules',     icon: Clock,           label: 'Schedules',     show: can(32) },
    { to: '/audit',         icon: ScrollText,      label: 'Audit Log',     show: can(128) },
    { to: '/monitoring',    icon: Activity,        label: 'Monitoring',    show: can(1) },
    { to: '/alerts',        icon: Bell,            label: 'Alerts',        show: can(1) },
  ].filter(n => n.show)

  const ADMIN_NAV = [
    { to: '/users', icon: Users, label: 'Users', show: isAdmin },
  ].filter(n => n.show)

  const NavItem = ({ to, icon: Icon, label }) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 group
         ${isActive
           ? isLight ? 'bg-[#6c5ce7]/10 text-[#6c5ce7] font-semibold'
                     : 'bg-brand-500/15 text-brand-400 border border-brand-500/25'
           : isLight ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                     : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'
         }`
      }
      title={collapsed ? label : undefined}
    >
      {({ isActive }) => (
        <>
          {isLight && isActive
            ? <div className="w-6 h-6 rounded-md bg-[#6c5ce7] flex items-center justify-center shrink-0">
                <Icon size={13} className="text-white" />
              </div>
            : <Icon size={16} className="shrink-0" />
          }
          {!collapsed && <span className="text-sm font-body font-medium whitespace-nowrap">{label}</span>}
        </>
      )}
    </NavLink>
  )

  return (
    <div className={`flex h-screen overflow-hidden transition-colors duration-200 ${isLight ? 'bg-[#eef0f5]' : 'grid-bg bg-surface-0'}`}>

      {/* Sidebar */}
      <aside
        className={`flex flex-col shrink-0 transition-all duration-300 ease-in-out relative
          ${isLight ? 'bg-white border-r border-black/[0.06]' : 'bg-surface-1 border-r border-white/6'}
          ${collapsed ? 'w-[60px]' : 'w-[220px]'}`}
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
        <nav className="flex-1 py-4 px-2 flex flex-col gap-1 overflow-y-auto">
          {NAV.map(item => <NavItem key={item.to} {...item} />)}

          {/* Admin section */}
          {ADMIN_NAV.length > 0 && (
            <>
              {!collapsed && (
                <div className="mt-3 mb-1 px-3">
                  <p className={`text-[10px] font-body font-semibold uppercase tracking-widest ${isLight ? 'text-slate-400' : 'text-slate-600'}`}>
                    Admin
                  </p>
                </div>
              )}
              {collapsed && <div className={`my-2 mx-3 h-px ${isLight ? 'bg-black/[0.06]' : 'bg-white/6'}`} />}
              {ADMIN_NAV.map(item => <NavItem key={item.to} {...item} />)}
            </>
          )}
        </nav>

        {/* Bottom section */}
        <div className={`px-2 py-4 border-t ${isLight ? 'border-black/[0.06]' : 'border-white/6'} flex flex-col gap-2`}>
          {!collapsed && user && (
            <div className={`px-3 py-2 rounded-lg flex items-center gap-2 min-w-0 ${isLight ? 'bg-[#f5f5fa]' : 'bg-surface-3'}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0
                ${isLight ? 'bg-[#6c5ce7] text-white' : 'bg-brand-500/20 text-brand-400'}`}>
                {isLight
                  ? <span className="text-white text-[10px] font-bold uppercase">{user.username?.[0] ?? 'U'}</span>
                  : <Shield size={12} />
                }
              </div>
              <div className="min-w-0">
                <p className={`text-xs font-body font-medium truncate ${isLight ? 'text-[#1a1a2e]' : 'text-slate-300'}`}>
                  {user.username}
                </p>
                <p className={`text-[10px] capitalize ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                  {user.role}
                </p>
              </div>
            </div>
          )}

          {/* Notification bell — live alerts badge, dropdown for quick view */}
          <NotificationBell collapsed={collapsed} isLight={isLight} />

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

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className={`absolute top-1/2 -translate-y-1/2 w-6 h-6 rounded-full border flex items-center justify-center transition-all duration-150 z-50
            ${isLight ? 'bg-white border-black/10 text-slate-400 hover:text-[#6c5ce7] hover:border-[#6c5ce7]/30'
                      : 'bg-surface-4 border-white/10 text-slate-400 hover:text-slate-200'}`}
          style={{ right: '-12px' }}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </aside>

      {/* Main content */}
      <main className={`flex-1 overflow-y-auto transition-colors duration-200 ${isLight ? 'text-[#1a1a2e]' : ''}`}>
        <Outlet />
      </main>
    </div>
  )
}