import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarDays, ChevronLeft, ChevronRight, Archive, TerminalSquare,
  Mail, FileBarChart2, ScrollText, AlertTriangle, RefreshCw,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'

// One entry per event "kind" the backend can return — icon, color, and the
// human label shown on each event chip. Kept in sync with the `kind`
// values routes/opsCalendar.js emits (backup / bulk_command / digest /
// sla_report / log_export).
const KIND_META = {
  backup:       { icon: Archive,       label: 'Backup',        color: '#38bdf8', bg: 'rgba(56,189,248,0.12)',  border: 'rgba(56,189,248,0.3)' },
  bulk_command: { icon: TerminalSquare,label: 'Bulk Command',  color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', border: 'rgba(167,139,250,0.3)' },
  digest:       { icon: Mail,          label: 'Digest',        color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.3)' },
  sla_report:   { icon: FileBarChart2, label: 'SLA Report',    color: '#4ade80', bg: 'rgba(74,222,128,0.12)',  border: 'rgba(74,222,128,0.3)' },
  log_export:   { icon: ScrollText,    label: 'Log Export',    color: '#fb923c', bg: 'rgba(251,146,60,0.12)',  border: 'rgba(251,146,60,0.3)' },
}

// Monday-start week, matching the digest schedule's own default cadence
// ('0 8 * * 1' = Monday) so "this week" means the same thing everywhere.
function startOfWeek(d) {
  const date = new Date(d)
  const day = date.getUTCDay()
  const diff = (day === 0 ? -6 : 1) - day // shift Sunday(0) back 6, otherwise back to Monday
  date.setUTCDate(date.getUTCDate() + diff)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

export default function OpsCalendarPage() {
  const navigate = useNavigate()
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeKinds, setActiveKinds] = useState(new Set(Object.keys(KIND_META)))

  const weekEnd = useMemo(() => {
    const d = new Date(weekStart)
    d.setUTCDate(d.getUTCDate() + 7)
    return d
  }, [weekStart])

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    try {
      const start = Math.floor(weekStart.getTime() / 1000)
      const end = Math.floor(weekEnd.getTime() / 1000)
      const { data } = await api.get('/ops-calendar', { params: { start, end } })
      setEvents(data.events || [])
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load ops calendar')
    } finally {
      setLoading(false)
    }
  }, [weekStart, weekEnd])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  const days = useMemo(() => {
    const arr = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart)
      d.setUTCDate(d.getUTCDate() + i)
      arr.push(d)
    }
    return arr
  }, [weekStart])

  const eventsByDay = useMemo(() => {
    const map = new Map()
    for (const ev of events) {
      if (!activeKinds.has(ev.kind)) continue
      const day = new Date(ev.at * 1000).toISOString().slice(0, 10)
      if (!map.has(day)) map.set(day, [])
      map.get(day).push(ev)
    }
    for (const list of map.values()) list.sort((a, b) => a.at - b.at)
    return map
  }, [events, activeKinds])

  const toggleKind = (kind) => setActiveKinds(prev => {
    const next = new Set(prev)
    next.has(kind) ? next.delete(kind) : next.add(kind)
    return next
  })

  const busyDayCount = useMemo(() => {
    const seen = new Set()
    for (const ev of events) {
      if (ev.busyDay) seen.add(new Date(ev.at * 1000).toISOString().slice(0, 10))
    }
    return seen.size
  }, [events])

  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
  const fmtDayLabel = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  const isToday = (d) => d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)

  return (
    <div className="p-4 sm:p-6 max-w-[1760px] mx-auto animate-fade-in">
      <PageHeader
        icon={CalendarDays}
        title="Ops Calendar"
        description="Every cron-scheduled system in one view — backups, bulk commands, digests, SLA reports, and log exports"
        iconColor="text-accent-cyan"
        iconBg="bg-accent-cyan/15 border-accent-cyan/25"
        actions={
          <>
            <div className="flex items-center gap-1">
              <button onClick={() => setWeekStart(d => { const n = new Date(d); n.setUTCDate(n.getUTCDate() - 7); return n })} className="btn-ghost !px-2">
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => setWeekStart(startOfWeek(new Date()))} className="btn-ghost text-sm">
                This week
              </button>
              <button onClick={() => setWeekStart(d => { const n = new Date(d); n.setUTCDate(n.getUTCDate() + 7); return n })} className="btn-ghost !px-2">
                <ChevronRight size={16} />
              </button>
            </div>
            <button onClick={fetchEvents} className="btn-ghost" disabled={loading}>
              <RefreshCw size={16} className={`text-brand-400 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </>
        }
      />

      {/* Kind filter legend — click to toggle a category on/off */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {Object.entries(KIND_META).map(([kind, meta]) => {
          const active = activeKinds.has(kind)
          const Icon = meta.icon
          return (
            <button key={kind} onClick={() => toggleKind(kind)}
              className="flex items-center gap-1.5 text-xs font-body font-medium px-2.5 py-1.5 rounded-lg transition-all"
              style={{
                background: active ? meta.bg : 'var(--bg-surface-3)',
                border: `1px solid ${active ? meta.border : 'var(--border-subtle)'}`,
                color: active ? meta.color : 'var(--text-faint)',
              }}>
              <Icon size={12} />
              {meta.label}
            </button>
          )
        })}
        {busyDayCount > 0 && (
          <span className="flex items-center gap-1.5 text-xs font-body ml-2" style={{ color: '#fbbf24' }}>
            <AlertTriangle size={12} />
            {busyDayCount} day{busyDayCount === 1 ? '' : 's'} this week with overlapping schedule types
          </span>
        )}
      </div>

      {/* Week grid */}
      <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
        {days.map(day => {
          const key = day.toISOString().slice(0, 10)
          const dayEvents = eventsByDay.get(key) || []
          const busy = dayEvents.some(e => e.busyDay)
          return (
            <div key={key} className="glass rounded-2xl p-3 min-h-[160px] flex flex-col"
              style={{
                border: isToday(day) ? '1px solid rgba(56,189,248,0.4)' : undefined,
                background: busy ? 'rgba(251,191,36,0.04)' : undefined,
              }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-body font-semibold" style={{ color: isToday(day) ? '#38bdf8' : 'var(--text-secondary)' }}>
                  {fmtDayLabel(day)}
                </span>
                {busy && <AlertTriangle size={12} style={{ color: '#fbbf24' }} />}
              </div>

              <div className="flex flex-col gap-1.5 flex-1">
                {loading ? (
                  <div className="h-4 rounded animate-pulse" style={{ background: 'var(--bg-surface-3)' }} />
                ) : dayEvents.length === 0 ? (
                  <span className="text-xs font-body" style={{ color: 'var(--text-faint)' }}>—</span>
                ) : (
                  dayEvents.map((ev, i) => {
                    const meta = KIND_META[ev.kind]
                    const Icon = meta?.icon || CalendarDays
                    return (
                      <button key={`${ev.kind}-${ev.id}-${i}`}
                        onClick={() => ev.path && navigate(ev.path)}
                        title={`${meta?.label || ev.kind}: ${ev.name} at ${fmtTime(ev.at)} UTC${!ev.path ? ' (no dedicated settings page yet — see routes/digest.js)' : ''}`}
                        className={`flex items-center gap-1.5 text-left px-2 py-1 rounded-lg text-xs font-body transition-transform ${ev.path ? 'hover:scale-[1.02] cursor-pointer' : 'cursor-default'}`}
                        style={{ background: meta?.bg, border: `1px solid ${meta?.border}`, color: meta?.color }}>
                        <Icon size={11} className="shrink-0" />
                        <span className="font-mono shrink-0">{fmtTime(ev.at)}</span>
                        <span className="truncate">{ev.name}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}