// components/SavedViews.jsx — "save this filter combo as a named view",
// same idea as the Bulk Command console's favorite commands
// (bulk_command_history), generalized for any filter-driven list page via
// routes/savedViews.js. Org-scoped and shared with the whole team — for an
// MSP running one org per client, a view like "Client X — offline Windows
// boxes" is exactly the kind of thing every operator should be able to
// jump to, not just whoever made it.
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Bookmark, Plus, X, Check, ChevronDown } from 'lucide-react'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'

export default function SavedViews({ page, filters, onApply, isLight }) {
  const user = useAuthStore(s => s.user)
  const canManage = user?.role === 'admin' || user?.role === 'operator'

  const [views, setViews]   = useState([])
  const [open, setOpen]     = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName]     = useState('')
  const [error, setError]   = useState('')
  const boxRef = useRef(null)

  const load = useCallback(() => {
    api.get('/saved-views', { params: { page } })
      .then(({ data }) => setViews(data))
      .catch(() => {})
  }, [page])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onDocClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) { setOpen(false); setSaving(false) } }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const apply = async (view) => {
    onApply(view.filters)
    setOpen(false)
    api.patch(`/saved-views/${view.id}/use`).catch(() => {}) // fire-and-forget — bumps it up the "recently used" order
  }

  const remove = async (id, e) => {
    e.stopPropagation()
    try {
      await api.delete(`/saved-views/${id}`)
      setViews(v => v.filter(x => x.id !== id))
    } catch { /* no-op — view list just won't shrink, not worth surfacing */ }
  }

  const saveCurrent = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      await api.post('/saved-views', { page, name: trimmed, filters })
      setName(''); setSaving(false); setError('')
      load()
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save view')
    }
  }

  const accent = isLight ? '#6c5ce7' : '#a78bfa'

  return (
    <div className="relative" ref={boxRef}>
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-all"
        style={{ color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', background: open ? 'var(--bg-surface-3)' : 'transparent' }}>
        <Bookmark size={12} />
        <span className="hidden sm:inline">Views</span>
        {views.length > 0 && <span className="text-xs font-mono opacity-60">({views.length})</span>}
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="absolute right-0 sm:left-0 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl shadow-xl z-50 overflow-hidden"
          style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>

          <div className="max-h-64 overflow-y-auto">
            {views.length === 0 && !saving && (
              <p className="text-xs font-body px-3 py-3" style={{ color: 'var(--text-faint)' }}>
                No saved views yet{canManage ? ' — save your current filters below.' : '.'}
              </p>
            )}
            {views.map(v => (
              <button key={v.id} onClick={() => apply(v)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--bg-surface-3)]"
                style={{ color: 'var(--text-primary)' }}>
                <span className="truncate">{v.name}</span>
                {canManage && (
                  <span onClick={(e) => remove(v.id, e)} title="Delete view"
                    className="shrink-0 p-1 rounded hover:bg-red-500/10 text-[var(--text-faint)] hover:text-red-400">
                    <X size={11} />
                  </span>
                )}
              </button>
            ))}
          </div>

          {canManage && (
            <div className="border-t p-2" style={{ borderColor: 'var(--border-subtle)' }}>
              {!saving ? (
                <button onClick={() => setSaving(true)}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold px-2 py-1.5 rounded-lg transition-all"
                  style={{ color: accent, background: isLight ? 'rgba(108,92,231,0.08)' : 'rgba(167,139,250,0.08)' }}>
                  <Plus size={12} /> Save current filters as a view
                </button>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <input autoFocus value={name} onChange={e => setName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && saveCurrent()}
                      placeholder="View name…" maxLength={100}
                      className="input-field h-8 text-xs flex-1" />
                    <button onClick={saveCurrent} title="Save" className="p-1.5 rounded-lg" style={{ color: accent }}>
                      <Check size={14} />
                    </button>
                    <button onClick={() => { setSaving(false); setError('') }} title="Cancel" className="p-1.5 rounded-lg" style={{ color: 'var(--text-faint)' }}>
                      <X size={14} />
                    </button>
                  </div>
                  {error && <p className="text-[11px] font-body" style={{ color: '#ef4444' }}>{error}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}