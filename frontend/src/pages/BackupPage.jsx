// pages/BackupsPage.jsx — File/folder backup: browse source, create archive, list/download/delete
//
// Talks to routes/backup.js (already mounted at /api/backup in server.js):
//   GET    /api/backup/browse?path=   — browse BACKUP_ROOT to pick a source
//   GET    /api/backup                — list backup rows, newest first
//   POST   /api/backup                — create archive (requires actionPin)
//   GET    /api/backup/:id/download   — download a completed archive
//   DELETE /api/backup/:id            — admin-only delete
import React, { useState, useEffect, useCallback } from 'react'
import {
  Archive, Folder, FileText, ChevronRight, Home, Shield, Loader2,
  Download, Trash2, RefreshCw, CheckCircle2, XCircle, Clock, HardDrive,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'
import { usePermissions } from '../hooks/usePermissions'

const FORMATS = [
  ['zip', 'ZIP'],
  ['tar', 'TAR'],
  ['tar.gz', 'TAR.GZ'],
]

function formatBytes(n) {
  if (n === null || n === undefined) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

function formatDate(secOrIso) {
  if (!secOrIso) return '—'
  const d = typeof secOrIso === 'number' ? new Date(secOrIso * 1000) : new Date(secOrIso)
  return d.toLocaleString()
}

const STATUS_META = {
  completed: { icon: CheckCircle2, color: 'text-accent-green', bg: 'bg-accent-green/10 border-accent-green/20' },
  pending:   { icon: Loader2,      color: 'text-accent-yellow', bg: 'bg-accent-yellow/10 border-accent-yellow/20' },
  failed:    { icon: XCircle,      color: 'text-accent-red',    bg: 'bg-accent-red/10 border-accent-red/20' },
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending
  const Icon = meta.icon
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${meta.bg}`}>
      <Icon size={11} className={`${meta.color} ${status === 'pending' ? 'animate-spin' : ''}`} />
      <span className={`text-xs font-mono ${meta.color}`}>{status}</span>
    </span>
  )
}

function Breadcrumbs({ path, onNavigate }) {
  const parts = path ? path.split('/').filter(Boolean) : []
  return (
    <div className="flex items-center gap-1 text-xs font-mono flex-wrap" style={{ color: 'var(--text-muted)' }}>
      <button onClick={() => onNavigate('')} className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:text-accent-green transition-colors">
        <Home size={11} /> root
      </button>
      {parts.map((p, i) => {
        const sub = parts.slice(0, i + 1).join('/')
        return (
          <React.Fragment key={sub}>
            <ChevronRight size={11} className="opacity-40" />
            <button onClick={() => onNavigate(sub)} className="px-1.5 py-0.5 rounded hover:text-accent-green transition-colors">
              {p}
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}

function BrowseRow({ item, selected, onSelect, onOpen }) {
  const isFolder = item.type === 'folder'
  return (
    <div
      onClick={() => isFolder ? onOpen(item.path) : onSelect(item)}
      onDoubleClick={() => isFolder && onOpen(item.path)}
      className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 border"
      style={selected?.path === item.path
        ? { borderColor: 'rgba(34,197,94,0.4)', background: 'rgba(34,197,94,0.08)' }
        : { borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }
      }
    >
      {isFolder
        ? <Folder size={15} className="text-accent-yellow shrink-0" />
        : <FileText size={15} className="shrink-0" style={{ color: 'var(--text-muted)' }} />}
      <span className="text-sm font-body truncate flex-1" style={{ color: 'var(--text-primary)' }}>{item.name}</span>
      {!isFolder && (
        <span className="text-xs font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>{formatBytes(item.size)}</span>
      )}
      {isFolder && <ChevronRight size={13} className="shrink-0 opacity-40" />}
    </div>
  )
}

export default function BackupsPage() {
  const { isAdmin } = usePermissions()

  const [backups, setBackups]     = useState([])
  const [loading, setLoading]     = useState(true)
  const [creating, setCreating]   = useState(false)

  const [browsePath, setBrowsePath] = useState('')
  const [browseItems, setBrowseItems] = useState([])
  const [browseLoading, setBrowseLoading] = useState(true)
  const [selected, setSelected]   = useState(null)

  const [format, setFormat]       = useState('zip')
  const [label, setLabel]         = useState('')
  const [pin, setPin]             = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)

  const fetchBackups = useCallback(async () => {
    try {
      const { data } = await api.get('/backup')
      setBackups(data)
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to load backups') }
    finally { setLoading(false) }
  }, [])

  const fetchBrowse = useCallback(async (p) => {
    setBrowseLoading(true)
    try {
      const { data } = await api.get('/backup/browse', { params: { path: p } })
      setBrowseItems(data.items)
      setBrowsePath(data.path || '')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to browse')
    } finally { setBrowseLoading(false) }
  }, [])

  useEffect(() => { fetchBackups() }, [fetchBackups])
  useEffect(() => { fetchBrowse('') }, [fetchBrowse])

  const canSubmit = !!selected && pin.trim().length > 0 && !creating

  const handleCreate = async () => {
    if (!canSubmit) return
    setCreating(true)
    try {
      const { data } = await api.post('/backup', {
        sourcePath: selected.path,
        format,
        label: label.trim() || undefined,
        actionPin: pin,
      })
      toast.success(`Backup created — ${data.archiveName}`)
      setPin(''); setLabel(''); setSelected(null)
      fetchBackups()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Backup failed')
    } finally { setCreating(false) }
  }

  const handleDownload = (row) => {
    // Auth header is required, so route through axios (blob) rather than a bare <a href>.
    api.get(`/backup/${row.id}/download`, { responseType: 'blob' })
      .then(({ data }) => {
        const url = window.URL.createObjectURL(data)
        const a = document.createElement('a')
        a.href = url; a.download = row.archive_name
        document.body.appendChild(a); a.click(); a.remove()
        window.URL.revokeObjectURL(url)
      })
      .catch(() => toast.error('Download failed'))
  }

  const handleDelete = async () => {
    try {
      await api.delete(`/backup/${deleteTarget.id}`)
      toast.success('Backup deleted')
      setDeleteTarget(null)
      fetchBackups()
    } catch (err) { toast.error(err.response?.data?.error || 'Delete failed') }
  }

  const completed = backups.filter(b => b.status === 'completed')
  const totalBytes = completed.reduce((sum, b) => sum + (b.size_bytes || 0), 0)
  const failed = backups.filter(b => b.status === 'failed').length

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        icon={Archive}
        title="Backups"
        description="Archive files or folders from the sanctioned backup root and manage retention"
        actions={
          <button onClick={() => { fetchBackups(); fetchBrowse(browsePath) }} className="btn-ghost flex items-center gap-2">
            <RefreshCw size={14} /> Refresh
          </button>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard icon={Archive} label="Total Backups" value={backups.length}
          iconColor="text-brand-400" iconBg="bg-brand-500/10 border-brand-500/20" />
        <StatCard icon={CheckCircle2} label="Completed" value={completed.length}
          iconColor="text-accent-green" iconBg="bg-accent-green/10 border-accent-green/20" accent="text-accent-green" />
        <StatCard icon={XCircle} label="Failed" value={failed}
          iconColor="text-accent-red" iconBg="bg-accent-red/10 border-accent-red/20" accent={failed ? 'text-accent-red' : ''} />
        <StatCard icon={HardDrive} label="Stored" value={formatBytes(totalBytes)}
          iconColor="text-accent-purple" iconBg="bg-accent-purple/10 border-accent-purple/20" />

      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Browser + create */}
        <div className="lg:col-span-1 space-y-5">
          <div className="card space-y-3">
            <h2 className="text-xs font-body font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Source</h2>
            <Breadcrumbs path={browsePath} onNavigate={(p) => { fetchBrowse(p); setSelected(null) }} />
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {browseLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-9 rounded-lg animate-pulse" style={{ background: 'var(--bg-input)' }} />
                ))
              ) : browseItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 gap-2" style={{ color: 'var(--text-muted)' }}>
                  <Folder size={22} className="opacity-30" />
                  <p className="text-xs font-body">Empty directory</p>
                </div>
              ) : (
                browseItems.map(item => (
                  <BrowseRow
                    key={item.path}
                    item={item}
                    selected={selected}
                    onSelect={setSelected}
                    onOpen={(p) => { fetchBrowse(p); setSelected(null) }}
                  />
                ))
              )}
            </div>
          </div>

          <div className="card space-y-4">
            <h2 className="text-xs font-body font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Archive</h2>

            <div className="space-y-1.5">
              <label className="label">Selected source</label>
              <div className="px-3 py-2 rounded-lg text-sm font-mono truncate" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: selected ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                {selected ? selected.path : 'Click a file or folder on the left'}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="label">Format</label>
              <div className="flex gap-1.5 flex-wrap">
                {FORMATS.map(([val, lbl]) => (
                  <button key={val} onClick={() => setFormat(val)}
                    className={`chip ${format === val ? 'chip-selected' : ''}`}>{lbl}</button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="label">Label (optional)</label>
              <input className="input-field" placeholder="e.g. lab-configs"
                value={label} onChange={e => setLabel(e.target.value)} maxLength={80} />
            </div>

            <div className="space-y-1.5">
              <label className="label">Action PIN</label>
              <div className="relative">
                <Shield size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-400" />
                <input type="password" className="input-field pl-8" placeholder="Enter your action PIN"
                  value={pin} onChange={e => setPin(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && canSubmit && handleCreate()} autoComplete="off" />
              </div>
            </div>

            <button onClick={handleCreate} disabled={!canSubmit}
              className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
              {creating
                ? <><Loader2 size={15} className="animate-spin" /> Archiving…</>
                : <><Archive size={15} /> Create Backup</>}
            </button>
          </div>
        </div>

        {/* RIGHT: Backup list */}
        <div className="lg:col-span-2 card space-y-4">
          <h2 className="text-xs font-body font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Archive History</h2>

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-14 rounded-lg animate-pulse" style={{ background: 'var(--bg-input)' }} />
              ))}
            </div>
          ) : backups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2" style={{ color: 'var(--text-muted)' }}>
              <Archive size={28} className="opacity-30" />
              <p className="text-sm font-body">No backups yet</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[36rem] overflow-y-auto pr-1">
              {backups.map(b => (
                <div key={b.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-brand-500/10 border border-brand-500/20">
                    {b.source_type === 'folder' ? <Folder size={14} className="text-brand-400" /> : <FileText size={14} className="text-brand-400" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-body font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {b.archive_name || b.source_path}
                    </p>
                    <p className="text-xs font-mono truncate flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                      <Clock size={10} /> {formatDate(b.created_at)} · {b.format} · {formatBytes(b.size_bytes)} · by {b.created_by_name || 'unknown'}
                    </p>
                    {b.status === 'failed' && b.error_message && (
                      <p className="text-xs font-mono truncate text-accent-red mt-0.5">{b.error_message}</p>
                    )}
                  </div>
                  <StatusBadge status={b.status} />
                  {b.status === 'completed' && (
                    <button onClick={() => handleDownload(b)} className="p-1.5 rounded-lg transition-colors hover:text-accent-green" style={{ color: 'var(--text-muted)' }} title="Download">
                      <Download size={14} />
                    </button>
                  )}
                  {isAdmin && (
                    <button onClick={() => setDeleteTarget(b)} className="p-1.5 rounded-lg transition-colors hover:text-accent-red" style={{ color: 'var(--text-muted)' }} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ActionConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Backup"
        description={`This will permanently remove "${deleteTarget?.archive_name}" from disk.`}
        danger
      />
    </div>
  )
}
