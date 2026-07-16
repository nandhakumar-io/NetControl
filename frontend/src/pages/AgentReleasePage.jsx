// pages/AgentReleasePage.jsx — admin page for the agent self-update system.
//
// Talks to routes/agentRelease.js (mounted at /api/agent-release in server.js):
//   GET  /api/agent-release          — current release metadata
//   POST /api/agent-release          — upload a new build (admin only, multipart)
//
// Device-level "is this agent current" status is read off devices[].agent_version
// (routes/devices.js already returns it via `SELECT d.*`) and compared client-side
// against the current release version — same numeric x.y.z comparison the backend
// uses in services/agentRelease.js.
import React, { useState, useEffect, useCallback } from 'react'
import {
  PackageCheck, UploadCloud, Loader2, CheckCircle2, AlertTriangle,
  Clock, Hash, FileCode2, Monitor, Server, RefreshCw,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'

function compareVersions(a, b) {
  const pa = String(a || '0.0.0').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b || '0.0.0').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

function formatDate(sec) {
  if (!sec) return '—'
  return new Date(sec * 1000).toLocaleString()
}

export default function AgentReleasePage() {
  const [manifest, setManifest]   = useState(null)
  const [loading,  setLoading]    = useState(true)
  const [devices,  setDevices]    = useState([])
  const [uploading, setUploading] = useState(false)
  const [form, setForm] = useState({ file: null, version: '', notes: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [releaseRes, devicesRes] = await Promise.all([
        api.get('/agent-release').catch(err => err.response?.status === 404 ? { data: null } : Promise.reject(err)),
        api.get('/devices').catch(() => ({ data: [] })),
      ])
      setManifest(releaseRes.data)
      setDevices(Array.isArray(devicesRes.data) ? devicesRes.data : (devicesRes.data?.devices || []))
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load agent release info')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleUpload = async (e) => {
    e.preventDefault()
    if (!form.file) return toast.error('Choose the netcontrol-agent.js file to upload')
    if (!/^\d+\.\d+\.\d+$/.test(form.version)) return toast.error('Version must be in x.y.z form, e.g. 1.4.0')

    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', form.file)
      fd.append('version', form.version)
      fd.append('notes', form.notes || '')
      const { data } = await api.post('/agent-release', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setManifest(data)
      setForm({ file: null, version: '', notes: '' })
      toast.success(`Released v${data.version} — agents will pick it up on their next check-in`)
      load()
    } catch (e) {
      toast.error(e.response?.data?.error || e.response?.data?.errors?.[0]?.msg || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const currentVersion = manifest?.version || null
  const upToDate   = devices.filter(d => d.agent_version && currentVersion && compareVersions(currentVersion, d.agent_version) <= 0)
  const outdated   = devices.filter(d => d.agent_version && currentVersion && compareVersions(currentVersion, d.agent_version) > 0)
  const unknown    = devices.filter(d => !d.agent_version)

  return (
    <div>
      <PageHeader
        icon={PackageCheck}
        title="Agent Release"
        description="Publish agent updates and see which devices are running the latest build"
      />

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-faint)' }} />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Current release + fleet status */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={Hash}          label="Current Version" value={currentVersion ? `v${currentVersion}` : 'None'}
              iconBg="bg-violet-400/10 border-violet-400/20" iconColor="text-violet-400" />
            <StatCard icon={CheckCircle2}  label="Up to Date"      value={upToDate.length}
              iconBg="bg-green-400/10 border-green-400/20" iconColor="text-green-400" />
            <StatCard icon={AlertTriangle} label="Outdated"        value={outdated.length}
              iconBg="bg-amber-400/10 border-amber-400/20" iconColor="text-amber-400" />
            <StatCard icon={Clock}         label="Unknown"         value={unknown.length}
              iconBg="bg-gray-400/10 border-gray-400/20" iconColor="text-gray-400" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Upload new release */}
            <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center gap-2 mb-4">
                <UploadCloud size={16} style={{ color: 'var(--text-muted)' }} />
                <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Publish New Release</h2>
              </div>
              <form onSubmit={handleUpload} className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Agent file (netcontrol-agent.js)
                  </label>
                  <input
                    type="file" accept=".js"
                    onChange={e => setForm(f => ({ ...f, file: e.target.files?.[0] || null }))}
                    className="w-full text-sm rounded-lg px-3 py-2"
                    style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Version (x.y.z)
                  </label>
                  <input
                    type="text" placeholder="1.4.0" value={form.version}
                    onChange={e => setForm(f => ({ ...f, version: e.target.value }))}
                    className="w-full text-sm font-mono rounded-lg px-3 py-2"
                    style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Release notes (optional)
                  </label>
                  <textarea
                    rows={3} placeholder="What changed in this build..." value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    className="w-full text-sm rounded-lg px-3 py-2 resize-none"
                    style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                  />
                </div>
                <button type="submit" disabled={uploading}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all"
                  style={{ background: uploading ? 'var(--bg-surface-3)' : '#a78bfa', color: uploading ? 'var(--text-muted)' : '#1a1a2e' }}>
                  {uploading ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
                  {uploading ? 'Publishing...' : 'Publish Release'}
                </button>
              </form>
            </div>

            {/* Current release details */}
            <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <FileCode2 size={16} style={{ color: 'var(--text-muted)' }} />
                  <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Current Release</h2>
                </div>
                <button onClick={load} title="Refresh"
                  className="p-1.5 rounded-lg" style={{ color: 'var(--text-faint)' }}>
                  <RefreshCw size={14} />
                </button>
              </div>
              {manifest ? (
                <div className="space-y-3 text-sm">
                  <Row label="Version" value={`v${manifest.version}`} mono />
                  <Row label="Uploaded" value={formatDate(manifest.uploaded_at)} />
                  <Row label="SHA-256" value={manifest.sha256} mono truncate />
                  {manifest.notes && (
                    <div className="pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <p className="text-sm mb-1" style={{ color: 'var(--text-faint)' }}>Notes</p>
                      <p style={{ color: 'var(--text-primary)' }}>{manifest.notes}</p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm" style={{ color: 'var(--text-faint)' }}>
                  No release has been published yet. Upload one to start distributing agent updates.
                </p>
              )}
            </div>
          </div>

          {/* Per-device version breakdown */}
          {outdated.length > 0 && (
            <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)' }}>
              <div className="px-5 py-3.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Devices Needing an Update</h2>
              </div>
              <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                {outdated.map(d => (
                  <div key={d.id} className="flex items-center gap-3 px-5 py-3">
                    {d.os_type === 'windows' ? <Server size={14} className="text-sky-400" /> : <Monitor size={14} className="text-violet-400" />}
                    <span className="flex-1 text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</span>
                    <span className="text-sm font-mono" style={{ color: 'var(--text-faint)' }}>v{d.agent_version}</span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-sm font-semibold"
                      style={{ background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24' }}>
                      <AlertTriangle size={10} /> Update available
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, mono, truncate }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span style={{ color: 'var(--text-faint)' }}>{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${truncate ? 'truncate max-w-[220px]' : ''}`} style={{ color: 'var(--text-primary)' }} title={truncate ? value : undefined}>
        {value}
      </span>
    </div>
  )
}