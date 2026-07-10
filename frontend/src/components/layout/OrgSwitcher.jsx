// components/layout/OrgSwitcher.jsx — compact "switch client" dropdown for
// the sidebar. Backend (routes/orgs.js) has fully supported this since
// multi-tenancy was added — GET /api/orgs and POST /api/orgs/:id/switch —
// but nothing in the UI ever called it, so a user with access to multiple
// organizations had no way to move between them short of calling the API
// directly. This is the missing piece, plus a link into the full
// Organizations page for creating orgs / managing members.
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, ChevronDown, Check, Settings } from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'

export default function OrgSwitcher({ collapsed, isLight }) {
  const [orgs, setOrgs] = useState([])
  const [activeOrgId, setActiveOrgId] = useState(null)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const navigate = useNavigate()

  const load = useCallback(() => {
    api.get('/orgs').then(({ data }) => {
      setOrgs(data.orgs)
      setActiveOrgId(data.active_org_id)
    }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const switchOrg = async (org) => {
    setOpen(false)
    if (org.id === activeOrgId) return
    try {
      await api.post(`/orgs/${org.id}/switch`)
      toast.success(`Switched to ${org.name}`)
      setTimeout(() => window.location.reload(), 300)
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to switch organization')
    }
  }

  const active = orgs.find(o => o.id === activeOrgId)

  if (orgs.length === 0) return null

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => (orgs.length > 1 ? setOpen(o => !o) : navigate('/organizations'))}
        title={collapsed ? (active?.name || 'Organizations') : undefined}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150
          ${isLight ? 'text-slate-500 hover:text-[#1a1a2e] hover:bg-black/[0.04]'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-surface-3'}`}
      >
        <Building2 size={16} className="shrink-0" />
        {!collapsed && (
          <span className="text-sm font-body font-medium truncate flex-1 text-left">
            {active?.name || 'Organizations'}
          </span>
        )}
        {!collapsed && orgs.length > 1 && <ChevronDown size={13} className="shrink-0" />}
      </button>

      {open && (
        <div className={`absolute bottom-full mb-1 left-0 w-56 rounded-xl border overflow-hidden z-50 shadow-xl
          ${isLight ? 'bg-white border-black/10' : 'bg-surface-2 border-white/10'}`}>
          <div className="max-h-64 overflow-y-auto py-1">
            {orgs.map(org => (
              <button
                key={org.id}
                onClick={() => switchOrg(org)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors
                  ${isLight ? 'hover:bg-black/[0.04] text-slate-700' : 'hover:bg-white/5 text-slate-300'}`}
              >
                <span className="truncate">{org.name}</span>
                {org.id === activeOrgId && <Check size={13} className="text-brand-400 shrink-0" />}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setOpen(false); navigate('/organizations') }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs border-t
              ${isLight ? 'border-black/10 text-slate-500 hover:bg-black/[0.04]' : 'border-white/10 text-slate-500 hover:bg-white/5'}`}
          >
            <Settings size={12} /> Manage organizations
          </button>
        </div>
      )}
    </div>
  )
}