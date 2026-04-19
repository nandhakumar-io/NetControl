import React, { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { useAuthStore } from './store/authStore'
import { useThemeStore } from './store/themeStore'
import { usePermissions } from './hooks/usePermissions'
import Layout          from './components/layout/Layout'
import LoginPage       from './pages/LoginPage'
import DashboardPage   from './pages/DashboardPage'
import DevicesPage     from './pages/DevicesPage'
import GroupsPage      from './pages/GroupsPage'
import SchedulesPage   from './pages/SchedulesPage'
import AuditPage       from './pages/AuditPage'
import TerminalPage    from './pages/TerminalPage'
import RemoteAccessPage from './pages/RemoteAccessPage'
import FilePushPage    from './pages/FilePushPage'
import UsersPage       from './pages/UsersPage'
import MonitoringPage  from './pages/MonitoringPage'
import AlertsPage      from './pages/AlertsPage'

// ── Guards ────────────────────────────────────────────────────────────────────

function RequireAuth({ children }) {
  const token = localStorage.getItem('nc_token')
  if (!token) return <Navigate to="/login" replace />
  return children
}

/**
 * RequireRole — wraps a route and redirects to /dashboard if the current
 * user's role isn't in the allowed list.
 */
function RequireRole({ roles, children }) {
  const user = useAuthStore(s => s.user)
  // While user is still loading (null), render nothing to avoid flash
  if (user === null) return null
  if (!roles.includes(user?.role)) return <Navigate to="/dashboard" replace />
  return children
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const fetchMe = useAuthStore(s => s.fetchMe)
  const { theme, applyTheme } = useThemeStore()
  const isLight = theme === 'light'

  useEffect(() => { fetchMe() }, [])
  useEffect(() => { applyTheme(theme) }, [])

  return (
    <BrowserRouter>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: isLight ? '#ffffff' : '#1a1a2e',
            color:      isLight ? '#1a1a2e' : '#e2e8f0',
            border:     isLight ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(255,255,255,0.08)',
            fontFamily: 'DM Sans, sans-serif',
            fontSize:   '14px',
          },
          success: { iconTheme: { primary: '#22c55e', secondary: isLight ? '#fff' : '#09090f' } },
          error:   { iconTheme: { primary: '#ef4444', secondary: isLight ? '#fff' : '#09090f' } },
        }}
      />
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        {/* Terminal opens in a new tab — outside the main Layout */}
        <Route
          path="/terminal/:deviceId"
          element={<RequireAuth><TerminalPage /></RequireAuth>}
        />

        {/* Main app */}
        <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"     element={<DashboardPage />} />
          <Route path="devices"       element={<DevicesPage />} />
          <Route path="groups"        element={<GroupsPage />} />
          <Route path="remote-access" element={<RemoteAccessPage />} />
          <Route path="file-push"     element={<FilePushPage />} />
          <Route path="schedules"     element={<SchedulesPage />} />
          <Route path="audit"         element={<AuditPage />} />
          <Route path="monitoring"     element={<MonitoringPage />} />
          <Route path="alerts"          element={<AlertsPage />} />

          {/* Admin-only routes */}
          <Route
            path="users"
            element={
              <RequireRole roles={['admin']}>
                <UsersPage />
              </RequireRole>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
