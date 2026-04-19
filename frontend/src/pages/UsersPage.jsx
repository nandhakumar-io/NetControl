import React, { useState, useEffect, useCallback } from 'react'
import {
  Users, Plus, Shield, ShieldOff, Trash2, Pencil,
  Activity, Search, RefreshCw, CheckCircle2, XCircle,
  Clock, Layers, X, Check, AlertTriangle, Lock
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import UserModal from '../components/modals/UserModal'
import UserActivityModal from '../components/modals/UserActivityModal'
import { usePermissions } from '../hooks/usePermissions'
import { useAuthStore } from '../store/authStore'
import { useThemeStore } from '../store/themeStore'

const ROLE_COLOR = { admin:'#a78bfa', operator:'#38bdf8', viewer:'#94a3b8', custom:'#fb923c' }
const ROLE_BG    = { admin:'rgba(167,139,250,0.12)', operator:'rgba(56,189,248,0.12)', viewer:'rgba(148,163,184,0.12)', custom:'rgba(251,146,60,0.12)' }

function RoleBadge({ role }) {
  return (
    <span className="text-[11px] font-body font-bold capitalize px-2 py-0.5 rounded-full border"
      style={{ background: ROLE_BG[role]||ROLE_BG.viewer, borderColor: (ROLE_COLOR[role]||'#94a3b8')+'40', color: ROLE_COLOR[role]||'#94a3b8' }}>
      {role}
    </span>
  )
}

function formatTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// ── Group assignment panel ────────────────────────────────────────────────────
function GroupAccessPanel({ user, allGroups, onClose, onSaved }) {
  const [assigned, setAssigned] = useState([])
  const [saving, setSaving] = useState(false)
  const isLight = useThemeStore(s => s.theme === 'light')

  useEffect(() => {
    api.get(`/users/${user.id}/groups`)
      .then(r => setAssigned(r.data.map(g => g.id)))
      .catch(() => {})
  }, [user.id])

  const toggle = (id) => setAssigned(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const save = async () => {
    setSaving(true)
    try {
      await api.put(`/users/${user.id}/groups`, { groupIds: assigned })
      toast.success('Group access updated')
      onSaved(); onClose()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to save')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-md rounded-2xl overflow-hidden animate-slide-up"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ height: 3, background: 'linear-gradient(90deg,#38bdf8,#818cf8)' }} />
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.25)' }}>
              <Layers size={14} style={{ color: '#38bdf8' }} />
            </div>
            <div>
              <p className="text-sm font-body font-semibold" style={{ color: 'var(--text-primary)' }}>Group Access</p>
              <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
                Operator <strong>{user.username}</strong> — select accessible labs/groups
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:text-accent-red" style={{ color: 'var(--text-muted)' }}>
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 max-h-72 overflow-y-auto space-y-2">
          {allGroups.length === 0 ? (
            <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>No groups configured</p>
          ) : allGroups.map(g => {
            const on = assigned.includes(g.id)
            return (
              <button key={g.id} onClick={() => toggle(g.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all"
                style={{
                  background: on ? 'rgba(56,189,248,0.08)' : 'var(--bg-input)',
                  border: `1px solid ${on ? 'rgba(56,189,248,0.35)' : 'var(--border-subtle)'}`,
                }}>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: on ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.05)', border: `1px solid ${on ? 'rgba(56,189,248,0.3)' : 'var(--border-subtle)'}` }}>
                  <Layers size={12} style={{ color: on ? '#38bdf8' : 'var(--text-muted)' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-body font-medium" style={{ color: 'var(--text-primary)' }}>{g.name}</p>
                  {g.description && <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{g.description}</p>}
                </div>
                <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all"
                  style={{ borderColor: on ? '#38bdf8' : 'var(--text-muted)', background: on ? '#38bdf8' : 'transparent' }}>
                  {on && <Check size={10} className="text-white" />}
                </div>
              </button>
            )
          })}
        </div>

        <div className="flex gap-2 px-5 py-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={onClose} className="btn-ghost flex-1 justify-center text-sm">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary flex-1 justify-center text-sm disabled:opacity-40">
            {saving ? 'Saving…' : `Save (${assigned.length} group${assigned.length !== 1 ? 's' : ''})`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── User row ──────────────────────────────────────────────────────────────────
function UserRow({ user, currentUserId, groups, onEdit, onDelete, onToggle, onActivity, onAssignGroups }) {
  const isSelf = user.id === currentUserId
  return (
    <div className="grid items-center gap-3 px-5 py-4 transition-colors group"
      style={{ gridTemplateColumns: '240px 120px 100px 160px 140px 96px', borderBottom: '1px solid var(--border-subtle)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>

      {/* User info */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
          style={{ background: ROLE_BG[user.role] || ROLE_BG.viewer, color: ROLE_COLOR[user.role] || '#94a3b8' }}>
          {user.username[0].toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-body font-medium truncate" style={{ color: 'var(--text-primary)' }}>{user.username}</p>
            {isSelf && <span className="text-[9px] px-1.5 py-0.5 rounded font-body" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>you</span>}
          </div>
          <p className="text-[10px] font-body" style={{ color: 'var(--text-muted)' }}>Created {formatTs(user.created_at)}</p>
        </div>
      </div>

      <RoleBadge role={user.role} />

      <div className="flex items-center gap-1.5">
        {user.enabled
          ? <><CheckCircle2 size={12} style={{ color: '#34d399' }} /><span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Active</span></>
          : <><XCircle size={12} style={{ color: '#f87171' }} /><span className="text-xs text-accent-red">Disabled</span></>}
      </div>

      <div className="flex items-center gap-1.5">
        <Clock size={11} style={{ color: 'var(--text-faint)' }} />
        <span className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>{formatTs(user.last_login)}</span>
      </div>

      <div className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
        {user.role === 'admin' ? 'Full access'
          : user.role === 'operator' ? (
            <button onClick={() => onAssignGroups(user)}
              className="flex items-center gap-1 text-xs hover:underline"
              style={{ color: '#38bdf8' }}>
              <Layers size={10} /> Manage groups
            </button>
          ) : user.role === 'viewer' ? 'Read-only'
          : <span className="font-mono text-[10px]">0b{(user.permissions || 0).toString(2).padStart(8, '0')}</span>}
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={() => onActivity(user)} title="Activity"
          className="p-1.5 rounded-lg transition-all" style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#818cf8'; e.currentTarget.style.background = 'rgba(129,140,248,0.1)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}>
          <Activity size={13} />
        </button>
        <button onClick={() => onEdit(user)} title="Edit"
          className="p-1.5 rounded-lg transition-all" style={{ color: 'var(--text-muted)' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#38bdf8'; e.currentTarget.style.background = 'rgba(56,189,248,0.1)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}>
          <Pencil size={13} />
        </button>
        {!isSelf && <>
          <button onClick={() => onToggle(user)} title={user.enabled ? 'Disable' : 'Enable'}
            className="p-1.5 rounded-lg transition-all" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => { e.currentTarget.style.color = user.enabled ? '#f87171' : '#34d399'; e.currentTarget.style.background = user.enabled ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}>
            {user.enabled ? <ShieldOff size={13} /> : <Shield size={13} />}
          </button>
          <button onClick={() => onDelete(user)} title="Delete"
            className="p-1.5 rounded-lg transition-all" style={{ color: 'var(--text-muted)' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; e.currentTarget.style.background = 'rgba(248,113,113,0.1)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}>
            <Trash2 size={13} />
          </button>
        </>}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function UsersPage() {
  const [users, setUsers]           = useState([])
  const [groups, setGroups]         = useState([])
  const [loading, setLoading]       = useState(true)
  const [search, setSearch]         = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [editTarget, setEditTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [activityTarget, setActivityTarget] = useState(null)
  const [groupAccessTarget, setGroupAccessTarget] = useState(null)

  const { isAdmin } = usePermissions()
  const currentUser = useAuthStore(s => s.user)
  const isLight = useThemeStore(s => s.theme === 'light')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [u, g] = await Promise.all([api.get('/users'), api.get('/groups')])
      setUsers(u.data); setGroups(g.data)
    } catch { toast.error('Failed to load') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const handleToggle = async (user) => {
    try {
      await api.put(`/users/${user.id}`, { enabled: !user.enabled })
      toast.success(`${user.username} ${user.enabled ? 'disabled' : 'enabled'}`)
      load()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed') }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await api.delete(`/users/${deleteTarget.id}`)
      toast.success(`${deleteTarget.username} deleted`)
      setDeleteTarget(null); load()
    } catch (e) { toast.error(e.response?.data?.error || 'Delete failed') }
  }

  const filtered = users.filter(u => {
    const q = search.toLowerCase()
    return (!q || u.username.toLowerCase().includes(q)) &&
           (roleFilter === 'all' || u.role === roleFilter)
  })

  const counts = {
    total: users.length,
    admin: users.filter(u => u.role === 'admin').length,
    operator: users.filter(u => u.role === 'operator').length,
    viewer: users.filter(u => u.role === 'viewer').length,
    disabled: users.filter(u => !u.enabled).length,
  }

  if (!isAdmin) return (
    <div className="p-6 flex flex-col items-center justify-center min-h-[60vh]">
      <Lock size={36} style={{ color: 'var(--text-muted)' }} className="mb-3" />
      <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>Admin access required</p>
    </div>
  )

  return (
    <div className="p-6 max-w-[1400px] mx-auto animate-fade-in pb-10">
      <PageHeader icon={Users} title="User Management"
        description="Manage accounts, roles and group-level access"
        actions={
          <div className="flex gap-2">
            <button onClick={load} className="icon-btn"><RefreshCw size={13} /></button>
            <button onClick={() => setEditTarget('new')} className="btn-primary"><Plus size={14} /> New User</button>
          </div>
        }
      />

      {/* ── Role info banner ─────────────────────────────────────────── */}
      <div className="glass rounded-xl p-4 mb-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { role: 'admin',    color: '#a78bfa', title: 'Admin',    desc: 'Full access to all labs, devices, and settings' },
          { role: 'operator', color: '#38bdf8', title: 'Operator', desc: 'Can manage devices only in their assigned groups' },
          { role: 'viewer',   color: '#94a3b8', title: 'Viewer',   desc: 'Read-only access — cannot execute any actions' },
        ].map(({ role, color, title, desc }) => (
          <div key={role} className="flex items-start gap-3 px-3 py-2 rounded-xl"
            style={{ background: `${color}08`, border: `1px solid ${color}20` }}>
            <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5"
              style={{ background: `${color}15` }}>
              <Shield size={11} style={{ color }} />
            </div>
            <div>
              <p className="text-xs font-body font-bold" style={{ color }}>{title}</p>
              <p className="text-[10px] font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>{desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-3 mb-5">
        {[['Total', counts.total, '#818cf8'], ['Admin', counts.admin, '#a78bfa'],
          ['Operator', counts.operator, '#38bdf8'], ['Viewer', counts.viewer, '#94a3b8'],
          ['Disabled', counts.disabled, '#f87171']].map(([l, v, c]) => (
          <div key={l} className="glass rounded-2xl p-4">
            <p className="text-2xl font-display font-bold" style={{ color: c }}>{v}</p>
            <p className="text-[10px] font-body uppercase tracking-wider mt-1" style={{ color: 'var(--text-muted)' }}>{l}</p>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
          <input className="input-field pl-8 h-8 text-xs" placeholder="Search users…"
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {['all', 'admin', 'operator', 'viewer'].map(r => (
            <button key={r} onClick={() => setRoleFilter(r)}
              className={`chip h-8 px-3 text-xs capitalize ${roleFilter === r ? 'chip-selected' : ''}`}>
              {r === 'all' ? 'All' : r}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="glass rounded-2xl overflow-hidden">
        <div className="grid gap-3 px-5 py-3 text-[10px] font-body font-bold uppercase tracking-wider"
          style={{ gridTemplateColumns: '240px 120px 100px 160px 140px 96px',
                   background: 'var(--bg-input)', borderBottom: '1px solid var(--border-subtle)',
                   color: 'var(--text-muted)' }}>
          {['User', 'Role', 'Status', 'Last Login', 'Access', 'Actions'].map(h => <span key={h}>{h}</span>)}
        </div>
        {loading ? (
          <div className="py-16 flex items-center justify-center">
            <RefreshCw size={18} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-2 opacity-50">
            <Users size={26} style={{ color: 'var(--text-muted)' }} />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No users found</p>
          </div>
        ) : filtered.map(u => (
          <UserRow key={u.id} user={u} currentUserId={currentUser?.id} groups={groups}
            onEdit={setEditTarget} onDelete={setDeleteTarget}
            onToggle={handleToggle} onActivity={setActivityTarget}
            onAssignGroups={setGroupAccessTarget} />
        ))}
      </div>

      {/* Delete confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setDeleteTarget(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-sm rounded-2xl p-6 animate-slide-up"
            style={{ background: 'var(--bg-card)', border: '1px solid rgba(248,113,113,0.3)' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-10 h-10 rounded-full flex items-center justify-center mb-4"
              style={{ background: 'rgba(248,113,113,0.12)' }}>
              <Trash2 size={18} style={{ color: '#f87171' }} />
            </div>
            <h3 className="font-display text-base mb-1" style={{ color: 'var(--text-primary)' }}>
              Delete {deleteTarget.username}?
            </h3>
            <p className="text-sm font-body mb-5" style={{ color: 'var(--text-muted)' }}>
              This permanently removes the account and all sessions.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteTarget(null)} className="btn-ghost flex-1 justify-center">Cancel</button>
              <button onClick={handleDelete} className="btn-danger flex-1 justify-center">Delete</button>
            </div>
          </div>
        </div>
      )}

      {groupAccessTarget && (
        <GroupAccessPanel user={groupAccessTarget} allGroups={groups}
          onClose={() => setGroupAccessTarget(null)} onSaved={load} />
      )}

      <UserModal open={!!editTarget} onClose={() => setEditTarget(null)} onSaved={load}
        user={editTarget !== 'new' ? editTarget : null} isLight={isLight} />
      <UserActivityModal open={!!activityTarget} onClose={() => setActivityTarget(null)}
        user={activityTarget} isLight={isLight} />
    </div>
  )
}
