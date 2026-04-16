import React, { useState, useEffect, useCallback } from 'react'
import {
  Monitor, Plus, Search, Zap, Power, RotateCcw,
  LayoutGrid, LayoutList, Server, CheckSquare, Square, ChevronDown, ChevronRight,
  Upload
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import DeviceCard from '../components/ui/DeviceCard'
import DeviceModal from '../components/modals/DeviceModal'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'
import FilePushModal from '../components/modals/FilePushModal'

// ── Status helpers ───────────────────────────────────────────────────────────
const STATUS_DOT = {
  online:  'status-dot-online',
  offline: 'status-dot-offline',
  unknown: 'status-dot-unknown',
  error:   'status-dot-error',
}
const STATUS_COLOR = {
  online:  'text-accent-green',
  offline: 'text-slate-500',
  unknown: 'text-accent-yellow',
  error:   'text-accent-red',
}

// ── Skeleton loaders ─────────────────────────────────────────────────────────
function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="glass rounded-xl border border-white/8 p-4 animate-pulse space-y-3">
          <div className="flex gap-3 items-center">
            <div className="w-9 h-9 rounded-lg bg-surface-4" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-surface-4 rounded w-3/4" />
              <div className="h-2.5 bg-surface-4 rounded w-1/2" />
            </div>
          </div>
          <div className="h-2.5 bg-surface-4 rounded w-1/3" />
          <div className="flex gap-1.5">
            {[1,2,3].map(j => <div key={j} className="flex-1 h-7 bg-surface-4 rounded-lg" />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="glass rounded-xl border border-white/8 overflow-hidden">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4 border-b border-white/5 animate-pulse">
          <div className="w-8 h-8 rounded-lg bg-surface-4 shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 bg-surface-4 rounded w-1/4" />
            <div className="h-2.5 bg-surface-4 rounded w-1/3" />
          </div>
          <div className="h-2.5 bg-surface-4 rounded w-20 hidden md:block" />
          <div className="h-2.5 bg-surface-4 rounded w-28 hidden lg:block" />
          <div className="h-5 bg-surface-4 rounded-full w-16 hidden sm:block" />
          <div className="h-5 bg-surface-4 rounded-full w-16" />
        </div>
      ))}
    </div>
  )
}

// ── Group section (grid) ─────────────────────────────────────────────────────
function GroupSection({ groupName, devices, selectedIds, onSelect, onWake, onShutdown, onRestart, onEdit, onDelete }) {
  const [open, setOpen] = useState(true)
  const online  = devices.filter(d => d.status === 'online').length
  const total   = devices.length
  const allSel  = devices.every(d => selectedIds.has(d.id))

  const toggleSelectAll = (e) => {
    e.stopPropagation()
    devices.forEach(d => onSelect(d.id, !allSel))
  }

  return (
    <div className="mb-6">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 mb-3 group">
        <span className="text-slate-600 group-hover:text-slate-400 transition-colors">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-xs font-body font-semibold text-slate-400 uppercase tracking-widest">{groupName}</span>
        <span className="text-[10px] font-mono text-slate-600 ml-1">{online}/{total} online</span>
        <div className="flex-1 max-w-[80px] h-1 rounded-full bg-surface-4 overflow-hidden">
          <div
            className="h-full rounded-full bg-accent-green/60 transition-all duration-500"
            style={{ width: total ? `${(online / total) * 100}%` : '0%' }}
          />
        </div>
        <button
          onClick={toggleSelectAll}
          className="ml-auto text-[10px] font-body text-slate-600 hover:text-slate-300 flex items-center gap-1 transition-colors"
        >
          {allSel
            ? <CheckSquare size={12} className="text-brand-400" />
            : <Square size={12} />
          }
          <span className="hidden sm:inline">Select all</span>
        </button>
      </button>

      {open && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {devices.map(device => (
            <DeviceCard
              key={device.id}
              device={device}
              selected={selectedIds.has(device.id)}
              onSelect={(id) => onSelect(id, !selectedIds.has(id))}
              onWake={onWake}
              onShutdown={onShutdown}
              onRestart={onRestart}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── List row ─────────────────────────────────────────────────────────────────
function DeviceListRow({ device, group, selected, onSelect, onWake, onShutdown, onRestart, onEdit, onDelete }) {
  const status = device.status || 'unknown'
  return (
    <div
      className={`grid items-center gap-3 px-5 py-3.5 transition-colors group cursor-pointer
        ${selected ? 'bg-brand-500/8 border-l-2 border-brand-500' : 'hover:bg-surface-3/50 border-l-2 border-transparent'}
      `}
      style={{ gridTemplateColumns: '32px auto 1fr 150px 150px 110px 100px auto' }}
      onClick={() => onSelect(device.id, !selected)}
    >
      <div className="flex items-center justify-center" onClick={e => e.stopPropagation()}>
        <button onClick={() => onSelect(device.id, !selected)} className="text-slate-600 hover:text-brand-400 transition-colors">
          {selected ? <CheckSquare size={14} className="text-brand-400" /> : <Square size={14} />}
        </button>
      </div>

      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0
        ${device.os_type === 'windows'
          ? 'bg-accent-cyan/10 border border-accent-cyan/20'
          : 'bg-accent-green/10 border border-accent-green/20'
        }`}>
        {device.os_type === 'windows'
          ? <Server size={14} className="text-accent-cyan" />
          : <Monitor size={14} className="text-accent-green" />
        }
      </div>

      <div className="min-w-0">
        <p className="text-sm font-body font-medium text-slate-200 truncate">{device.name}</p>
        {group && <p className="text-xs text-slate-500 truncate font-body">{group.name}</p>}
      </div>

      <p className="text-xs font-mono text-slate-400 truncate">{device.ip_address}</p>
      <p className="text-xs font-mono text-slate-600 truncate">{device.mac_address}</p>

      <span className={`text-xs font-body font-medium capitalize px-2 py-0.5 rounded-full w-fit
        ${device.os_type === 'windows'
          ? 'bg-accent-cyan/10 text-accent-cyan'
          : 'bg-accent-green/10 text-accent-green'
        }`}>
        {device.os_type}
      </span>

      <div className="flex items-center gap-1.5">
        <span className={STATUS_DOT[status]} />
        <span className={`text-xs font-body capitalize ${STATUS_COLOR[status]}`}>{status}</span>
      </div>

      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
        <button onClick={() => onWake(device)} title="Wake"
          className="p-1.5 rounded-lg hover:bg-accent-green/15 text-slate-500 hover:text-accent-green transition-all">
          <Zap size={13} />
        </button>
        <button onClick={() => onShutdown(device)} title="Shutdown"
          className="p-1.5 rounded-lg hover:bg-accent-red/15 text-slate-500 hover:text-accent-red transition-all">
          <Power size={13} />
        </button>
        <button onClick={() => onRestart(device)} title="Restart"
          className="p-1.5 rounded-lg hover:bg-accent-yellow/15 text-slate-500 hover:text-accent-yellow transition-all">
          <RotateCcw size={13} />
        </button>
        <button onClick={() => onEdit(device)} title="Edit"
          className="p-1.5 rounded-lg hover:bg-brand-500/15 text-slate-500 hover:text-brand-400 transition-all">
          <Monitor size={13} />
        </button>
      </div>
    </div>
  )
}

// ── Bulk action bar ───────────────────────────────────────────────────────────
function BulkActionBar({ count, onWakeAll, onShutdownAll, onRestartAll, onPushFile, onClear }) {
  if (count === 0) return null
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 animate-slide-up">
      <div className="flex items-center gap-2 px-4 py-2.5 glass rounded-2xl border border-white/15 shadow-2xl shadow-black/40">
        <span className="text-xs font-body font-medium text-slate-300">
          <span className="text-brand-400 font-semibold">{count}</span> selected
        </span>
        <div className="w-px h-4 bg-white/10" />
        <button onClick={onWakeAll}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent-green/15 hover:bg-accent-green/25 border border-accent-green/25 text-accent-green text-xs font-body font-medium transition-all">
          <Zap size={11} /> Wake All
        </button>
        <button onClick={onShutdownAll}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent-red/15 hover:bg-accent-red/25 border border-accent-red/25 text-accent-red text-xs font-body font-medium transition-all">
          <Power size={11} /> Shutdown
        </button>
        <button onClick={onRestartAll}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-accent-yellow/15 hover:bg-accent-yellow/25 border border-accent-yellow/25 text-accent-yellow text-xs font-body font-medium transition-all">
          <RotateCcw size={11} /> Restart
        </button>
        {/* Push File button */}
        <button onClick={onPushFile}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all text-xs font-body font-medium"
          style={{
            backgroundColor: 'rgba(14,165,233,0.12)',
            border: '1px solid rgba(14,165,233,0.25)',
            color: '#38bdf8',
          }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(14,165,233,0.22)' }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'rgba(14,165,233,0.12)' }}
        >
          <Upload size={11} /> Push File
        </button>
        <div className="w-px h-4 bg-white/10" />
        <button onClick={onClear}
          className="text-xs font-body text-slate-500 hover:text-slate-300 transition-colors px-1">
          Clear
        </button>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function DevicesPage() {
  const [devices, setDevices]         = useState([])
  const [groups, setGroups]           = useState([])
  const [loading, setLoading]         = useState(true)
  const [search, setSearch]           = useState('')
  const [osFilter, setOsFilter]       = useState('all')
  const [viewMode, setViewMode]       = useState('grid')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [deviceModal, setDeviceModal] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [actionModal, setActionModal]   = useState(null)
  const [groupFilter, setGroupFilter]   = useState('all')
  const [filePushOpen, setFilePushOpen] = useState(false)

  const fetchAll = useCallback(async () => {
    try {
      const [d, g] = await Promise.all([api.get('/devices'), api.get('/groups')])
      setDevices(d.data)
      setGroups(g.data)
    } catch {
      toast.error('Failed to load devices')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleSelect = (id, selected) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      selected ? next.add(id) : next.delete(id)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const handleAction = (type, device) => setActionModal({ type, device })

  const executeAction = async (pin) => {
    const { type, device } = actionModal
    await api.post(`/actions/${type}`, { device_id: device.id, action_pin: pin })
    toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} sent to ${device.name}`)
  }

  const bulkAction = (type) => {
    const targets = devices.filter(d => selectedIds.has(d.id))
    if (!targets.length) return
    setActionModal({ type, device: { name: `${targets.length} devices`, id: '__bulk__' }, bulk: targets })
  }

  const executeBulkAction = async (pin) => {
    const { type, bulk } = actionModal
    await Promise.allSettled(
      bulk.map(d => api.post(`/actions/${type}`, { device_id: d.id, action_pin: pin }))
    )
    toast.success(`${type} sent to ${bulk.length} devices`)
    clearSelection()
  }

  const handleDelete = async () => {
    try {
      await api.delete(`/devices/${deleteTarget.id}`)
      toast.success('Device removed')
      setDeleteTarget(null)
      fetchAll()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed')
    }
  }

  const filtered = devices.filter(d => {
    const q = search.toLowerCase()
    const matchSearch = !q ||
      d.name.toLowerCase().includes(q) ||
      d.ip_address.includes(q) ||
      (d.mac_address || '').toLowerCase().includes(q)
    const matchOs    = osFilter === 'all' || d.os_type === osFilter
    const matchGroup = groupFilter === 'all' || d.group_id === groupFilter
    return matchSearch && matchOs && matchGroup
  })

  const grouped = (() => {
    const map = new Map()
    map.set('ungrouped', { name: 'Ungrouped', devices: [] })
    groups.forEach(g => map.set(g.id, { name: g.name, devices: [] }))
    filtered.forEach(d => {
      const key = d.group_id && map.has(d.group_id) ? d.group_id : 'ungrouped'
      map.get(key).devices.push(d)
    })
    return [...map.entries()]
      .filter(([, v]) => v.devices.length > 0)
      .map(([id, v]) => ({ id, ...v }))
  })()

  const onlineCount  = devices.filter(d => d.status === 'online').length
  const offlineCount = devices.filter(d => d.status === 'offline').length

  return (
    <div className="p-6 max-w-[1600px] mx-auto animate-fade-in pb-28">
      <PageHeader
        icon={Monitor}
        title="Devices"
        description="Manage all registered computers"
        actions={
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 border border-white/6 mr-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
              <span className="text-xs font-body text-slate-400">{onlineCount} online</span>
              <span className="text-slate-700 mx-1">·</span>
              <span className="w-1.5 h-1.5 rounded-full bg-slate-600" />
              <span className="text-xs font-body text-slate-400">{offlineCount} offline</span>
            </div>
            {/* Push File button in header (always visible, no selection needed) */}
            <button
              onClick={() => setFilePushOpen(true)}
              className="btn-ghost"
            >
              <Upload size={14} /> Push File
            </button>
            <button onClick={() => setDeviceModal('add')} className="btn-primary">
              <Plus size={14} /> Add Device
            </button>
          </div>
        }
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <div className="relative min-w-[200px] flex-1 max-w-sm">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            className="input-field pl-8 h-9 text-sm"
            placeholder="Search name, IP, MAC…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="flex gap-1.5">
          {['all', 'linux', 'windows'].map(os => (
            <button
              key={os}
              onClick={() => setOsFilter(os)}
              className={`chip h-9 px-3 text-xs ${osFilter === os ? 'chip-selected' : ''}`}
            >
              {os === 'all' ? 'All OS' : os.charAt(0).toUpperCase() + os.slice(1)}
            </button>
          ))}
        </div>

        {groups.length > 0 && (
          <select
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
            className="input-field h-9 text-xs py-0 max-w-[140px]"
          >
            <option value="all">All Groups</option>
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        )}

        <div className="flex-1" />
        <span className="text-xs text-slate-500 font-body">{filtered.length} of {devices.length} devices</span>

        <div className="flex gap-0.5 p-0.5 rounded-lg bg-surface-3 border border-white/6">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-surface-5 text-white' : 'text-slate-500 hover:text-slate-300'}`}
            title="Grid view"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-surface-5 text-white' : 'text-slate-500 hover:text-slate-300'}`}
            title="List view"
          >
            <LayoutList size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        viewMode === 'grid' ? <GridSkeleton /> : <ListSkeleton />
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 animate-fade-in">
          <div className="w-14 h-14 rounded-2xl bg-surface-3 border border-white/6 flex items-center justify-center mb-4">
            <Monitor size={24} className="text-slate-600" />
          </div>
          <p className="text-slate-400 font-body text-sm mb-1">
            {search || osFilter !== 'all' || groupFilter !== 'all'
              ? 'No devices match your filters'
              : 'No devices added yet'}
          </p>
          <p className="text-slate-600 font-body text-xs mb-5">
            {search || osFilter !== 'all' ? 'Try adjusting your search or filters' : 'Add your first device to get started'}
          </p>
          {!search && osFilter === 'all' && groupFilter === 'all' && (
            <button onClick={() => setDeviceModal('add')} className="btn-primary">
              <Plus size={14} /> Add your first device
            </button>
          )}
        </div>

      ) : viewMode === 'grid' ? (
        <div className="animate-fade-in">
          {grouped.map(({ id, name, devices: groupDevices }) => (
            <GroupSection
              key={id}
              groupName={name}
              devices={groupDevices}
              selectedIds={selectedIds}
              onSelect={handleSelect}
              onWake={d => handleAction('wake', d)}
              onShutdown={d => handleAction('shutdown', d)}
              onRestart={d => handleAction('restart', d)}
              onEdit={d => setDeviceModal(d)}
              onDelete={d => setDeleteTarget(d)}
            />
          ))}
        </div>

      ) : (
        <div className="glass rounded-xl border border-white/8 overflow-hidden animate-fade-in">
          <div
            className="grid items-center gap-3 px-5 py-3 border-b border-white/8 bg-surface-2/60"
            style={{ gridTemplateColumns: '32px auto 1fr 150px 150px 110px 100px auto' }}
          >
            <button
              onClick={() => {
                if (selectedIds.size === filtered.length) {
                  clearSelection()
                } else {
                  setSelectedIds(new Set(filtered.map(d => d.id)))
                }
              }}
              className="text-slate-600 hover:text-brand-400 transition-colors flex items-center justify-center"
            >
              {selectedIds.size === filtered.length && filtered.length > 0
                ? <CheckSquare size={14} className="text-brand-400" />
                : <Square size={14} />
              }
            </button>
            <div />
            {['Device', 'IP Address', 'MAC Address', 'OS', 'Status', 'Actions'].map(h => (
              <span key={h} className="text-[11px] font-body font-semibold text-slate-500 uppercase tracking-wider">{h}</span>
            ))}
          </div>
          <div className="divide-y divide-white/5">
            {filtered.map(device => (
              <DeviceListRow
                key={device.id}
                device={device}
                group={groups.find(g => g.id === device.group_id)}
                selected={selectedIds.has(device.id)}
                onSelect={handleSelect}
                onWake={d => handleAction('wake', d)}
                onShutdown={d => handleAction('shutdown', d)}
                onRestart={d => handleAction('restart', d)}
                onEdit={d => setDeviceModal(d)}
                onDelete={d => setDeleteTarget(d)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      <BulkActionBar
        count={selectedIds.size}
        onWakeAll={() => bulkAction('wake')}
        onShutdownAll={() => bulkAction('shutdown')}
        onRestartAll={() => bulkAction('restart')}
        onPushFile={() => setFilePushOpen(true)}
        onClear={clearSelection}
      />

      {/* Modals */}
      <DeviceModal
        open={!!deviceModal}
        onClose={() => setDeviceModal(null)}
        onSaved={fetchAll}
        device={deviceModal !== 'add' ? deviceModal : null}
        groups={groups}
      />

      <ActionConfirmModal
        open={!!actionModal}
        onClose={() => setActionModal(null)}
        onConfirm={actionModal?.bulk ? executeBulkAction : executeAction}
        title={actionModal
          ? `${actionModal.type.charAt(0).toUpperCase() + actionModal.type.slice(1)} — ${actionModal.device?.name}`
          : ''}
        description="Enter your action PIN to authorise this command."
        danger={actionModal?.type !== 'wake'}
      />

      <ActionConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={`Delete ${deleteTarget?.name}`}
        description="This will permanently remove the device and its stored credentials. This cannot be undone."
        danger
      />

      <FilePushModal
        open={filePushOpen}
        onClose={() => setFilePushOpen(false)}
        devices={devices}
        groups={groups}
        selectedIds={selectedIds}
      />
    </div>
  )
}
