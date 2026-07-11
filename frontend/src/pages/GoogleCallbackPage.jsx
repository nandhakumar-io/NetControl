import React, { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import toast from 'react-hot-toast'

/**
 * Lands here after /api/auth/google/callback redirects back with either:
 *   #token=...&user=...          — 2FA not enabled on this account, session ready
 *   #requires2FA=1&mfaToken=...  — password step (Google) succeeded but this
 *                                   account has TOTP enabled; hand off to the
 *                                   same code-entry step the local login form
 *                                   uses (LoginPage, via mfaToken in sessionStorage)
 * Always a URL fragment, never a query string — fragments aren't sent to the
 * server or logged by proxies/access logs.
 */
export default function GoogleCallbackPage() {
  const navigate = useNavigate()
  const setSession = useAuthStore(s => s.setSession)
  const handled = useRef(false)

  useEffect(() => {
    if (handled.current) return
    handled.current = true

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))

    if (hash.get('requires2FA') === '1') {
      const mfaToken = hash.get('mfaToken')
      window.history.replaceState(null, '', '/auth/callback')
      if (!mfaToken) {
        toast.error('Google sign-in did not complete')
        navigate('/login', { replace: true })
        return
      }
      // LoginPage owns the actual code-entry UI and the verify2FA() call —
      // hand it the mfaToken via sessionStorage (never in a URL it could
      // linger in) and let it pick up from there.
      sessionStorage.setItem('nc_pending_mfa_token', mfaToken)
      navigate('/login', { replace: true })
      return
    }

    if (hash.get('requiresEnrollment') === '1') {
      const enrollToken = hash.get('enrollToken')
      window.history.replaceState(null, '', '/auth/callback')
      if (!enrollToken) {
        toast.error('Google sign-in did not complete')
        navigate('/login', { replace: true })
        return
      }
      // Same idea, but for an admin-mandated 2FA account that hasn't
      // enrolled yet — LoginPage shows the QR/setup step instead.
      sessionStorage.setItem('nc_pending_enroll_token', enrollToken)
      navigate('/login', { replace: true })
      return
    }

    const token = hash.get('token')
    const userRaw = hash.get('user')

    if (!token || !userRaw) {
      toast.error('Google sign-in did not complete')
      navigate('/login', { replace: true })
      return
    }

    try {
      const user = JSON.parse(userRaw)
      setSession(token, user)
      // Clear the token out of the URL/history immediately
      window.history.replaceState(null, '', '/auth/callback')
      toast.success('Welcome back')
      navigate('/dashboard', { replace: true })
    } catch {
      toast.error('Google sign-in did not complete')
      navigate('/login', { replace: true })
    }
  }, [])

  return (
    <div className="min-h-screen grid-bg flex items-center justify-center p-4">
      <div className="flex flex-col items-center gap-3">
        <Loader2 size={22} className="animate-spin text-brand-400" />
        <p className="text-sm text-slate-400 font-body">Finishing sign-in…</p>
      </div>
    </div>
  )
}