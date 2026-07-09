import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, Loader2, Eye, EyeOff } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'
import toast from 'react-hot-toast'

// Shown instead of LoginPage when GET /api/auth/setup reports needsSetup:true
// (i.e. the `users` table is empty). Creates the first admin account and,
// optionally, an org name shown around the UI. The route this posts to
// (POST /api/auth/setup) refuses to run a second time once any user exists,
// so this page is safe to leave reachable after setup — it just won't do
// anything useful.
export default function SetupPage() {
  const [orgName, setOrgName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const { setSession } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!username.trim() || !password) {
      setError('Username and password are required')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setIsLoading(true)
    try {
      const { data } = await api.post('/auth/setup', {
        username: username.trim(),
        password,
        orgName: orgName.trim() || undefined,
      })
      setSession(data.accessToken, data.user)
      toast.success('NetControl is set up — welcome aboard')
      navigate('/dashboard', { replace: true })
    } catch (err) {
      if (err.response?.status === 403) {
        // Someone else finished setup first (or a script beat us to it) —
        // send them to the normal login screen instead of a dead end.
        toast.error('Setup was already completed. Redirecting to login…')
        navigate('/login', { replace: true })
      } else {
        setError(err.response?.data?.error || 'Setup failed')
      }
    } finally {
      setIsLoading(false)
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
          <h1 className="font-display text-2xl text-white">Welcome to NetControl</h1>
          <p className="text-sm text-slate-400 font-body mt-1 text-center">
            No admin account exists yet. Create one to get started.
          </p>
        </div>

        <div className="glass rounded-2xl border border-white/10 overflow-hidden">
          <div className="h-0.5 bg-gradient-to-r from-transparent via-brand-500 to-transparent opacity-60" />

          <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
            <div>
              <label className="label">Organization name <span className="text-slate-500">(optional)</span></label>
              <input
                type="text"
                className="input-field"
                placeholder="Acme University IT"
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="label">Admin username</label>
              <input
                type="text"
                className="input-field"
                placeholder="admin"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div>
              <label className="label">Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  className="input-field pr-10"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="new-password"
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
            <div>
              <label className="label">Confirm password</label>
              <input
                type={showPw ? 'text' : 'password'}
                className="input-field"
                placeholder="Repeat password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
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
              {isLoading ? 'Setting up...' : 'Create admin account'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-slate-600 font-body mt-6">
          This page only works once — it stops accepting requests the moment an account exists.
        </p>
      </div>
    </div>
  )
}