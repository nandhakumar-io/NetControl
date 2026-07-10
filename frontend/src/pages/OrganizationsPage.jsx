// pages/OrganizationsPage.jsx — MSP "clients" (organizations/tenants).
//
// This was fully built server-side (routes/orgs.js) but had NO frontend at
// all — no page, no nav entry, no switcher — so the multi-tenancy feature
// was completely invisible and unreachable despite working end to end via
// the API. This page is the missing piece: list orgs you belong to, create
// new ones, switch which one is "active" (every device/group/schedule/etc.
// route filters by whichever org is active), and manage membership.
import React, { useState, useEffect, useCallback } from 'react'
import {
  Building2, Plus, X, Loader2, Users, ArrowRightLeft, Trash2,
  Crown, Eye, Wrench, Gauge, Check,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'
import { useAuthStore } from '../store/authStore'

const ROLE_ICON = { admin: Crown, operator: Wrench, viewer: Eye }

export default function OrganizationsPage() {
  const user = useAuthStore(s => s.user)
  const [orgs, setOrgs] = useState([])
  const [activeOrgId, setActiveOrgId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [managingOrg, setManagingOrg] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/orgs')
      setOrgs(data.orgs)
      setActiveOrgId(data.active_org_id)
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load organizations')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const switchOrg = async (org) => {
    if (org.id === activeOrgId) return
    try {
      await api.post(`/orgs/${org.id}/switch`)
      setActiveOrgId(org.id)
      toast.success(`Switched to ${org.name}`)
      // Every org-scoped view (devices, groups, schedules, alerts...) reads
      // from req.orgId server-side, resolved fresh on every request — so a
      // full reload is the simplest way to make every already-mounted page
      // refetch under the new org rather than threading a org-change event
      // through every page in the app.
      setTimeout(() => window.location.reload(), 400)
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to switch organization')
    }
  }

  const deleteOrg = async (org) => {
    if (!window.confirm(`Permanently delete "${org.name}"? This deletes ALL its devices, groups, schedules, and history. This cannot be undone.`)) return
    try {
      await api.delete(`/orgs/${org.id}`)
      toast.success('Organization deleted')
      load()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Delete failed')
    }
  }

  const activeOrg = orgs.find(o => o.id === activeOrgId)

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        icon={Building2}
        title="Organizations"
        description="Manage the clients/tenants you have access to and switch between them"
        actions={
          <button onClick={() => setShowCreate(true)} className="btn-primary">
            <Plus size={14} /> New Organization
          </button>
        }
      />

      {activeOrg && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <StatCard icon={Building2} label="Active organization" value={activeOrg.name}
            iconBg="bg-brand-500/15 border-brand-500/25" iconColor="text-brand-400" />
          <StatCard icon={Gauge} label="Plan" value={activeOrg.plan}
            iconBg="bg-brand-500/15 border-brand-500/25" iconColor="text-brand-400" />
          <StatCard icon={Users} label="Your role here" value={activeOrg.org_role}
            iconBg="bg-brand-500/15 border-brand-500/25" iconColor="text-brand-400" />
        </div>
      )}

      <div className="card">
        <h3 className="font-display text-sm mb-4" style={{ color: 'var(--text-primary)' }}>Your Organizations</h3>
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="animate-spin text-brand-400" size={24} /></div>
        ) : orgs.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8">You aren't a member of any organization yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {orgs.map(org => {
              const RoleIcon = ROLE_ICON[org.org_role] || Eye
              const active = org.id === activeOrgId
              return (
                <div key={org.id}
                  className={`flex items-center justify-between p-3 rounded-xl border transition-colors
                    ${active ? 'border-brand-500/40 bg-brand-500/5' : 'border-white/10'}`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0
                      ${active ? 'bg-brand-500/20 border border-brand-500/30' : 'bg-white/5 border border-white/10'}`}>
                      <Building2 size={16} className={active ? 'text-brand-400' : 'text-slate-500'} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        {org.name}
                        {active && <span className="text-[10px] uppercase font-bold text-brand-400 flex items-center gap-0.5"><Check size={10} /> Active</span>}
                        {org.suspended ? <span className="text-[10px] uppercase font-bold text-accent-red">Suspended</span> : null}
                      </p>
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <RoleIcon size={11} /> {org.org_role} · {org.plan} plan · limit {org.device_limit} devices
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!active && (
                      <button onClick={() => switchOrg(org)} className="btn-secondary text-xs px-3 py-1.5">
                        <ArrowRightLeft size={12} /> Switch
                      </button>
                    )}
                    {org.org_role === 'admin' && (
                      <button onClick={() => setManagingOrg(org)} className="text-slate-500 hover:text-brand-400 p-2" title="Manage members">
                        <Users size={15} />
                      </button>
                    )}
                    {org.org_role === 'admin' && user?.role === 'admin' && (
                      <button onClick={() => deleteOrg(org)} className="text-slate-500 hover:text-accent-red p-2" title="Delete organization">
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateOrgModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load() }} />
      )}
      {managingOrg && (
        <MembersModal org={managingOrg} onClose={() => setManagingOrg(null)} />
      )}
    </div>
  )
}

function CreateOrgModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [plan, setPlan] = useState('trial')
  const [deviceLimit, setDeviceLimit] = useState(25)
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!name.trim()) { toast.error('Name is required'); return }
    setSaving(true)
    try {
      await api.post('/orgs', { name: name.trim(), plan, device_limit: Number(deviceLimit) })
      toast.success('Organization created')
      onCreated()
    } catch (e2) {
      toast.error(e2.response?.data?.error || 'Failed to create organization')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="glass w-full max-w-md rounded-2xl border border-white/10">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <h2 className="font-display text-white text-sm flex items-center gap-2">
            <Building2 size={16} className="text-brand-400" /> New Organization
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>
        <form onSubmit={submit} className="p-5 flex flex-col gap-4">
          <div>
            <label className="label">Name</label>
            <input className="input-field" value={name} onChange={e => setName(e.target.value)} placeholder="Acme Corp" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Plan</label>
              <select className="input-field" value={plan} onChange={e => setPlan(e.target.value)}>
                <option value="trial">Trial</option>
                <option value="standard">Standard</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </div>
            <div>
              <label className="label">Device limit</label>
              <input type="number" min={1} className="input-field" value={deviceLimit} onChange={e => setDeviceLimit(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-slate-500">You'll become this organization's admin. You can switch between organizations at any time.</p>
          <button type="submit" disabled={saving} className="btn-primary w-full justify-center">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create Organization
          </button>
        </form>
      </div>
    </div>
  )
}

function MembersModal({ org, onClose }) {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [username, setUsername] = useState('')
  const [role, setRole] = useState('operator')
  const [inviting, setInviting] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api.get(`/orgs/${org.id}/members`).then(({ data }) => setMembers(data)).catch(() => {}).finally(() => setLoading(false))
  }, [org.id])

  useEffect(() => { load() }, [load])

  const invite = async (e) => {
    e.preventDefault()
    if (!username.trim()) { toast.error('Username is required'); return }
    setInviting(true)
    try {
      await api.post(`/orgs/${org.id}/members`, { username: username.trim(), org_role: role })
      toast.success(`${username} added`)
      setUsername('')
      load()
    } catch (e2) {
      toast.error(e2.response?.data?.error || 'Failed to add member')
    } finally {
      setInviting(false)
    }
  }

  const remove = async (m) => {
    if (!window.confirm(`Remove ${m.username} from ${org.name}?`)) return
    try {
      await api.delete(`/orgs/${org.id}/members/${m.id}`)
      load()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to remove member')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="glass w-full max-w-lg rounded-2xl border border-white/10 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 sticky top-0 bg-inherit">
          <h2 className="font-display text-white text-sm flex items-center gap-2">
            <Users size={16} className="text-brand-400" /> Members — {org.name}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={16} /></button>
        </div>

        <form onSubmit={invite} className="p-5 flex gap-2 border-b border-white/10">
          <input className="input-field flex-1" placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} />
          <select className="input-field w-32" value={role} onChange={e => setRole(e.target.value)}>
            <option value="admin">Admin</option>
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
          </select>
          <button type="submit" disabled={inviting} className="btn-primary px-3">
            {inviting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          </button>
        </form>

        <div className="p-5">
          {loading ? (
            <div className="flex justify-center py-6"><Loader2 className="animate-spin text-brand-400" size={20} /></div>
          ) : members.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-4">No members yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {members.map(m => {
                const RoleIcon = ROLE_ICON[m.org_role] || Eye
                return (
                  <div key={m.id} className="flex items-center justify-between py-2 border-b last:border-0" style={{ borderColor: 'var(--border-subtle)' }}>
                    <span className="text-sm flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                      <RoleIcon size={13} className="text-slate-500" /> {m.username}
                      <span className="text-xs text-slate-500">({m.org_role})</span>
                    </span>
                    <button onClick={() => remove(m)} className="text-slate-500 hover:text-accent-red p-1">
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}