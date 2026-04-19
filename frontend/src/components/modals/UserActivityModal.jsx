import React, { useState, useEffect } from 'react'
import { X, Activity, RefreshCw, CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import api from '../../lib/api'

const RESULT_ICON = {
  success: <CheckCircle2 size={12} className="text-accent-green" />,
  failure: <XCircle      size={12} className="text-accent-red"   />,
  partial: <AlertCircle  size={12} className="text-accent-yellow"/>,
}

function formatTs(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export default function UserActivityModal({ open, onClose, user, isLight }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open && user) {
      setLoading(true)
      api.get(`/users/${user.id}/activity?limit=50`)
        .then(r => setEntries(r.data))
        .catch(() => setEntries([]))
        .finally(() => setLoading(false))
    }
  }, [open, user])

  if (!open || !user) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className={`rounded-2xl overflow-hidden
          ${isLight ? 'bg-white shadow-2xl' : 'glass border border-white/10'}`}>

          <div className={`h-0.5 ${isLight ? 'bg-[#6c5ce7]' : 'bg-brand-500 opacity-50'}`} />

          {/* Header */}
          <div className={`flex items-center justify-between px-6 py-4 border-b
            ${isLight ? 'border-black/[0.07]' : 'border-white/6'}`}>
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center
                ${isLight ? 'bg-[#6c5ce7] text-white' : 'bg-brand-500/15 border border-brand-500/25 text-brand-400'}`}>
                <Activity size={15} />
              </div>
              <div>
                <h3 className={`font-display text-sm ${isLight ? 'text-[#1a1a2e]' : 'text-white'}`}>
                  Activity — {user.username}
                </h3>
                <p className={`text-xs font-body ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                  Last 50 audit events
                </p>
              </div>
            </div>
            <button onClick={onClose} className={`p-1 ${isLight ? 'text-slate-400 hover:text-slate-700' : 'text-slate-500 hover:text-slate-300'}`}>
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="max-h-[60vh] overflow-y-auto">
            {loading ? (
              <div className="py-12 flex items-center justify-center">
                <RefreshCw size={20} className={`animate-spin ${isLight ? 'text-slate-300' : 'text-slate-600'}`} />
              </div>
            ) : entries.length === 0 ? (
              <div className="py-12 flex flex-col items-center gap-2">
                <Activity size={28} className={isLight ? 'text-slate-300' : 'text-slate-600'} />
                <p className={`text-sm font-body ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>No activity found</p>
              </div>
            ) : (
              <div className="divide-y divide-opacity-5">
                {entries.map(e => (
                  <div key={e.id} className={`flex items-start gap-3 px-5 py-3.5 transition-colors
                    ${isLight ? 'border-b border-black/[0.04] hover:bg-[#faf9ff]' : 'border-b border-white/4 hover:bg-surface-3/30'}`}>
                    <div className="mt-0.5">{RESULT_ICON[e.result] || RESULT_ICON.partial}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-body font-medium font-mono
                          ${isLight ? 'text-[#1a1a2e]' : 'text-slate-300'}`}>
                          {e.action}
                        </span>
                        {e.target_name && (
                          <span className={`text-xs font-body ${isLight ? 'text-slate-500' : 'text-slate-500'}`}>
                            → {e.target_name}
                          </span>
                        )}
                      </div>
                      {e.details && (
                        <p className={`text-[11px] font-body mt-0.5 ${isLight ? 'text-slate-400' : 'text-slate-600'}`}>
                          {e.details}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-[11px] font-body ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                        {formatTs(e.timestamp)}
                      </p>
                      {e.ip_source && (
                        <p className={`text-[10px] font-mono mt-0.5 ${isLight ? 'text-slate-300' : 'text-slate-600'}`}>
                          {e.ip_source}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

