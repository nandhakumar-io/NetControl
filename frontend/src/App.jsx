import React, { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { useAuthStore } from './store/authStore'
import Layout       from './components/layout/Layout'
import LoginPage    from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import DevicesPage   from './pages/DevicesPage'
import GroupsPage    from './pages/GroupsPage'
import SchedulesPage from './pages/SchedulesPage'
import AuditPage     from './pages/AuditPage'
import TerminalPage  from './pages/TerminalPage'
import RemoteAccessPage from './pages/RemoteAccessPage'
import FilePushPage     from './pages/FilePushPage'

function RequireAuth({ children }) {
  const token = localStorage.getItem('nc_token')
  if (!token) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  const fetchMe = useAuthStore(s => s.fetchMe)
  useEffect(() => { fetchMe() }, [])

  return (
    <BrowserRouter>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background:  'var(--bg-surface-3, #1a1a2e)',
            color:       'var(--text-primary, #e2e8f0)',
            border:      '1px solid var(--border-mid, rgba(255,255,255,0.08))',
            fontFamily:  'DM Sans, sans-serif',
            fontSize:    '14px',
          },
          success: { iconTheme: { primary: '#22c55e', secondary: '#09090f' } },
          error:   { iconTheme: { primary: '#ef4444', secondary: '#09090f' } },
        }}
      />
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        {/* Terminal opens in a new tab — outside the main Layout */}
        <Route
          path="/terminal/:deviceId"
          element={
            <RequireAuth>
              <TerminalPage />
            </RequireAuth>
          }
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
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
