import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Monitor, Layers, Zap, Clock, Users, CornerDownLeft, Loader2, X } from 'lucide-react'
import api from '../../lib/api'

// Debounced GET /api/search — one request per pause in typing, not one per
// keystroke, so the palette doesn't hammer the API on every character while
// still feeling instant for how short these queries are.
const DEBOUNCE_MS = 200

const CATEGORY_META = {
  device:   { icon: Monitor, label: 'Devices' },
  group:    { icon: Layers,  label: 'Groups' },
  runbook:  { icon: Zap,     label: 'Runbooks' },
  schedule: { icon: Clock,   label: 'Schedules' },
  user:     { icon: Users,   label: 'Users' },
}

const STATUS_DOT = {
  online:  'bg-accent-green',
  offline: 'bg-accent-red',
  unknown: 'bg-slate-500',
}

export default function CommandPalette({ open, onClose }) {
  const [q, setQ]             = useState('')
  const [results, setResults] = useState([])   // flattened, in display order
  const [loading, setLoading] = useState(false)
  const [active, setActive]   = useState(0)
  const inputRef  = useRef(null)
  const debounceRef = useRef(null)
  const navigate  = useNavigate()

  useEffect(() => {
    if (open) {
      setQ(''); setResults([]); setActive(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  const runSearch = useCallback((value) => {
    if (!value.trim()) { setResults([]); setLoading(false); return }
    setLoading(true)
    api.get('/search', { params: { q: value } })
      .then(r => {
        const cats = r.data?.categories || {}
        // Fixed category order so results don't jump around as different
        // categories resolve at different times — devices first since
        // that's what people jump to most in a device-management tool.
        const order = ['device', 'group', 'runbook', 'schedule', 'user']
        const flat = []
        for (const type of order) {
          const key = type === 'device' ? 'devices'
            : type === 'group' ? 'groups'
            : type === 'runbook' ? 'runbooks'
            : type === 'schedule' ? 'schedules' : 'users'
          for (const item of cats[key] || []) flat.push(item)
        }
        setResults(flat)
        setActive(0)
      })
      .catch(() => setResults([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(q), DEBOUNCE_MS)
    return () => clearTimeout(debounceRef.current)
  }, [q, runSearch])

  const go = (item) => {
    if (!item) return
    onClose()
    navigate(item.path)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return }
    if (e.key === 'Enter')     { e.preventDefault(); go(results[active]); return }
  }

  if (!open) return null

  // Group flattened results back into sections for rendering, preserving
  // the fixed order runSearch already applied.
  const sections = []
  for (const item of results) {
    let section = sections.find(s => s.type === item.type)
    if (!section) { section = { type: item.type, items: [] }; sections.push(section) }
    section.items.push(item)
  }
  let rowIndex = -1

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-xl rounded-2xl border overflow-hidden animate-slide-up"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-mid)', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Search size={18} style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search devices, groups, runbooks, schedules…"
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: 'var(--text-primary)' }}
          />
          {loading && <Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-muted)' }} />}
          <button onClick={onClose} className="p-1 rounded-md hover:opacity-70" aria-label="Close">
            <X size={16} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {!q.trim() && (
            <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              Start typing to search across your organization…
            </div>
          )}

          {q.trim() && !loading && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No matches for "{q}"
            </div>
          )}

          {sections.map(section => {
            const meta = CATEGORY_META[section.type]
            const Icon = meta?.icon || Search
            return (
              <div key={section.type} className="mb-1">
                <div className="px-4 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                  {meta?.label || section.type}
                </div>
                {section.items.map(item => {
                  rowIndex += 1
                  const isActive = rowIndex === active
                  const thisRow = rowIndex
                  return (
                    <button
                      key={`${item.type}-${item.id}`}
                      onMouseEnter={() => setActive(thisRow)}
                      onClick={() => go(item)}
                      className="w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors"
                      style={{
                        background: isActive ? 'var(--bg-hover)' : 'transparent',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <Icon size={16} style={{ color: 'var(--text-secondary)' }} className="shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.status && (
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_DOT[item.status] || 'bg-slate-500'}`} />
                      )}
                      <span className="text-xs truncate max-w-[35%]" style={{ color: 'var(--text-muted)' }}>
                        {item.sublabel}
                      </span>
                      {isActive && <CornerDownLeft size={13} style={{ color: 'var(--text-faint)' }} className="shrink-0" />}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div
          className="flex items-center gap-4 px-4 py-2 border-t text-xs"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-faint)' }}
        >
          <span><kbd className="px-1 py-0.5 rounded border" style={{ borderColor: 'var(--border-mid)' }}>↑↓</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded border" style={{ borderColor: 'var(--border-mid)' }}>↵</kbd> open</span>
          <span><kbd className="px-1 py-0.5 rounded border" style={{ borderColor: 'var(--border-mid)' }}>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}