import { create } from 'zustand'
import api from '../lib/api'

export const useAuthStore = create((set) => ({
  user: null,
  token: localStorage.getItem('nc_token'),
  isLoading: false,

  login: async (username, password) => {
    set({ isLoading: true })
    try {
      const { data } = await api.post('/auth/login', { username, password })
      if (data.requires2FA) {
        set({ isLoading: false })
        return { ok: false, requires2FA: true, mfaToken: data.mfaToken }
      }
      if (data.requiresEnrollment) {
        set({ isLoading: false })
        return { ok: false, requiresEnrollment: true, enrollToken: data.enrollToken }
      }
      const token = data.accessToken || data.token
      localStorage.setItem('nc_token', token)
      set({ user: data.user, token, isLoading: false })
      return { ok: true }
    } catch (err) {
      set({ isLoading: false })
      return { ok: false, message: err.response?.data?.error || err.response?.data?.message || 'Login failed' }
    }
  },

  // Second step of a 2FA-protected login — redeems the mfaToken from
  // login() above together with a TOTP or backup code.
  verify2FA: async (mfaToken, code) => {
    set({ isLoading: true })
    try {
      const { data } = await api.post('/auth/2fa/verify', { mfaToken, code })
      const token = data.accessToken || data.token
      localStorage.setItem('nc_token', token)
      set({ user: data.user, token, isLoading: false })
      return { ok: true, backupCodeUsed: data.backupCodeUsed, backupCodesRemaining: data.backupCodesRemaining }
    } catch (err) {
      set({ isLoading: false })
      return { ok: false, message: err.response?.data?.error || 'Verification failed' }
    }
  },

  // Admin-mandated 2FA enrollment — reached when login() returns
  // requiresEnrollment instead of requires2FA (account has no secret yet).
  // startEnrollment generates the QR/secret; confirmEnrollment verifies the
  // first code, turns 2FA on, and — since that satisfies the requirement —
  // completes the login in the same call.
  startEnrollment: async (enrollToken) => {
    try {
      const { data } = await api.post('/auth/2fa/enroll/setup', { enrollToken })
      return { ok: true, secret: data.secret, otpauthUrl: data.otpauthUrl, qrDataUrl: data.qrDataUrl }
    } catch (err) {
      return { ok: false, message: err.response?.data?.error || 'Could not start 2FA setup' }
    }
  },

  confirmEnrollment: async (enrollToken, code) => {
    set({ isLoading: true })
    try {
      const { data } = await api.post('/auth/2fa/enroll/confirm', { enrollToken, code })
      const token = data.accessToken || data.token
      localStorage.setItem('nc_token', token)
      set({ user: data.user, token, isLoading: false })
      return { ok: true, backupCodes: data.backupCodes }
    } catch (err) {
      set({ isLoading: false })
      return { ok: false, message: err.response?.data?.error || 'Verification failed' }
    }
  },

  // Used by the Google OAuth callback page — the backend redirects here with
  // the access token + user already minted, no extra API round-trip needed.
  setSession: (token, user) => {
    localStorage.setItem('nc_token', token)
    set({ user, token })
  },

  logout: async () => {
    try { await api.post('/auth/logout') } catch (_) {}
    localStorage.removeItem('nc_token')
    set({ user: null, token: null })
  },

  fetchMe: async () => {
    if (!localStorage.getItem('nc_token')) return
    try {
      const { data } = await api.get('/auth/me')
      // backend returns { user: {...} } or just the user object directly
      const user = data.user || data
      set({ user })
    } catch (_) {
      localStorage.removeItem('nc_token')
      set({ user: null, token: null })
    }
  },
}))