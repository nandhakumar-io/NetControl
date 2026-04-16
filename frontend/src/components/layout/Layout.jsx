import React, { useState, useEffect } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Monitor, Layers, Clock, ScrollText,
  LogOut, ChevronLeft, ChevronRight, Zap, Shield, Sun, Moon,
  Upload, Terminal
} from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { useThemeStore } from '../../store/themeStore'
import toast from 'react-hot-toast'

const NAV = [
  { to: '/dashboard',      icon: LayoutDashboard, label: 'Dashboard'     },
  { to: '/devices',        icon: Monitor,         label: 'Devices'       },
  { to: '/groups',         icon: Layers,          label: 'Labs & Groups' },
  { to: '/remote-access',  icon: Terminal,        label: 'Remote Access' },
  { to: '/file-push',      icon: Upload,          label: 'File Push'     },
  { to: '/schedules',      icon: Clock,           label: 'Schedules'     },
  { to: '/audit',          icon: ScrollText,      label: 'Audit Log'     },
]

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  const logout = useAuthStore(s => s.logout)
  const user   = useAuthStore(s => s.user)
  const navigate = useNavigate()

  const { theme, toggleTheme, applyTheme } = useThemeStore()
  const isLight = theme === 'light'

  // Apply persisted theme on mount
  useEffect(() => { applyTheme(theme) }, [])

  const handleLogout = async () => {
    await logout()
    toast.success('Logged out')
    navigate('/login')
  }

  return (
    <div className={`flex h-screen overflow-hidden transition-colors duration-200 ${isLight ? 'bg-[#eef0f5]' : 'grid-bg bg-surface-0'}`}>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside
        className={`
          flex flex-col shrink-0 transition-all duration-300 ease-in-out relative
          ${isLight
            ? 'bg-white border-r border-black/[0.06]'
            : 'bg-surface-1 border-r border-white/6'
          }
          ${collapsed ? 'w-[60px]' : 'w-[220px]'}
        `}
        style={isLight ? { boxShadow: '2px 0 12px rgba(0,0,0,0.05)' } : {}}
      >
        {/* Logo */}
        <div className={`flex items-center gap-3 px-4 py-5 border-b ${isLight ? 'border-black/[0.06]' : 'border-white/6'}`}>
          <div className={`
            w-8 h-8 rounded-lg flex items-center justify-center shrink-0
            ${isLight
              ? 'bg-[#6c5ce7] text-white'
              : 'bg-brand-500/20 border border-brand-500/30 text-brand-400 animate-glow'
            }
          `}>
            <Zap size={16} />
          </div>
          {!collapsed && (
            <span className={`font-display text-sm tracking-wide whitespace-nowrap ${isLight ? 'text-[#1a1a2e]' : 'text-white'}`}>
              NetControl
            </span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 px-2 flex flex-col gap-1">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 group
                 ${isActive
                   ? isLight
                     ? 'bg-[#6c5ce7]/10 text-[#6c5ce7] font-semibold'
                     : 'bg-brand-500/15 text-brand-400 border border-brand-500/25'
                   : isLight
                     ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                     : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'
                 }`
              }
              title={collapsed ? label : undefined}
            >
              {({ isActive }) => (
                <>
                  {isLight && isActive
                    ? (
                      <div className="w-6 h-6 rounded-md bg-[#6c5ce7] flex items-center justify-center shrink-0">
                        <Icon size={13} className="text-white" />
                      </div>
                    )
                    : <Icon size={16} className="shrink-0" />
                  }
                  {!collapsed && (
                    <span className="text-sm font-body font-medium whitespace-nowrap">{label}</span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Bottom section */}
        <div className={`px-2 py-4 border-t ${isLight ? 'border-black/[0.06]' : 'border-white/6'} flex flex-col gap-2`}>

          {/* User info */}
          {!collapsed && user && (
            <div className={`px-3 py-2 rounded-lg flex items-center gap-2 min-w-0 ${isLight ? 'bg-[#f5f5fa]' : 'bg-surface-3'}`}>
              {isLight
                ? (
                  <div className="w-6 h-6 rounded-full bg-[#6c5ce7] flex items-center justify-center shrink-0">
                    <span className="text-white text-[10px] font-bold uppercase">
                      {user.username?.[0] ?? 'U'}
                    </span>
                  </div>
                )
                : <Shield size={14} className="text-brand-400 shrink-0" />
              }
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

          {/* ── Theme toggle ─────────────────────────────────────────── */}
          <button
            onClick={toggleTheme}
            title={isLight ? 'Switch to Dark mode' : 'Switch to Light mode'}
            className={`
              flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150
              ${isLight
                ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'
              }
            `}
          >
            {/* Animated toggle track */}
            <div className={`
              relative w-9 h-5 rounded-full border transition-all duration-300 shrink-0
              ${isLight
                ? 'bg-[#6c5ce7] border-[#6c5ce7]'
                : 'bg-surface-4 border-white/10'
              }
            `}>
              <div className={`
                absolute top-0.5 w-4 h-4 rounded-full transition-all duration-300 flex items-center justify-center
                ${isLight
                  ? 'left-[18px] bg-white'
                  : 'left-0.5 bg-slate-400'
                }
              `}>
                {isLight
                  ? <Sun size={9} className="text-[#6c5ce7]" />
                  : <Moon size={9} className="text-surface-1" />
                }
              </div>
            </div>
            {!collapsed && (
              <span className="text-sm font-body font-medium whitespace-nowrap">
                {isLight ? 'Light mode' : 'Dark mode'}
              </span>
            )}
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
            title="Logout"
            className={`
              flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150
              text-slate-500 hover:text-accent-red hover:bg-accent-red/10
            `}
          >
            <LogOut size={16} className="shrink-0" />
            {!collapsed && <span className="text-sm font-body font-medium">Logout</span>}
          </button>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(c => !c)}
          className={`
            absolute top-1/2 -translate-y-1/2 w-6 h-6 rounded-full
            border flex items-center justify-center transition-all duration-150 z-50
            ${isLight
              ? 'bg-white border-black/10 text-slate-400 hover:text-[#6c5ce7] hover:border-[#6c5ce7]/30'
              : 'bg-surface-4 border-white/10 text-slate-400 hover:text-slate-200'
            }
          `}
          style={{ right: '-12px' }}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main className={`flex-1 overflow-y-auto transition-colors duration-200 ${isLight ? 'text-[#1a1a2e]' : ''}`}>
        <Outlet />
      </main>
    </div>
  )
}

