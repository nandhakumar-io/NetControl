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
      const token = data.accessToken || data.token
      localStorage.setItem('nc_token', token)
      set({ user: data.user, token, isLoading: false })
      return { ok: true }
    } catch (err) {
      set({ isLoading: false })
      return { ok: false, message: err.response?.data?.error || err.response?.data?.message || 'Login failed' }
    }
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
