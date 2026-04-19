import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, Loader2, ShieldCheck, Eye, EyeOff } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import toast from 'react-hot-toast'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const { login, isLoading, token } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    if (token) navigate('/dashboard', { replace: true })
  }, [token])

  // Show reason if redirected here by the api interceptor (e.g. account disabled)
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('reason')
    if (reason) setError(decodeURIComponent(reason))
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!username.trim() || !password.trim()) {
      setError('Username and password required')
      return
    }
    setError('')
    const result = await login(username, password)
    if (result.ok) {
      toast.success('Welcome back')
      navigate('/dashboard', { replace: true })
    } else {
      setError(result.message)
    }
  }

  return (
    <div className="min-h-screen grid-bg flex items-center justify-center p-4">
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-brand-500/8 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-sm animate-slide-up">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-brand-500/15 border border-brand-500/30 flex items-center justify-center mb-4 animate-glow">
            <Zap size={28} className="text-brand-400" />
          </div>
          <h1 className="font-display text-2xl text-white">NetControl</h1>
          <p className="text-sm text-slate-400 font-body mt-1">Institution Power Management</p>
        </div>

        <div className="glass rounded-2xl border border-white/10 overflow-hidden">
          <div className="h-0.5 bg-gradient-to-r from-transparent via-brand-500 to-transparent opacity-60" />

          <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
            <div>
              <label className="label">Username</label>
              <input
                type="text"
                className="input-field"
                placeholder="admin"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </div>
            <div>
              <label className="label">Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  className="input-field pr-10"
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="px-3 py-2 rounded-lg bg-accent-red/10 border border-accent-red/20">
                <p className="text-xs text-accent-red font-body">{error}</p>
              </div>
            )}

            <button
              type="submit"
              className="btn-primary w-full justify-center mt-1"
              disabled={isLoading}
            >
              {isLoading ? <Loader2 size={14} className="animate-spin" /> : null}
              {isLoading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div className="px-6 pb-5 flex items-center gap-2">
            <ShieldCheck size={14} className="text-slate-500 shrink-0" />
            <p className="text-xs text-slate-500 font-body">
              All power actions require a secondary action PIN. Sessions expire after 8 hours.
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-slate-600 font-body mt-6">
          NetControl v1.0 — Restricted access. Unauthorised use is prohibited.
        </p>
      </div>
    </div>
  )
}
