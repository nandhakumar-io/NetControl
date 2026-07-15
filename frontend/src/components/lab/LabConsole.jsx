// components/lab/LabConsole.jsx
// The "use" half of the lab layout feature. LabLayoutEditor lets an admin
// DESIGN a seat layout and save it; this component is what was missing —
// it renders that saved layout read-only and turns it into an actual
// control surface: click a seat to select one device, click a block header
// to select every seat in that block, click a row header to select the
// whole row, then run wake/shutdown/restart/maintenance on the selection.
// Without this, "save layout" had no purpose — there was nowhere the saved
// rows/blocks ever got used for anything.
import React, { useMemo, useState, useEffect } from 'react'
import {
  LayoutGrid, X, Zap, Power, RotateCw, ShieldAlert,
  CheckSquare, Square, MinusSquare, Pencil, MonitorX,
} from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import ActionConfirmModal from '../modals/ActionConfirmModal'

function seatKey(row, col) { return `${row}:${col}` }

export default function LabConsole({ group, devices, onClose, onEditLayout, isLight }) {
  const cfg = group?.layout_config || {}
  const rows = Array.isArray(cfg.rows) && cfg.rows.length ? cfg.rows : []
  const rowGap = Number.isFinite(cfg.rowGap) ? cfg.rowGap : 24

  const deviceBySeat = useMemo(() => {
    const m = {}
    for (const d of devices) {
      if (Number.isInteger(d.seat_row) && Number.isInteger(d.seat_col)) {
        m[seatKey(d.seat_row, d.seat_col)] = d
      }
    }
    return m
  }, [devices])

  const [selected, setSelected] = useState(new Set()) // Set of device ids
  const [actionModal, setActionModal] = useState(null) // { type }

  const toggleSeat = (deviceId) => setSelected(prev => {
    const n = new Set(prev)
    n.has(deviceId) ? n.delete(deviceId) : n.add(deviceId)
    return n
  })

  // Every device seated within [rowIdx, rowIdx] across all its blocks.
  const rowDeviceIds = (rowIdx) => {
    let running = 0
    const ids = []
    const row = rows[rowIdx]
    for (const block of row.blocks) {
      for (let i = 0; i < block.cols; i++) {
        const d = deviceBySeat[seatKey(rowIdx, running + i)]
        if (d) ids.push(d.id)
      }
      running += block.cols
    }
    return ids
  }

  const blockDeviceIds = (rowIdx, startCol, cols) => {
    const ids = []
    for (let i = 0; i < cols; i++) {
      const d = deviceBySeat[seatKey(rowIdx, startCol + i)]
      if (d) ids.push(d.id)
    }
    return ids
  }

  const toggleGroup = (ids) => setSelected(prev => {
    const allSelected = ids.length > 0 && ids.every(id => prev.has(id))
    const n = new Set(prev)
    ids.forEach(id => allSelected ? n.delete(id) : n.add(id))
    return n
  })

  const groupState = (ids) => {
    if (!ids.length) return 'none'
    const selCount = ids.filter(id => selected.has(id)).length
    if (selCount === 0) return 'none'
    if (selCount === ids.length) return 'all'
    return 'some'
  }

  const clearSelection = () => setSelected(new Set())

  const selectedDevices = devices.filter(d => selected.has(d.id))

  const executeBulkAction = async (pin) => {
    const { type } = actionModal
    const settled = await Promise.allSettled(
      selectedDevices.map(d => api.post(`/actions/${type}`, { deviceId: d.id, actionPin: pin }))
    )
    clearSelection()
    // A rejected settlement here (403 access denied, 409 under maintenance,
    // etc.) used to just disappear — flatMap only pulled from the
    // 'fulfilled' branch — so a locked device silently vanished from the
    // count instead of showing up with its actual reason. Same fix as
    // DevicesPage.jsx's executeBulkAction. Promise.allSettled preserves
    // input order, so index back into selectedDevices to know which device
    // a rejection belonged to.
    const allResults = settled.flatMap((s, i) => {
      if (s.status === 'fulfilled') return s.value.data.results || []
      const device = selectedDevices[i]
      return [{
        device: device.name, id: device.id, result: 'failure',
        details: s.reason?.response?.data?.error || s.reason?.message || 'Request failed',
      }]
    })
    const failed  = allResults.filter(r => r.result !== 'success').length
    const overall = allResults.length === 0 ? 'failure' : failed === 0 ? 'success' : failed === allResults.length ? 'failure' : 'partial'
    return { results: allResults, overall }
  }

  const bulkMaintenance = async () => {
    if (!selectedDevices.length) return
    try {
      const enabling = !selectedDevices.every(d => d.maintenance_mode)
      await api.post('/devices/bulk-maintenance', { deviceIds: selectedDevices.map(d => d.id), enabled: enabling })
      toast.success(enabling ? `${selectedDevices.length} device(s) marked under maintenance` : `${selectedDevices.length} device(s) marked OK`)
      clearSelection()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update maintenance mode')
    }
  }

  const hasLayout = rows.length > 0 && Object.keys(deviceBySeat).length > 0

  const allSeatedIds = useMemo(() => Object.values(deviceBySeat).map(d => d.id), [deviceBySeat])
  const seatedOnline  = useMemo(() => Object.values(deviceBySeat).filter(d => d.status === 'online').length, [deviceBySeat])
  const seatedOffline = allSeatedIds.length - seatedOnline
  const allState = groupState(allSeatedIds)

  // Live polling (GroupsPage refetches every 5s) can mean a selected device
  // gets deleted, moved out of the group, or unseated out from under an
  // open selection — drop it from `selected` rather than leaving a ghost
  // entry the floating action bar would still count.
  useEffect(() => {
    setSelected(prev => {
      if (!prev.size) return prev
      const liveIds = new Set(devices.map(d => d.id))
      const next = new Set([...prev].filter(id => liveIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [devices])

  // Escape clears the current selection rather than closing the console —
  // matches the "click empty space to deselect" instinct without losing
  // your place in the layout.
  useEffect(() => {
    if (!selected.size) return
    const onKey = (e) => { if (e.key === 'Escape') clearSelection() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected.size])

  return (
    <div className="rounded-2xl overflow-hidden mt-4 animate-slide-up"
      style={{ background: 'var(--bg-surface-2)', border: '1px solid rgba(168,85,247,0.25)', boxShadow: 'var(--shadow-card)' }}>

      <div style={{ height: 2, background: 'linear-gradient(90deg, #a855f7, #a78bfa)' }} />

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)' }}>
            <LayoutGrid size={16} className="text-accent-purple" />
          </div>
          <div className="min-w-0">
            <h3 className="font-display text-sm font-bold truncate" style={{ color: 'var(--text-primary)' }}>
              Lab Console — {group.name}
            </h3>
            <p className="text-[11px] mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
              {hasLayout && (
                <span className="flex items-center gap-1 shrink-0" title="Seat status refreshes automatically every few seconds">
                  <span className="relative flex w-1.5 h-1.5">
                    <span className="animate-ping absolute inline-flex w-full h-full rounded-full opacity-60" style={{ background: '#22c55e' }} />
                    <span className="relative inline-flex rounded-full w-1.5 h-1.5" style={{ background: '#22c55e' }} />
                  </span>
                  <span className="font-semibold" style={{ color: '#22c55e' }}>Live</span>
                  <span style={{ color: 'var(--text-faint)' }}>·</span>
                </span>
              )}
              {hasLayout
                ? <>
                    <span style={{ color: '#22c55e' }}>{seatedOnline} online</span>
                    {' · '}
                    <span>{seatedOffline} offline</span>
                    {' · '}
                    click a seat, block, or row to select
                  </>
                : 'Click a seat, a block header, or a row header to select — then run an action on the selection'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasLayout && (
            <button onClick={() => toggleGroup(allSeatedIds)} disabled={!allSeatedIds.length}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: allState !== 'none' ? 'rgba(168,85,247,0.15)' : 'var(--bg-surface-3)', border: `1px solid ${allState !== 'none' ? 'rgba(168,85,247,0.35)' : 'var(--border-subtle)'}`, color: allState !== 'none' ? '#c084fc' : 'var(--text-muted)' }}>
              {allState === 'all' ? <CheckSquare size={13} /> : allState === 'some' ? <MinusSquare size={13} /> : <Square size={13} />}
              Select All
            </button>
          )}
          <button onClick={onEditLayout}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all"
            style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
            <Pencil size={13} /> Edit Layout
          </button>
          <button onClick={onClose} className="p-2 rounded-xl transition-all"
            style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Legend */}
      {hasLayout && (
        <div className="flex flex-wrap items-center gap-4 px-6 py-2.5" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface-3)' }}>
          {[
            { color: '#22c55e', label: 'Online' },
            { color: '#64748b', label: 'Offline' },
            { color: '#a855f7', label: 'Selected' },
          ].map(({ color, label }) => (
            <span key={label} className="flex items-center gap-1.5 text-[10px] font-semibold" style={{ color: 'var(--text-faint)' }}>
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
              {label}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-[10px] font-semibold ml-1" style={{ color: 'var(--text-faint)' }}>
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ border: '1px dashed var(--border-mid)' }} />
            Empty seat
          </span>
        </div>
      )}

      {!hasLayout ? (
        <div className="flex flex-col items-center justify-center py-16 px-6">
          <MonitorX size={28} style={{ color: 'var(--text-faint)' }} className="mb-3" />
          <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>No seats configured yet</p>
          <p className="text-xs mb-4 text-center max-w-xs" style={{ color: 'var(--text-muted)' }}>
            Set up rows, blocks, and seat assignments first, then come back here to control them.
          </p>
          <button onClick={onEditLayout} className="btn-primary text-xs">
            <Pencil size={12} /> Set Up Layout
          </button>
        </div>
      ) : (
        <div className="p-6" style={{ paddingBottom: selected.size ? 88 : 24 }}>
          <div className="space-y-5">
            {rows.map((row, rowIdx) => {
              let running = 0
              const rIds = rowDeviceIds(rowIdx)
              const rState = groupState(rIds)
              return (
                <div key={rowIdx} className="rounded-xl p-4" style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)' }}>
                  <button onClick={() => toggleGroup(rIds)} disabled={!rIds.length}
                    className="flex items-center gap-2 mb-3 disabled:opacity-40 disabled:cursor-not-allowed"
                    title={rIds.length ? `Select all of Row ${rowIdx + 1}` : 'No devices seated in this row'}>
                    {rState === 'all' ? <CheckSquare size={13} style={{ color: '#c084fc' }} />
                      : rState === 'some' ? <MinusSquare size={13} style={{ color: '#c084fc' }} />
                      : <Square size={13} style={{ color: 'var(--text-faint)' }} />}
                    <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                      Row {rowIdx + 1} {rIds.length ? `· ${rIds.length} device${rIds.length === 1 ? '' : 's'}` : ''}
                    </span>
                  </button>

                  <div className="flex flex-wrap items-start justify-center" style={{ gap: `${row.blockGap}px` }}>
                    {row.blocks.map((block, blockIdx) => {
                      const startCol = running
                      running += block.cols
                      const bIds = blockDeviceIds(rowIdx, startCol, block.cols)
                      const bState = groupState(bIds)
                      return (
                        <div key={blockIdx} className="flex flex-col items-center gap-1.5">
                          <button onClick={() => toggleGroup(bIds)} disabled={!bIds.length}
                            className="flex items-center gap-1 text-[10px] disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{ color: 'var(--text-faint)' }}
                            title={bIds.length ? 'Select this block' : 'No devices seated in this block'}>
                            {bState === 'all' ? <CheckSquare size={10} style={{ color: '#c084fc' }} />
                              : bState === 'some' ? <MinusSquare size={10} style={{ color: '#c084fc' }} />
                              : <Square size={10} />}
                            Block {blockIdx + 1}
                          </button>

                          <div className="flex" style={{ gap: `${row.gap}px` }}>
                            {Array.from({ length: block.cols }).map((_, localIdx) => {
                              const col = startCol + localIdx
                              const device = deviceBySeat[seatKey(rowIdx, col)]
                              const online = device?.status === 'online'
                              const isSel = device && selected.has(device.id)
                              return (
                                <button key={col}
                                  onClick={() => device && toggleSeat(device.id)}
                                  disabled={!device}
                                  title={device ? `${device.name} — ${device.status}${device.maintenance_mode ? ' · maintenance' : ''}` : `Row ${rowIdx + 1}, Seat ${col + 1} — empty`}
                                  className="w-11 h-11 rounded-t-lg flex flex-col items-center justify-center text-[9px] font-mono font-semibold transition-all shrink-0 disabled:cursor-default enabled:hover:scale-[1.08] enabled:hover:brightness-110"
                                  style={{
                                    background: device
                                      ? (isSel ? 'rgba(168,85,247,0.22)' : online ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.12)')
                                      : 'var(--bg-surface-2)',
                                    border: `1.5px solid ${device
                                      ? (isSel ? '#a855f7' : online ? 'rgba(34,197,94,0.4)' : 'var(--border-mid)')
                                      : 'var(--border-subtle)'}`,
                                    borderBottom: device ? `3px solid ${isSel ? '#a855f7' : online ? '#22c55e' : '#64748b'}` : '3px solid var(--border-subtle)',
                                    color: device ? (isSel ? '#c084fc' : online ? '#22c55e' : 'var(--text-muted)') : 'var(--text-faint)',
                                  }}>
                                  {device
                                    ? <span className="truncate max-w-[38px] px-0.5">{device.name.slice(0, 6)}</span>
                                    : <span className="opacity-30">—</span>}
                                  <span className="opacity-50" style={{ fontSize: 7 }}>{col + 1}</span>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Floating selection bar */}
      {selected.size > 0 && (
        <div className="sticky bottom-0 left-0 right-0 flex items-center gap-2 px-6 py-3 animate-slide-up"
          style={{ background: isLight ? '#fff' : 'var(--bg-surface-1)', borderTop: '1px solid rgba(168,85,247,0.3)', boxShadow: '0 -8px 24px rgba(0,0,0,0.15)' }}>
          <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--text-primary)' }}>
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button onClick={() => setActionModal({ type: 'wake' })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e' }}>
              <Zap size={12} /> Wake
            </button>
            <button onClick={() => setActionModal({ type: 'shutdown' })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>
              <Power size={12} /> Shutdown
            </button>
            <button onClick={() => setActionModal({ type: 'restart' })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24' }}>
              <RotateCw size={12} /> Restart
            </button>
            <button onClick={bulkMaintenance}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
              <ShieldAlert size={12} /> Maintenance
            </button>
            <button onClick={clearSelection}
              className="p-1.5 rounded-lg transition-all" style={{ color: 'var(--text-faint)' }}>
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <ActionConfirmModal
        open={!!actionModal}
        onClose={() => setActionModal(null)}
        onConfirm={executeBulkAction}
        title={actionModal ? `${actionModal.type.charAt(0).toUpperCase() + actionModal.type.slice(1)} — ${selectedDevices.length} device(s)` : ''}
        description={`This will ${actionModal?.type} ${selectedDevices.length} selected device(s). Enter your action PIN.`}
        danger={actionModal?.type !== 'wake'}
      />
    </div>
  )
}