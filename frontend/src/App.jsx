import React, { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { useAuthStore } from './store/authStore'
import { useThemeStore } from './store/themeStore'
import { usePermissions } from './hooks/usePermissions'
import Layout          from './components/layout/Layout'
import LoginPage       from './pages/LoginPage'
import GoogleCallbackPage from './pages/GoogleCallbackPage'
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
import MonitoringHistoryPage from './pages/MonitoringHistoryPage'
import SecurityPage    from './pages/SecurityPage'
import AlertsPage      from './pages/AlertsPage'
import DiscoveryPage   from './pages/DiscoveryPage'
import CompliancePage  from './pages/CompliancePage'
import ProcessPoliciesPage from './pages/ProcessPoliciesPage'
import BackupsPage    from './pages/BackupsPage'

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

/**
 * RequirePermission — same idea as RequireRole, but checks a permission bit
 * instead of a fixed role list. This mirrors the bits Layout.jsx already
 * uses to decide which links to show in the sidebar, so a user who can't
 * see "Audit Log" in the nav also can't reach /audit by typing the URL.
 */
function RequirePermission({ bit, children }) {
  const user = useAuthStore(s => s.user)
  const { can } = usePermissions()
  if (user === null) return null
  if (!can(bit)) return <Navigate to="/dashboard" replace />
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
        <Route path="/auth/callback" element={<GoogleCallbackPage />} />

        {/* Terminal opens in a new tab — outside the main Layout */}
        <Route
          path="/terminal/:deviceId"
          element={<RequireAuth><TerminalPage /></RequireAuth>}
        />

        {/* Main app */}
        <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"     element={<DashboardPage />} />
          <Route path="devices"       element={<RequirePermission bit={1}><DevicesPage /></RequirePermission>} />
          <Route path="groups"        element={<RequirePermission bit={8}><GroupsPage /></RequirePermission>} />
          <Route path="remote-access" element={<RequirePermission bit={1}><RemoteAccessPage /></RequirePermission>} />
          <Route path="file-push"     element={<RequirePermission bit={1}><FilePushPage /></RequirePermission>} />
          <Route path="schedules"     element={<RequirePermission bit={32}><SchedulesPage /></RequirePermission>} />
          <Route path="audit"         element={<RequirePermission bit={128}><AuditPage /></RequirePermission>} />
          <Route path="monitoring"     element={<RequirePermission bit={1}><MonitoringPage /></RequirePermission>} />
          <Route path="monitoring/history" element={<RequirePermission bit={1}><MonitoringHistoryPage /></RequirePermission>} />
          <Route path="alerts"          element={<RequirePermission bit={1}><AlertsPage /></RequirePermission>} />
          <Route path="discovery"       element={<RequirePermission bit={1024}><DiscoveryPage /></RequirePermission>} />
          <Route path="compliance"      element={<RequirePermission bit={2048}><CompliancePage /></RequirePermission>} />
          <Route path="process-policies" element={<RequirePermission bit={4096}><ProcessPoliciesPage /></RequirePermission>} />
          <Route path="backups"          element={<RequirePermission bit={8192}><BackupsPage /></RequirePermission>} />

          {/* Admin-only routes */}
          <Route
            path="users"
            element={
              <RequireRole roles={['admin']}>
                <UsersPage />
              </RequireRole>
            }
          />
          <Route
            path="security"
            element={
              <RequireRole roles={['admin']}>
                <SecurityPage />
              </RequireRole>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}