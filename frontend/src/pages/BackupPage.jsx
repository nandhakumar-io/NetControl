// pages/BackupsPage.jsx — File/folder backup: browse source, create archive, list/download/delete
//
// Talks to routes/backup.js (already mounted at /api/backup in server.js):
//   GET    /api/backup/devices                       — sources: local server + registered devices
//   GET    /api/backup/devices/:id/disks              — disks/mounts on a source
//   GET    /api/backup/devices/:id/browse?mount&path  — browse a directory on a source
//   GET    /api/backup/destinations                   — saved destinations (local always first)
//   POST   /api/backup/destinations                   — add S3/remote-folder destination (admin)
//   DELETE /api/backup/destinations/:id                — remove a destination (admin)
//   GET    /api/backup                                — list backup rows, newest first
//   POST   /api/backup                                — create archive (requires actionPin)
//   GET    /api/backup/:id/download                    — download a completed (local) archive
//   DELETE /api/backup/:id                              — admin-only delete
import React, { useState, useEffect, useCallback } from 'react'
import {
  Archive, Folder, FileText, ChevronRight, ChevronDown, Home, Shield, Loader2,
  Download, Trash2, RefreshCw, CheckCircle2, XCircle, Clock, HardDrive,
  Server, Plus, Cloud, CloudCog, FolderInput, HardDriveDownload, X, Settings2, Pencil,
  CalendarClock, Play, PauseCircle, PlayCircle,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'
import BackupDestinationModal from '../components/modals/BackupDestinationModal'
import ScheduleBackupModal from '../components/modals/ScheduleBackupModal'
import { usePermissions } from '../hooks/usePermissions'

const LOCAL_FORMATS = [
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

const CRON_LABELS = {
  '0 2 * * *':   'Daily at 2:00 AM',
  '0 2 * * 0':   'Weekly, Sunday 2:00 AM',
  '0 2 1 * *':   'Monthly, 1st at 2:00 AM',
  '0 */6 * * *': 'Every 6 hours',
}
function describeCron(expr) {
  return CRON_LABELS[expr] || expr
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

const DEST_TYPE_META = {
  local:         { icon: HardDriveDownload, label: 'Local' },
  s3:            { icon: Cloud,             label: 'S3' },
  azure_blob:    { icon: CloudCog,          label: 'Azure Blob' },
  remote_folder: { icon: FolderInput,       label: 'Remote folder' },
}

function destLabel(type) {
  return DEST_TYPE_META[type]?.label || type
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

function formatDiskLabel(disk) {
  if (!disk) return ''
  const used = disk.sizeBytes ? Math.round((disk.usedBytes / disk.sizeBytes) * 100) : 0
  return `${disk.mount} — ${formatBytes(disk.usedBytes)} / ${formatBytes(disk.sizeBytes)} (${used}%)`
}

function Collapsible({ title, icon: Icon, badge, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border" style={{ borderColor: 'var(--border-subtle)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-body font-semibold uppercase tracking-wide transition-colors"
        style={{ color: 'var(--text-muted)' }}
      >
        <span className="flex items-center gap-1.5">
          {Icon && <Icon size={12} />} {title}
          {badge != null && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] normal-case font-mono" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}>{badge}</span>
          )}
        </span>
        <ChevronDown size={13} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  )
}

export default function BackupsPage() {
  const { isAdmin } = usePermissions()

  const [backups, setBackups]     = useState([])
  const [loading, setLoading]     = useState(true)
  const [creating, setCreating]   = useState(false)

  // ── Source: device + disk + browse ──────────────────────────────────────
  const [devices, setDevices]         = useState([])
  const [deviceId, setDeviceId]       = useState('local')
  const [disks, setDisks]             = useState([])
  const [disksLoading, setDisksLoading] = useState(false)
  const [mount, setMount]             = useState(null)

  const [browsePath, setBrowsePath]   = useState('')
  const [browseItems, setBrowseItems] = useState([])
  const [browseLoading, setBrowseLoading] = useState(true)
  const [selected, setSelected]       = useState(null)

  // ── Destination ───────────────────────────────────────────────────────────
  const [destinations, setDestinations] = useState([])
  const [destinationId, setDestinationId] = useState(null) // null = local
  const [showDestModal, setShowDestModal] = useState(false)
  const [editingDestination, setEditingDestination] = useState(null)

  const [format, setFormat]       = useState('zip')
  const [label, setLabel]         = useState('')
  const [pin, setPin]             = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)

  // ── Scheduled backups tab ──────────────────────────────────────────────────
  const [tab, setTab] = useState('run') // 'run' | 'scheduled'
  const [schedules, setSchedules] = useState([])
  const [schedulesLoading, setSchedulesLoading] = useState(true)
  const [showScheduleModal, setShowScheduleModal] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(null)
  const [deleteScheduleTarget, setDeleteScheduleTarget] = useState(null)
  const [runningId, setRunningId] = useState(null)

  const isRemoteSource = deviceId !== 'local'

  // ── Fetchers ────────────────────────────────────────────────────────────
  const fetchBackups = useCallback(async () => {
    try {
      const { data } = await api.get('/backup')
      setBackups(data)
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to load backups') }
    finally { setLoading(false) }
  }, [])

  const fetchDevices = useCallback(async () => {
    try {
      const { data } = await api.get('/backup/devices')
      setDevices(data)
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to load devices') }
  }, [])

  const fetchDestinations = useCallback(async () => {
    try {
      const { data } = await api.get('/backup/destinations')
      setDestinations(data)
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to load destinations') }
  }, [])

  const fetchBrowse = useCallback(async (devId, mnt, p) => {
    setBrowseLoading(true)
    try {
      const { data } = await api.get(`/backup/devices/${devId}/browse`, { params: { mount: mnt || undefined, path: p } })
      setBrowseItems(data.items)
      setBrowsePath(data.path || '')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to browse')
      setBrowseItems([])
    } finally { setBrowseLoading(false) }
  }, [])

  const fetchDisks = useCallback(async (devId) => {
    setDisksLoading(true)
    try {
      const { data } = await api.get(`/backup/devices/${devId}/disks`)
      setDisks(data)
      const firstMount = data[0]?.mount ?? null
      setMount(firstMount)
      return firstMount
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to read disks')
      setDisks([])
      return null
    } finally { setDisksLoading(false) }
  }, [])

  const fetchSchedules = useCallback(async () => {
    setSchedulesLoading(true)
    try {
      const { data } = await api.get('/backup-schedules')
      setSchedules(data)
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to load schedules') }
    finally { setSchedulesLoading(false) }
  }, [])

  useEffect(() => { fetchBackups(); fetchDevices(); fetchDestinations(); fetchSchedules() }, [fetchBackups, fetchDevices, fetchDestinations, fetchSchedules])

  // When the source device changes, reload its disks, then browse the first
  // disk's root. Local server keeps working exactly as before (mount is
  // irrelevant to its browse endpoint). Devices without SSH configured
  // (most Windows/agent-managed fleets) can't be browsed yet — skip the
  // doomed network calls and show an explanatory message instead.
  useEffect(() => {
    setSelected(null)
    const dev = devices.find(d => d.id === deviceId)
    if (dev && !dev.sshCapable) {
      setDisks([]); setMount(null); setBrowseItems([]); setBrowsePath(''); setBrowseLoading(false)
      return
    }
    (async () => {
      const firstMount = await fetchDisks(deviceId)
      fetchBrowse(deviceId, firstMount, '')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, devices])

  const handleMountChange = (m) => {
    setMount(m); setSelected(null)
    fetchBrowse(deviceId, m, '')
  }

  const handleNavigate = (p) => {
    setSelected(null)
    fetchBrowse(deviceId, mount, p)
  }

  const canSubmit = !!selected && pin.trim().length > 0 && !creating && (!isRemoteSource || mount)

  const handleCreate = async () => {
    if (!canSubmit) return
    setCreating(true)
    try {
      const { data } = await api.post('/backup', {
        sourcePath: selected.path,
        deviceId: isRemoteSource ? deviceId : undefined,
        mount: isRemoteSource ? mount : undefined,
        format,
        label: label.trim() || undefined,
        destinationId: destinationId || undefined,
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
    if (row.destination_type && row.destination_type !== 'local') {
      toast.error(`This backup was written to ${destLabel(row.destination_type)} — download it from there.`)
      return
    }
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

  const handleDeleteDestination = async (dest) => {
    if (!window.confirm(`Remove destination "${dest.name}"? Existing backups already written there are unaffected.`)) return
    try {
      await api.delete(`/backup/destinations/${dest.id}`)
      toast.success('Destination removed')
      if (destinationId === dest.id) setDestinationId(null)
      fetchDestinations()
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to remove destination') }
  }

  const handleToggleSchedule = async (schedule) => {
    try {
      await api.patch(`/backup-schedules/${schedule.id}/toggle`)
      toast.success(schedule.enabled ? `"${schedule.name}" paused` : `"${schedule.name}" resumed`)
      fetchSchedules()
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to update schedule') }
  }

  const handleRunSchedule = async (schedule) => {
    setRunningId(schedule.id)
    try {
      await api.post(`/backup-schedules/${schedule.id}/run`)
      toast.success(`"${schedule.name}" started — check Archive History shortly`)
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to start backup') }
    finally { setTimeout(() => setRunningId(null), 1500) }
  }

  const handleDeleteScheduleConfirm = async (pin) => {
    try {
      await api.delete(`/backup-schedules/${deleteScheduleTarget.id}`, { data: { actionPin: pin } })
      toast.success('Schedule deleted')
      fetchSchedules()
    } catch (err) { throw err }
  }

  const completed = backups.filter(b => b.status === 'completed')
  const totalBytes = completed.filter(b => (b.destination_type || 'local') === 'local').reduce((sum, b) => sum + (b.size_bytes || 0), 0)
  const failed = backups.filter(b => b.status === 'failed').length

  const currentDisk = disks.find(d => d.mount === mount)
  const selectedDestination = destinations.find(d => d.id === destinationId) || destinations.find(d => d.id === null)

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        icon={Archive}
        title="Backups"
        description="Archive files or folders from any device, to local storage, S3, or another device"
        actions={
          <button onClick={() => { fetchBackups(); fetchDevices(); fetchDestinations(); fetchBrowse(deviceId, mount, browsePath) }} className="btn-ghost flex items-center gap-2">
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
        <StatCard icon={HardDrive} label="Stored locally" value={formatBytes(totalBytes)}
          iconColor="text-accent-purple" iconBg="bg-accent-purple/10 border-accent-purple/20" />
      </div>

      <div className="flex items-center gap-1 p-1 rounded-xl w-fit border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
        <button
          onClick={() => setTab('run')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-body font-medium transition-colors ${tab === 'run' ? 'bg-brand-500/15 text-brand-400' : ''}`}
          style={tab !== 'run' ? { color: 'var(--text-muted)' } : {}}
        >
          <Archive size={14} /> One-off Backup
        </button>
        <button
          onClick={() => setTab('scheduled')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-body font-medium transition-colors ${tab === 'scheduled' ? 'bg-brand-500/15 text-brand-400' : ''}`}
          style={tab !== 'scheduled' ? { color: 'var(--text-muted)' } : {}}
        >
          <CalendarClock size={14} /> Scheduled Backups
          {schedules.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>{schedules.length}</span>
          )}
        </button>
      </div>

      {tab === 'run' && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Source + Destination + create */}
        <div className="lg:col-span-1 space-y-5">
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-body font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Source</h2>
            </div>

            <div className="space-y-1.5">
              <label className="label flex items-center gap-1.5"><Server size={11} /> Device</label>
              <select className="input-field" value={deviceId} onChange={e => setDeviceId(e.target.value)}>
                {devices.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name}{d.ip_address ? ` (${d.ip_address})` : ''}{!d.sshCapable ? ' — no SSH access' : ''}
                  </option>
                ))}
              </select>
            </div>

            {(() => {
              const dev = devices.find(d => d.id === deviceId)
              if (dev && !dev.sshCapable) {
                return (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
                    <Server size={14} className="text-accent-yellow shrink-0 mt-0.5" />
                    <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
                      <span style={{ color: 'var(--text-primary)' }}>{dev.name}</span> doesn't have SSH credentials configured, so it can't be browsed as a backup source yet.
                      {dev.os_type === 'windows'
                        ? ' Windows devices are managed over WinRM/agent here — SSH-based backup sources currently support Linux devices only.'
                        : ' Add SSH credentials for it under Devices to use it here.'}
                    </p>
                  </div>
                )
              }
              return null
            })()}

            {(() => {
              const dev = devices.find(d => d.id === deviceId)
              if (dev && !dev.sshCapable) return null
              return (
                <Collapsible title="Browse source" icon={Folder} defaultOpen badge={selected ? '1 selected' : null}>
                  {(disksLoading || disks.length > 0) && (
                    <div className="space-y-1.5">
                      <label className="label flex items-center gap-1.5"><HardDrive size={11} /> Disk</label>
                      {disksLoading ? (
                        <div className="h-9 rounded-lg animate-pulse" style={{ background: 'var(--bg-input)' }} />
                      ) : (
                        <select className="input-field font-mono text-xs" value={mount || ''} onChange={e => handleMountChange(e.target.value)}>
                          {disks.map(d => <option key={d.mount} value={d.mount}>{formatDiskLabel(d)}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                  <Breadcrumbs path={browsePath} onNavigate={handleNavigate} />
                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
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
                          onOpen={handleNavigate}
                        />
                      ))
                    )}
                  </div>
                </Collapsible>
              )
            })()}
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
                {LOCAL_FORMATS.map(([val, lbl]) => (
                  <button key={val} onClick={() => setFormat(val)}
                    className={`chip ${format === val ? 'chip-selected' : ''}`}>{lbl}</button>
                ))}
              </div>
              {isRemoteSource && format === 'zip' && (
                <p className="text-xs font-body px-1" style={{ color: 'var(--text-muted)' }}>
                  Needs the <span className="font-mono">zip</span> package installed on the source device. If it's missing, the backup will fail with a clear error — pick TAR or TAR.GZ instead.
                </p>
              )}
            </div>


            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="label mb-0">Destination</label>
                {isAdmin && (
                  <button onClick={() => setShowDestModal(true)} className="text-xs font-body flex items-center gap-1 text-brand-400 hover:text-brand-300 transition-colors">
                    <Plus size={11} /> Add
                  </button>
                )}
              </div>
              <select className="input-field" value={destinationId || ''} onChange={e => setDestinationId(e.target.value || null)}>
                {destinations.map(d => <option key={d.id ?? 'local'} value={d.id ?? ''}>{d.name}</option>)}
              </select>
              {isAdmin && destinations.filter(d => d.id).length > 0 && (
                <Collapsible title="Manage saved destinations" icon={Settings2} defaultOpen={false} badge={destinations.filter(d => d.id).length}>
                  <div className="flex flex-wrap gap-1.5">
                    {destinations.filter(d => d.id).map(d => {
                      const meta = DEST_TYPE_META[d.type] || DEST_TYPE_META.local
                      const Icon = meta.icon
                      return (
                        <span key={d.id} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg text-xs font-mono border" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                          <Icon size={10} /> {d.name}
                          <button onClick={() => setEditingDestination(d)} className="p-0.5 rounded hover:text-brand-400 transition-colors" title="Edit"><Pencil size={10} /></button>
                          <button onClick={() => handleDeleteDestination(d)} className="p-0.5 rounded hover:text-accent-red transition-colors" title="Delete"><X size={10} /></button>
                        </span>
                      )
                    })}
                  </div>
                </Collapsible>
              )}
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
              {backups.map(b => {
                const destMeta = DEST_TYPE_META[b.destination_type || 'local']
                const DestIcon = destMeta.icon
                return (
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
                      <p className="text-xs font-mono truncate flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        <Server size={10} /> {b.device_name || 'This server'}
                        <span className="opacity-40">→</span>
                        <DestIcon size={10} /> {b.destination_name || destMeta.label}
                        {!!b.encrypted && (
                          <span className="inline-flex items-center gap-0.5 text-accent-green" title="Encrypted at rest (AES-256-GCM)">
                            <Shield size={10} /> encrypted
                          </span>
                        )}
                      </p>
                      {b.status === 'failed' && b.error_message && (
                        <p className="text-xs font-mono truncate text-accent-red mt-0.5">{b.error_message}</p>
                      )}
                    </div>
                    <StatusBadge status={b.status} />
                    {b.status === 'completed' && (b.destination_type || 'local') === 'local' && (
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
                )
              })}
            </div>
          )}
        </div>
      </div>
      )}

      {tab === 'scheduled' && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xs font-body font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Scheduled Backups</h2>
              <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>Runs on its own, tracked in Archive History alongside on-demand backups</p>
            </div>
            <button onClick={() => { setEditingSchedule(null); setShowScheduleModal(true) }} className="btn-primary flex items-center gap-2">
              <Plus size={14} /> New Schedule
            </button>
          </div>

          {schedulesLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 rounded-lg animate-pulse" style={{ background: 'var(--bg-input)' }} />
              ))}
            </div>
          ) : schedules.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2" style={{ color: 'var(--text-muted)' }}>
              <CalendarClock size={28} className="opacity-30" />
              <p className="text-sm font-body">No scheduled backups yet</p>
              <button onClick={() => { setEditingSchedule(null); setShowScheduleModal(true) }} className="text-xs font-body text-brand-400 hover:text-brand-300 transition-colors mt-1">
                Create your first schedule
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {schedules.map(s => {
                const destMeta = DEST_TYPE_META[s.destination_id ? (destinations.find(d => d.id === s.destination_id)?.type || 'local') : 'local']
                const DestIcon = destMeta.icon
                return (
                  <div key={s.id} className="flex items-center gap-3 px-3 py-3 rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', opacity: s.enabled ? 1 : 0.55 }}>
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-brand-500/10 border border-brand-500/20">
                      <CalendarClock size={16} className="text-brand-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-body font-medium truncate flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        {s.name}
                        {!s.enabled && (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wide" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>paused</span>
                        )}
                      </p>
                      <p className="text-xs font-mono truncate flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                        <Clock size={10} /> {describeCron(s.cron_expr)} · {s.format}
                      </p>
                      <p className="text-xs font-mono truncate flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        <Server size={10} /> {s.source_device_name || 'This server'}:{s.source_path}
                        <span className="opacity-40">→</span>
                        <DestIcon size={10} /> {s.destination_name || 'Local backup store'}
                      </p>
                      {s.last_run ? (
                        <p className={`text-xs font-mono truncate mt-0.5 ${s.last_status === 'failure' ? 'text-accent-red' : ''}`} style={s.last_status === 'failure' ? {} : { color: 'var(--text-muted)' }}>
                          Last run {formatDate(s.last_run)} — {s.last_status === 'failure' ? (s.last_error || 'failed') : 'success'}
                        </p>
                      ) : (
                        <p className="text-xs font-mono truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>Never run yet</p>
                      )}
                    </div>
                    <button onClick={() => handleRunSchedule(s)} disabled={runningId === s.id}
                      className="p-1.5 rounded-lg transition-colors hover:text-accent-green disabled:opacity-40" style={{ color: 'var(--text-muted)' }} title="Run now">
                      {runningId === s.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    </button>
                    <button onClick={() => handleToggleSchedule(s)} className="p-1.5 rounded-lg transition-colors hover:text-accent-yellow" style={{ color: 'var(--text-muted)' }} title={s.enabled ? 'Pause' : 'Resume'}>
                      {s.enabled ? <PauseCircle size={14} /> : <PlayCircle size={14} />}
                    </button>
                    <button onClick={() => { setEditingSchedule(s); setShowScheduleModal(true) }} className="p-1.5 rounded-lg transition-colors hover:text-brand-400" style={{ color: 'var(--text-muted)' }} title="Edit">
                      <Pencil size={14} />
                    </button>
                    {isAdmin && (
                      <button onClick={() => setDeleteScheduleTarget(s)} className="p-1.5 rounded-lg transition-colors hover:text-accent-red" style={{ color: 'var(--text-muted)' }} title="Delete">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <ActionConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Backup"
        description={`This will permanently remove "${deleteTarget?.archive_name}" ${(deleteTarget?.destination_type || 'local') === 'local' ? 'from disk' : 'from NetControl\u2019s records (the file itself stays at its destination)'}.`}
        danger
      />

      <BackupDestinationModal
        open={showDestModal || !!editingDestination}
        editing={editingDestination}
        onClose={() => { setShowDestModal(false); setEditingDestination(null) }}
        onCreated={() => fetchDestinations()}
        devices={devices}
      />

      <ScheduleBackupModal
        open={showScheduleModal}
        editing={editingSchedule}
        onClose={() => { setShowScheduleModal(false); setEditingSchedule(null) }}
        onSaved={() => fetchSchedules()}
        devices={devices}
        destinations={destinations}
      />

      <ActionConfirmModal
        open={!!deleteScheduleTarget}
        onClose={() => setDeleteScheduleTarget(null)}
        onConfirm={handleDeleteScheduleConfirm}
        title="Delete Schedule"
        description={`This will stop "${deleteScheduleTarget?.name}" from running again. Backups it already created are unaffected.`}
        danger
      />
    </div>
  )
}