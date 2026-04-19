import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 15000,
})

// Request interceptor — attach JWT
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('nc_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Response interceptor — handle 401, try refresh
let isRefreshing = false
let failedQueue = []

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => error ? prom.reject(error) : prom.resolve(token))
  failedQueue = []
}

function forceLogout(message) {
  localStorage.removeItem('nc_token')
  // Pass a message to the login page so the user knows why they were kicked out
  window.location.href = `/login?reason=${encodeURIComponent(message)}`
}

api.interceptors.response.use(
  res => res,
  async err => {
    const original = err.config
    const status   = err.response?.status
    const code     = err.response?.data?.code

    // Account disabled — hard logout immediately, no retry
    if (code === 'ACCOUNT_DISABLED' || status === 403 && err.response?.data?.error?.includes('disabled')) {
      forceLogout('Your account has been disabled. Contact your administrator.')
      return Promise.reject(err)
    }

    if (status === 401 && !original._retry && original.url !== '/auth/refresh') {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject })
        }).then(token => {
          original.headers.Authorization = `Bearer ${token}`
          return api(original)
        })
      }
      original._retry = true
      isRefreshing = true
      try {
        const { data } = await api.post('/auth/refresh')
        localStorage.setItem('nc_token', data.accessToken)
        processQueue(null, data.accessToken)
        original.headers.Authorization = `Bearer ${data.accessToken}`
        return api(original)
      } catch (refreshErr) {
        processQueue(refreshErr, null)
        // If refresh itself returned ACCOUNT_DISABLED, show the right message
        const refreshCode = refreshErr.response?.data?.code
        if (refreshCode === 'ACCOUNT_DISABLED') {
          forceLogout('Your account has been disabled. Contact your administrator.')
        } else {
          forceLogout('Session expired. Please log in again.')
        }
        return Promise.reject(refreshErr)
      } finally {
        isRefreshing = false
      }
    }
    return Promise.reject(err)
  }
)

export default api
