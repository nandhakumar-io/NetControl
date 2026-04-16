import React, { useState, useRef, useEffect } from 'react'
import { ShieldAlert, X, Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'

/**
 * ActionConfirmModal
 * Props:
 *   open        - boolean
 *   onClose     - fn
 *   onConfirm   - fn(actionPin) => Promise<{ results?: Array<{device, result, details}>, overall?: string }>
 *   title       - string
 *   description - string
 *   danger      - boolean (red theme)
 */
export default function ActionConfirmModal({ open, onClose, onConfirm, title, description, danger = false }) {
  const [pin, setPin]         = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [results, setResults] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) {
      setPin('')
      setError('')
      setResults(null)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  const handleConfirm = async () => {
    if (!pin.trim()) { setError('Action PIN is required'); return }
    setLoading(true)
    setError('')
    try {
      const res = await onConfirm(pin)
      if (res?.results && res.results.length > 0) {
        setResults(res)
        setPin('')
      } else {
        setPin('')
        onClose()
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Action failed')
    } finally {
      setLoading(false)
    }
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !results) handleConfirm()
    if (e.key === 'Escape') handleClose()
  }

  const handleClose = () => {
    setResults(null)
    setPin('')
    setError('')
    onClose()
  }

  if (!open) return null

  const succeeded = results?.results?.filter(r => r.result === 'success').length ?? 0
  const failed    = results?.results?.filter(r => r.result !== 'success').length ?? 0
  const overall   = results?.overall

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div
        className="relative z-10 w-full max-w-md animate-slide-up"
        onClick={e => e.stopPropagation()}
      >
        <div className={`
          glass rounded-2xl border overflow-hidden
          ${danger ? 'border-accent-red/25' : 'border-brand-500/25'}
        `}>
          {/* Top glow bar */}
          <div className={`h-0.5 ${
            results
              ? overall === 'success' ? 'bg-accent-green'
              : overall === 'failure' ? 'bg-accent-red'
              : 'bg-accent-yellow'
              : danger ? 'bg-accent-red' : 'bg-brand-500'
          } opacity-60`} />

          {/* Header */}
          <div className="flex items-start justify-between p-6 pb-4">
            <div className="flex items-center gap-3">
              <div className={`
                w-10 h-10 rounded-xl flex items-center justify-center
                ${results
                  ? overall === 'success' ? 'bg-accent-green/15 border border-accent-green/25'
                  : overall === 'failure' ? 'bg-accent-red/15 border border-accent-red/25'
                  : 'bg-accent-yellow/15 border border-accent-yellow/25'
                  : danger ? 'bg-accent-red/15 border border-accent-red/25' : 'bg-brand-500/15 border border-brand-500/25'
                }
              `}>
                {results
                  ? overall === 'success' ? <CheckCircle2 size={20} className="text-accent-green" />
                  : overall === 'failure' ? <XCircle size={20} className="text-accent-red" />
                  : <AlertTriangle size={20} className="text-accent-yellow" />
                  : <ShieldAlert size={20} className={danger ? 'text-accent-red' : 'text-brand-400'} />
                }
              </div>
              <div>
                <h3 className="font-display text-white text-base">
                  {results ? 'Action Results' : title}
                </h3>
                <p className="text-xs text-slate-400 font-body mt-0.5">
                  {results
                    ? `${succeeded} succeeded · ${failed} failed`
                    : description
                  }
                </p>
              </div>
            </div>
            <button onClick={handleClose} className="text-slate-500 hover:text-slate-300 transition-colors p-1">
              <X size={16} />
            </button>
          </div>

          {/* RESULTS VIEW */}
          {results ? (
            <div className="px-6 pb-6">
              {/* Summary bar — only meaningful for bulk (>1 device) */}
              {results.results.length > 1 && (
                <div className="flex gap-3 mb-4">
                  <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-accent-green/10 border border-accent-green/20">
                    <CheckCircle2 size={14} className="text-accent-green shrink-0" />
                    <span className="text-sm font-body font-medium text-accent-green">{succeeded} succeeded</span>
                  </div>
                  <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-accent-red/10 border border-accent-red/20">
                    <XCircle size={14} className="text-accent-red shrink-0" />
                    <span className="text-sm font-body font-medium text-accent-red">{failed} failed</span>
                  </div>
                </div>
              )}

              {/* Per-device breakdown */}
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {results.results.map((r, i) => (
                  <div key={i} className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border ${
                    r.result === 'success'
                      ? 'bg-accent-green/5 border-accent-green/15'
                      : 'bg-accent-red/5 border-accent-red/15'
                  }`}>
                    {r.result === 'success'
                      ? <CheckCircle2 size={14} className="text-accent-green shrink-0 mt-0.5" />
                      : <XCircle     size={14} className="text-accent-red shrink-0 mt-0.5" />
                    }
                    <div className="min-w-0">
                      <p className="text-xs font-body font-medium text-slate-200 truncate">{r.device}</p>
                      {r.details && (
                        <p className={`text-[11px] font-body mt-0.5 truncate ${
                          r.result === 'success' ? 'text-slate-500' : 'text-accent-red/70'
                        }`}>{r.details}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <button onClick={handleClose} className="btn-primary w-full justify-center mt-5">
                Done
              </button>
            </div>

          ) : (
            /* CONFIRM VIEW */
            <>
              <div className="mx-6 mb-4 px-3 py-2.5 rounded-lg bg-surface-3 border border-white/6">
                <p className="text-xs text-slate-400 font-body leading-relaxed">
                  <span className="text-slate-300 font-medium">Security check:</span> Enter your action PIN to authorise this operation. This is logged in the audit trail.
                </p>
              </div>

              <div className="px-6 pb-6">
                <label className="label">Action PIN</label>
                <input
                  ref={inputRef}
                  type="password"
                  value={pin}
                  onChange={e => { setPin(e.target.value); setError('') }}
                  onKeyDown={handleKey}
                  placeholder="Enter your action PIN"
                  className={`input-field ${error ? 'border-accent-red/50 focus:border-accent-red/70' : ''}`}
                  autoComplete="off"
                />
                {error && <p className="text-xs text-accent-red mt-2 font-body">{error}</p>}

                <div className="flex gap-3 mt-5">
                  <button onClick={handleClose} className="btn-ghost flex-1 justify-center" disabled={loading}>
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirm}
                    disabled={loading || !pin.trim()}
                    className={`
                      flex-1 justify-center flex items-center gap-2 font-body font-medium px-4 py-2 rounded-lg transition-all duration-200 text-sm
                      ${danger
                        ? 'bg-accent-red/20 hover:bg-accent-red/30 text-accent-red border border-accent-red/30 hover:border-accent-red/50 disabled:opacity-40'
                        : 'btn-primary disabled:opacity-40'
                      }
                    `}
                  >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                    {loading ? 'Executing...' : 'Confirm Action'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
