import React, { useState, useEffect, useCallback } from 'react'
import {
  LayoutDashboard, Monitor, Zap, Power, RotateCcw,
  Plus, RefreshCw, Layers, CheckSquare, Square
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import StatCard from '../components/ui/StatCard'
import DeviceCard from '../components/ui/DeviceCard'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'
import DeviceModal from '../components/modals/DeviceModal'

export default function DashboardPage() {
  const [devices, setDevices]       = useState([])
  const [groups, setGroups]         = useState([])
  const [selected, setSelected]     = useState(new Set())
  const [filterGroup, setFilterGroup] = useState('all')
  const [loading, setLoading]       = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // Modal state
  const [actionModal, setActionModal] = useState(null) // { type, target, label, danger }
  const [deviceModal, setDeviceModal] = useState(false)

  const fetchAll = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    else setRefreshing(true)
    try {
      const [devRes, grpRes] = await Promise.all([
        api.get('/devices'),
        api.get('/groups'),
      ])
      setDevices(devRes.data)
      setGroups(grpRes.data)
    } catch {
      toast.error('Failed to load devices')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Auto-refresh every 30s
  useEffect(() => {
    const t = setInterval(() => fetchAll(true), 30000)
    return () => clearInterval(t)
  }, [fetchAll])

  const toggleSelect = (id) => {
    setSelected(s => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  const selectAll = () => {
    const visible = filteredDevices.map(d => d.id)
    setSelected(new Set(visible))
  }

  const clearSelect = () => setSelected(new Set())

  const filteredDevices = filterGroup === 'all'
    ? devices
    : devices.filter(d => String(d.group_id) === filterGroup)

  // Stats
  const online  = devices.filter(d => d.status === 'online').length
  const offline = devices.filter(d => d.status === 'offline').length

  // Execute action via backend — returns results object for modal to display
  const executeAction = async (pin) => {
    const { type, target } = actionModal

    if (target === 'selected') {
      const ids = [...selected]
      const settled = await Promise.allSettled(
        ids.map(id => api.post(`/actions/${type}`, { deviceId: id, actionPin: pin }))
      )
      const results = settled.map((s, i) => {
        const dev = devices.find(d => d.id === ids[i])
        if (s.status === 'fulfilled') {
          const r = s.value.data?.results?.[0]
          return { device: dev?.name || ids[i], result: r?.result || 'success', details: r?.details || '' }
        }
        return { device: dev?.name || ids[i], result: 'failure', details: s.reason?.response?.data?.error || s.reason?.message || 'Failed' }
      })
      const succeeded = results.filter(r => r.result === 'success').length
      const overall = succeeded === results.length ? 'success' : succeeded === 0 ? 'failure' : 'partial'
      fetchAll(true)
      return { results, overall }
    } else if (target?.groupId) {
      const { data } = await api.post(`/actions/${type}`, { groupId: target.groupId, actionPin: pin })
      fetchAll(true)
      return data
    } else {
      const { data } = await api.post(`/actions/${type}`, { deviceId: target.id, actionPin: pin })
      fetchAll(true)
      return data
    }
  }

  const openAction = (type, target, label, danger = false) => {
    setActionModal({ type, target, label, danger })
  }

  const stats = [
    {
      icon: Monitor,
      label: 'Total Devices',
      value: devices.length,
      sub: 'registered machines',
      iconBg: 'bg-brand-500/15 border-brand-500/25',
      iconColor: 'text-brand-400',
    },
    {
      icon: Zap,
      label: 'Online',
      value: online,
      sub: `${devices.length ? Math.round((online / devices.length) * 100) : 0}% of fleet`,
      iconBg: 'bg-accent-green/15 border-accent-green/25',
      iconColor: 'text-accent-green',
      accent: 'text-accent-green',
    },
    {
      icon: Power,
      label: 'Offline',
      value: offline,
      sub: 'powered down',
      iconBg: 'bg-slate-500/15 border-slate-500/25',
      iconColor: 'text-slate-400',
    },
    {
      icon: Layers,
      label: 'Groups',
      value: groups.length,
      sub: 'labs configured',
      iconBg: 'bg-accent-purple/15 border-accent-purple/25',
      iconColor: 'text-accent-purple',
    },
  ]

  return (
    <div className="p-6 max-w-[1400px] mx-auto animate-fade-in">
      <PageHeader
        icon={LayoutDashboard}
        title="Dashboard"
        description="Real-time overview of all institution computers"
        actions={
          <>
            <button
              onClick={() => fetchAll(true)}
              className={`btn-ghost ${refreshing ? 'opacity-60' : ''}`}
              disabled={refreshing}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button onClick={() => setDeviceModal(true)} className="btn-primary">
              <Plus size={14} />
              Add Device
            </button>
          </>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {stats.map(s => <StatCard key={s.label} {...s} />)}
      </div>

      {/* Glow line */}
      <div className="glow-line mb-6" />

      {/* Controls bar */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Group filter chips */}
        <span
          onClick={() => setFilterGroup('all')}
          className={`chip ${filterGroup === 'all' ? 'chip-selected' : ''}`}
        >
          All Devices
        </span>
        {groups.map(g => (
          <span
            key={g.id}
            onClick={() => setFilterGroup(String(g.id))}
            className={`chip ${filterGroup === String(g.id) ? 'chip-selected' : ''}`}
          >
            {g.name}
          </span>
        ))}

        <div className="flex-1" />

        {/* Selection controls */}
        {selected.size > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-xs font-body text-slate-400">
              {selected.size} selected
            </span>
            <button onClick={() => openAction('wake', 'selected', `Wake ${selected.size} devices`)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-green/10 hover:bg-accent-green/20 border border-accent-green/25 text-accent-green text-xs font-body font-medium transition-all">
              <Zap size={12} /> Wake All
            </button>
            <button onClick={() => openAction('shutdown', 'selected', `Shutdown ${selected.size} devices`, true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-red/10 hover:bg-accent-red/20 border border-accent-red/25 text-accent-red text-xs font-body font-medium transition-all">
              <Power size={12} /> Shutdown All
            </button>
            <button onClick={() => openAction('restart', 'selected', `Restart ${selected.size} devices`, true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-yellow/10 hover:bg-accent-yellow/20 border border-accent-yellow/25 text-accent-yellow text-xs font-body font-medium transition-all">
              <RotateCcw size={12} /> Restart All
            </button>
            <button onClick={clearSelect} className="btn-ghost py-1.5 text-xs">Clear</button>
          </div>
        ) : (
          <button onClick={selectAll} className="btn-ghost text-xs py-1.5">
            <CheckSquare size={13} />
            Select All
          </button>
        )}
      </div>

      {/* Group quick-action rows */}
      {filterGroup === 'all' && groups.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
          {groups.map(g => {
            const groupDevices = devices.filter(d => d.group_id === g.id)
            const groupOnline  = groupDevices.filter(d => d.status === 'online').length
            return (
              <div key={g.id} className="glass rounded-xl p-3.5 flex items-center justify-between border border-white/8">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-accent-purple/15 border border-accent-purple/25 flex items-center justify-center">
                    <Layers size={14} className="text-accent-purple" />
                  </div>
                  <div>
                    <p className="text-sm font-body font-medium text-slate-200">{g.name}</p>
                    <p className="text-xs text-slate-500">
                      {groupOnline}/{groupDevices.length} online
                    </p>
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => openAction('wake', { groupId: g.id }, `Wake all in ${g.name}`)}
                    className="p-1.5 rounded-lg bg-accent-green/10 hover:bg-accent-green/20 border border-accent-green/20 text-accent-green transition-all"
                    title="Wake group"
                  ><Zap size={13} /></button>
                  <button
                    onClick={() => openAction('shutdown', { groupId: g.id }, `Shutdown all in ${g.name}`, true)}
                    className="p-1.5 rounded-lg bg-accent-red/10 hover:bg-accent-red/20 border border-accent-red/20 text-accent-red transition-all"
                    title="Shutdown group"
                  ><Power size={13} /></button>
                  <button
                    onClick={() => openAction('restart', { groupId: g.id }, `Restart all in ${g.name}`, true)}
                    className="p-1.5 rounded-lg bg-accent-yellow/10 hover:bg-accent-yellow/20 border border-accent-yellow/20 text-accent-yellow transition-all"
                    title="Restart group"
                  ><RotateCcw size={13} /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Device grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="glass rounded-xl p-4 animate-pulse h-44">
              <div className="flex gap-3 mb-3">
                <div className="w-9 h-9 rounded-lg bg-surface-4" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-surface-4 rounded w-3/4" />
                  <div className="h-2.5 bg-surface-4 rounded w-1/2" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filteredDevices.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-surface-3 border border-white/6 flex items-center justify-center mb-4">
            <Monitor size={28} className="text-slate-600" />
          </div>
          <p className="text-slate-400 font-body font-medium">No devices found</p>
          <p className="text-sm text-slate-600 font-body mt-1">Add a device to get started</p>
          <button onClick={() => setDeviceModal(true)} className="btn-primary mt-4">
            <Plus size={14} /> Add Device
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredDevices.map(device => (
            <DeviceCard
              key={device.id}
              device={device}
              selected={selected.has(device.id)}
              onSelect={toggleSelect}
              onWake={d => openAction('wake', d, `Wake ${d.name}`)}
              onShutdown={d => openAction('shutdown', d, `Shutdown ${d.name}`, true)}
              onRestart={d => openAction('restart', d, `Restart ${d.name}`, true)}
              onEdit={() => {}} // handled in DevicesPage
              onDelete={() => {}}
            />
          ))}
        </div>
      )}

      {/* Action confirm modal */}
      <ActionConfirmModal
        open={!!actionModal}
        onClose={() => setActionModal(null)}
        onConfirm={executeAction}
        title={actionModal?.label || ''}
        description="This action will be executed immediately and logged."
        danger={actionModal?.danger}
      />

      {/* Add device modal */}
      <DeviceModal
        open={deviceModal}
        onClose={() => setDeviceModal(false)}
        onSaved={() => fetchAll(true)}
        groups={groups}
      />
    </div>
  )
}

