import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, Loader2, ShieldCheck, Eye, EyeOff } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'
import toast from 'react-hot-toast'

function GoogleIcon(props) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...props}>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  )
}

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [googleEnabled, setGoogleEnabled] = useState(false)
  const [mfaToken, setMfaToken] = useState(null)
  const [code, setCode] = useState('')
  const { login, verify2FA, isLoading, token } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    if (token) navigate('/dashboard', { replace: true })
  }, [token])

  // A Google sign-in that needed a second factor hands off here via
  // sessionStorage (see GoogleCallbackPage) instead of setting a session
  // directly — this reuses the exact same code-entry form and verify2FA()
  // call as a password login, so there's only one 2FA UI to maintain.
  useEffect(() => {
    const pending = sessionStorage.getItem('nc_pending_mfa_token')
    if (pending) {
      sessionStorage.removeItem('nc_pending_mfa_token')
      setMfaToken(pending)
    }
  }, [])

  // A freshly deployed instance has no users yet — send the operator to the
  // setup wizard instead of a login form they can't possibly get through.
  useEffect(() => {
    let cancelled = false
    api.get('/auth/setup')
      .then(({ data }) => { if (!cancelled && data.needsSetup) navigate('/setup', { replace: true }) })
      .catch(() => { /* if this check fails, fall through to the normal login form */ })
    return () => { cancelled = true }
  }, [])

  // Show reason if redirected here by the api interceptor or a failed Google sign-in
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('reason')
    const oauthError = new URLSearchParams(window.location.search).get('error')
    if (reason) setError(decodeURIComponent(reason))
    else if (oauthError) setError(decodeURIComponent(oauthError))
  }, [])

  useEffect(() => {
    let cancelled = false
    const checkStatus = (retries = 2) => {
      api.get('/auth/google/status')
        .then(({ data }) => { if (!cancelled) setGoogleEnabled(!!data.enabled) })
        .catch((err) => {
          // A 429 (rate-limited) or network hiccup isn't "Google is disabled" —
          // retry briefly instead of silently hiding the button. Only a real
          // response (enabled: false) should turn it off.
          if (cancelled) return
          if (retries > 0) setTimeout(() => checkStatus(retries - 1), 1500)
          else if (err.response && err.response.status !== 429) setGoogleEnabled(false)
        })
    }
    checkStatus()
    return () => { cancelled = true }
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
    } else if (result.requires2FA) {
      setMfaToken(result.mfaToken)
    } else {
      setError(result.message)
    }
  }

  const handleVerify2FA = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!code.trim()) { setError('Enter your authentication code'); return }
    setError('')
    const result = await verify2FA(mfaToken, code.trim())
    if (result.ok) {
      if (result.backupCodeUsed) {
        toast.success(`Signed in with a backup code — ${result.backupCodesRemaining} remaining`)
      } else {
        toast.success('Welcome back')
      }
      navigate('/dashboard', { replace: true })
    } else {
      setError(result.message)
    }
  }

  const handleGoogleSignIn = () => {
    window.location.href = '/api/auth/google'
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

          {!mfaToken ? (
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
          ) : (
          <form onSubmit={handleVerify2FA} className="p-6 flex flex-col gap-4">
            <div>
              <label className="label">Authentication code</label>
              <input
                type="text"
                inputMode="numeric"
                className="input-field text-center tracking-[0.3em] font-mono"
                placeholder="000000"
                maxLength={11}
                value={code}
                onChange={e => setCode(e.target.value)}
                autoComplete="one-time-code"
                autoFocus
              />
              <p className="text-xs text-slate-500 font-body mt-2">
                Enter the 6-digit code from your authenticator app, or one of your backup codes.
              </p>
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
              {isLoading ? 'Verifying...' : 'Verify'}
            </button>
            <button
              type="button"
              onClick={() => { setMfaToken(null); setCode(''); setError('') }}
              className="text-xs text-slate-500 hover:text-slate-300 font-body text-center"
            >
              ← Back to sign in
            </button>
          </form>
          )}

          {googleEnabled && !mfaToken && (
            <div className="px-6 pb-2">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-[11px] font-body text-slate-500">or</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>
              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="w-full flex items-center justify-center gap-2.5 py-2.5 rounded-lg text-sm font-body font-medium bg-white text-[#1a1a2e] hover:bg-slate-100 transition-colors"
              >
                <GoogleIcon /> Continue with Google
              </button>
            </div>
          )}

          <div className="px-6 pt-4 pb-5 flex items-center gap-2">
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
