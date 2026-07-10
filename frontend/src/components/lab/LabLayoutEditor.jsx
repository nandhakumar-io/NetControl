// components/lab/LabLayoutEditor.jsx — theater-ticket-style seating chart
// for a "lab" group. Each row is built from one or more BLOCKS (sections),
// e.g. "left block | aisle | center block | aisle | right block" — matching
// how a real theater/auditorium groups seats into column sections with
// gaps between them. You control, per row: how many blocks, how many
// seats in each block, the gap between seats within a block, and the
// aisle gap between blocks. A global control sets the vertical gap
// between rows. Click a seat to assign/unassign a device from the group.
import React, { useState, useMemo } from 'react'
import {
  X, Save, Plus, Trash2, Minus, LayoutGrid, UserRound, MonitorX, Loader2, Columns3,
  Wand2, GripVertical,
} from 'lucide-react'
import api from '../../lib/api'
import toast from 'react-hot-toast'
import { useThemeStore } from '../../store/themeStore'

const DEFAULT_BLOCK = { cols: 6 }
const DEFAULT_ROW = { blocks: [{ ...DEFAULT_BLOCK }, { ...DEFAULT_BLOCK }], gap: 8, blockGap: 40 }

function parseLayout(group) {
  let cfg = group?.layout_config
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg) } catch { cfg = null }
  }
  const rows = Array.isArray(cfg?.rows) && cfg.rows.length ? cfg.rows.map(r => ({
    blocks: Array.isArray(r.blocks) && r.blocks.length
      ? r.blocks.map(b => ({ cols: Math.max(1, parseInt(b.cols) || DEFAULT_BLOCK.cols) }))
      : [{ ...DEFAULT_BLOCK }],
    gap:      Number.isFinite(r.gap) ? r.gap : DEFAULT_ROW.gap,
    blockGap: Number.isFinite(r.blockGap) ? r.blockGap : DEFAULT_ROW.blockGap,
  })) : [{ ...DEFAULT_ROW, blocks: DEFAULT_ROW.blocks.map(b => ({ ...b })) }]

  return {
    rowGap: Number.isFinite(cfg?.rowGap) ? cfg.rowGap : 24,
    rows,
  }
}

function seatKey(row, col) { return `${row}:${col}` }

export default function LabLayoutEditor({ group, devices, onClose, onSaved }) {
  const isLight = useThemeStore(s => s.theme === 'light')
  const initial = useMemo(() => parseLayout(group), [group])

  const [rowGap, setRowGap] = useState(initial.rowGap)
  const [rows,   setRows]   = useState(initial.rows)
  const [seatMap, setSeatMap] = useState(() => {
    const m = {}
    devices.forEach(d => {
      if (Number.isInteger(d.seat_row) && Number.isInteger(d.seat_col)) {
        m[seatKey(d.seat_row, d.seat_col)] = d.id
      }
    })
    return m
  })
  const [pickerSeat, setPickerSeat] = useState(null) // { row, col } | null
  const [saving, setSaving] = useState(false)

  const deviceById = useMemo(() => Object.fromEntries(devices.map(d => [d.id, d])), [devices])
  const seatedIds  = useMemo(() => new Set(Object.values(seatMap)), [seatMap])
  const unseated    = useMemo(() => devices.filter(d => !seatedIds.has(d.id)), [devices, seatedIds])

  // ── Row-level controls ───────────────────────────────────────────────
  const addRow = () => setRows(r => [...r, {
    blocks: (r[r.length - 1]?.blocks || DEFAULT_ROW.blocks).map(b => ({ ...b })),
    gap: r[r.length - 1]?.gap ?? DEFAULT_ROW.gap,
    blockGap: r[r.length - 1]?.blockGap ?? DEFAULT_ROW.blockGap,
  }])

  const removeRow = (idx) => {
    setRows(r => r.filter((_, i) => i !== idx))
    setSeatMap(m => {
      const next = {}
      for (const [key, deviceId] of Object.entries(m)) {
        const [row, col] = key.split(':').map(Number)
        if (row === idx) continue
        const newRow = row > idx ? row - 1 : row
        next[seatKey(newRow, col)] = deviceId
      }
      return next
    })
  }

  const dropSeatsBeyond = (rowIdx, newTotalCols) => {
    setSeatMap(m => {
      const next = { ...m }
      for (const key of Object.keys(next)) {
        const [row, col] = key.split(':').map(Number)
        if (row === rowIdx && col >= newTotalCols) delete next[key]
      }
      return next
    })
  }

  // ── Block-level controls ─────────────────────────────────────────────
  const addBlock = (rowIdx) => setRows(r => r.map((row, i) =>
    i === rowIdx ? { ...row, blocks: [...row.blocks, { ...DEFAULT_BLOCK }] } : row))

  const removeBlock = (rowIdx, blockIdx) => setRows(r => {
    const row = r[rowIdx]
    if (row.blocks.length <= 1) return r
    const newBlocks = row.blocks.filter((_, i) => i !== blockIdx)
    dropSeatsBeyond(rowIdx, newBlocks.reduce((s, b) => s + b.cols, 0))
    return r.map((rw, i) => i === rowIdx ? { ...rw, blocks: newBlocks } : rw)
  })

  const updateBlockCols = (rowIdx, blockIdx, cols) => {
    const clamped = Math.max(1, Math.min(100, parseInt(cols) || 1))
    setRows(r => r.map((row, i) => {
      if (i !== rowIdx) return row
      const blocks = row.blocks.map((b, j) => j === blockIdx ? { ...b, cols: clamped } : b)
      dropSeatsBeyond(rowIdx, blocks.reduce((s, b) => s + b.cols, 0))
      return { ...row, blocks }
    }))
  }

  const updateRowGap = (idx, gap) => {
    const clamped = Math.max(0, Math.min(200, Number(gap) || 0))
    setRows(r => r.map((row, i) => i === idx ? { ...row, gap: clamped } : row))
  }
  const updateRowBlockGap = (idx, blockGap) => {
    const clamped = Math.max(0, Math.min(400, Number(blockGap) || 0))
    setRows(r => r.map((row, i) => i === idx ? { ...row, blockGap: clamped } : row))
  }

  // ── Seat assignment ──────────────────────────────────────────────────
  const assignSeat = (row, col, deviceId) => {
    setSeatMap(m => ({ ...m, [seatKey(row, col)]: deviceId }))
    setPickerSeat(null)
  }
  const clearSeat = (row, col) => {
    setSeatMap(m => { const next = { ...m }; delete next[seatKey(row, col)]; return next })
  }

  // ── Drag and drop ─────────────────────────────────────────────────────
  // Two draggable sources: an unseated chip, or an already-seated device
  // (dragged straight off its seat). Two drop targets: a seat cell (assign,
  // or swap if the target seat is already occupied), or the "Not yet
  // seated" tray (unseats whatever was dragged in). Click-to-assign via
  // the picker modal still works unchanged — drag is additive, not a
  // replacement, since touch devices don't get HTML5 DnD for free.
  const [dragPayload, setDragPayload] = useState(null) // { type: 'seat'|'unseated', row?, col?, deviceId }
  const [dragOverKey, setDragOverKey] = useState(null) // seatKey currently hovered, or 'tray'

  const startDragFromSeat = (row, col, deviceId) => (e) => {
    setDragPayload({ type: 'seat', row, col, deviceId })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', deviceId) // Firefox needs real data set to allow the drag
  }
  const startDragFromTray = (deviceId) => (e) => {
    setDragPayload({ type: 'unseated', deviceId })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', deviceId)
  }
  const endDrag = () => { setDragPayload(null); setDragOverKey(null) }

  const allowDrop = (key) => (e) => { e.preventDefault(); setDragOverKey(key) }
  const clearDragOver = (key) => () => { setDragOverKey(prev => prev === key ? null : prev) }

  const dropOnSeat = (row, col) => (e) => {
    e.preventDefault()
    const payload = dragPayload
    endDrag()
    if (!payload) return
    const targetKey = seatKey(row, col)

    setSeatMap(m => {
      const next = { ...m }
      if (payload.type === 'seat') {
        const sourceKey = seatKey(payload.row, payload.col)
        if (sourceKey === targetKey) return m
        const displaced = next[targetKey] // device currently sitting in the target seat, if any
        delete next[sourceKey]
        next[targetKey] = payload.deviceId
        if (displaced) next[sourceKey] = displaced // true swap — the displaced device takes the vacated seat
      } else {
        next[targetKey] = payload.deviceId // overwrite is enough: any previous occupant just falls out of the map's values and shows up in "Not yet seated" again
      }
      return next
    })
  }

  const dropOnTray = (e) => {
    e.preventDefault()
    const payload = dragPayload
    endDrag()
    if (!payload || payload.type !== 'seat') return // dragging an already-unseated chip onto the tray is a no-op
    clearSeat(payload.row, payload.col)
  }

  // Bonus: seat every unseated device into the next empty seats in reading
  // order (row by row, left to right) — handy for quickly populating a
  // freshly-resized grid instead of dragging each device one at a time.
  const autoFill = () => {
    const emptySeats = []
    rows.forEach((row, rowIdx) => {
      let running = 0
      row.blocks.forEach(block => {
        for (let i = 0; i < block.cols; i++) {
          const col = running + i
          if (!seatMap[seatKey(rowIdx, col)]) emptySeats.push([rowIdx, col])
        }
        running += block.cols
      })
    })
    if (!emptySeats.length || !unseated.length) return
    setSeatMap(m => {
      const next = { ...m }
      unseated.slice(0, emptySeats.length).forEach((d, i) => {
        next[seatKey(emptySeats[i][0], emptySeats[i][1])] = d.id
      })
      return next
    })
  }

  // ── Save ──────────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true)
    try {
      const seats = Object.entries(seatMap).map(([key, deviceId]) => {
        const [row, col] = key.split(':').map(Number)
        return { row, col, deviceId }
      })
      const { data } = await api.put(`/groups/${group.id}/layout`, { isLab: true, rowGap, rows, seats })
      toast.success('Lab layout saved')
      onSaved?.(data.group, data.devices)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save layout')
    } finally { setSaving(false) }
  }

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
              Lab Layout — {group.name}
            </h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {Object.keys(seatMap).length} seated · {unseated.length} unseated · drag a device onto a seat, or click an empty one
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {unseated.length > 0 && (
            <button onClick={autoFill}
              title="Seat every unseated device into the next empty seats, row by row"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all"
              style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
              <Wand2 size={13} /> Auto-fill
            </button>
          )}
          <button onClick={save} disabled={saving}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-50"
            style={{ background: '#a855f7', color: '#fff' }}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save Layout
          </button>
          <button onClick={onClose} className="p-2 rounded-xl transition-all"
            style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="p-6">
        {/* Global controls */}
        <div className="flex flex-wrap items-center gap-4 mb-6 pb-5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            Row spacing
            <input type="number" min={0} max={200} value={rowGap}
              onChange={e => setRowGap(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
              className="input-field w-16 h-7 text-xs text-center" />
            px
          </label>
          <button onClick={addRow}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.25)', color: isLight ? '#7c3aed' : '#c084fc' }}>
            <Plus size={12} /> Add Row
          </button>
        </div>

        {/* Rows */}
        <div className="space-y-5 mb-6">
          {rows.map((row, rowIdx) => {
            let running = 0 // running seat-column offset across blocks, for global col indexing
            return (
              <div key={rowIdx} className="rounded-xl p-4 transition-all" style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)' }}>
                {/* Row toolbar */}
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                    Row {rowIdx + 1}
                  </span>
                  {(() => {
                    const totalCols = row.blocks.reduce((s, b) => s + b.cols, 0)
                    let seatedInRow = 0
                    for (let c = 0; c < totalCols; c++) if (seatMap[seatKey(rowIdx, c)]) seatedInRow++
                    return (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--bg-surface-2)', color: seatedInRow ? '#c084fc' : 'var(--text-faint)' }}>
                        {seatedInRow}/{totalCols}
                      </span>
                    )
                  })()}
                  <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Seat gap
                    <input type="number" min={0} max={200} value={row.gap}
                      onChange={e => updateRowGap(rowIdx, e.target.value)}
                      className="input-field w-14 h-6 text-xs text-center px-1" />
                    px
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Aisle gap
                    <input type="number" min={0} max={400} value={row.blockGap}
                      onChange={e => updateRowBlockGap(rowIdx, e.target.value)}
                      className="input-field w-14 h-6 text-xs text-center px-1" />
                    px
                  </label>
                  <button onClick={() => addBlock(rowIdx)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold transition-all"
                    style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                    <Columns3 size={11} /> Add Block
                  </button>
                  <button onClick={() => removeRow(rowIdx)} disabled={rows.length === 1}
                    title={rows.length === 1 ? 'At least one row is required' : 'Remove row'}
                    className="ml-auto p-1.5 rounded-lg transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ color: 'var(--text-faint)' }}
                    onMouseEnter={e => { if (rows.length > 1) e.currentTarget.style.color = '#f87171' }}
                    onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}>
                    <Trash2 size={13} />
                  </button>
                </div>

                {/* Blocks — each a section of seats, with an aisle gap between blocks */}
                <div className="flex flex-wrap items-start justify-center" style={{ gap: `${row.blockGap}px` }}>
                  {row.blocks.map((block, blockIdx) => {
                    const startCol = running
                    running += block.cols
                    return (
                      <div key={blockIdx} className="flex flex-col items-center gap-1.5">
                        {/* Block toolbar */}
                        <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-faint)' }}>
                          <button onClick={() => updateBlockCols(rowIdx, blockIdx, block.cols - 1)}
                            className="w-4 h-4 rounded flex items-center justify-center" style={{ background: 'var(--bg-surface-2)' }}>
                            <Minus size={9} />
                          </button>
                          <input type="number" min={1} max={100} value={block.cols}
                            onChange={e => updateBlockCols(rowIdx, blockIdx, e.target.value)}
                            className="input-field w-11 h-5 text-[10px] text-center px-0.5" />
                          <button onClick={() => updateBlockCols(rowIdx, blockIdx, block.cols + 1)}
                            className="w-4 h-4 rounded flex items-center justify-center" style={{ background: 'var(--bg-surface-2)' }}>
                            <Plus size={9} />
                          </button>
                          {row.blocks.length > 1 && (
                            <button onClick={() => removeBlock(rowIdx, blockIdx)} title="Remove block"
                              className="w-4 h-4 rounded flex items-center justify-center ml-0.5"
                              style={{ background: 'var(--bg-surface-2)' }}
                              onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                              onMouseLeave={e => e.currentTarget.style.color = 'inherit'}>
                              <X size={9} />
                            </button>
                          )}
                        </div>

                        {/* Seats in this block */}
                        <div className="flex" style={{ gap: `${row.gap}px` }}>
                          {Array.from({ length: block.cols }).map((_, localIdx) => {
                            const col = startCol + localIdx
                            const key = seatKey(rowIdx, col)
                            const deviceId = seatMap[key]
                            const device = deviceId ? deviceById[deviceId] : null
                            const online = device?.status === 'online'
                            const isDragOver = dragOverKey === key
                            const isDraggingThis = dragPayload?.type === 'seat' && dragPayload.row === rowIdx && dragPayload.col === col
                            return (
                              <button key={col}
                                draggable={!!device}
                                onDragStart={device ? startDragFromSeat(rowIdx, col, deviceId) : undefined}
                                onDragEnd={endDrag}
                                onDragOver={allowDrop(key)}
                                onDragLeave={clearDragOver(key)}
                                onDrop={dropOnSeat(rowIdx, col)}
                                onClick={() => device ? clearSeat(rowIdx, col) : setPickerSeat({ row: rowIdx, col })}
                                title={device ? `${device.name} — click to unseat, or drag onto another seat` : `Row ${rowIdx + 1}, Seat ${col + 1} — click to assign, or drag a device here`}
                                className="relative w-11 h-11 rounded-t-lg flex flex-col items-center justify-center text-[9px] font-mono font-semibold transition-all shrink-0"
                                style={{
                                  background: isDragOver
                                    ? 'rgba(168,85,247,0.22)'
                                    : device ? (online ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.12)') : 'var(--bg-surface-2)',
                                  border: `1.5px ${isDragOver ? 'dashed' : 'solid'} ${isDragOver
                                    ? '#a855f7'
                                    : device ? (online ? 'rgba(34,197,94,0.4)' : 'var(--border-mid)') : 'var(--border-subtle)'}`,
                                  borderBottom: device ? `3px solid ${online ? '#22c55e' : '#64748b'}` : '3px solid var(--border-subtle)',
                                  color: device ? (online ? '#22c55e' : 'var(--text-muted)') : 'var(--text-faint)',
                                  opacity: isDraggingThis ? 0.35 : 1,
                                  cursor: device ? 'grab' : 'pointer',
                                  transform: isDragOver ? 'scale(1.08)' : 'scale(1)',
                                }}>
                                {device
                                  ? <span className="truncate max-w-[38px] px-0.5">{device.name.slice(0, 6)}</span>
                                  : <Plus size={12} />}
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

        {/* Unseated devices — also a drop zone: drag a seated device here to unseat it */}
        {unseated.length > 0 && (
          <div
            onDragOver={allowDrop('tray')}
            onDragLeave={clearDragOver('tray')}
            onDrop={dropOnTray}
            className="rounded-xl p-3 transition-all"
            style={{
              background: dragOverKey === 'tray' ? 'rgba(168,85,247,0.08)' : 'transparent',
              border: `1.5px dashed ${dragOverKey === 'tray' ? '#a855f7' : 'transparent'}`,
            }}>
            <div className="flex items-center gap-2 mb-2">
              <MonitorX size={12} style={{ color: 'var(--text-faint)' }} />
              <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                Not yet seated
              </span>
              <span className="text-[10px]" style={{ color: 'var(--text-faint)' }}>— drag onto a seat, or drop a seat's device here to unseat it</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {unseated.map(d => (
                <span key={d.id}
                  draggable
                  onDragStart={startDragFromTray(d.id)}
                  onDragEnd={endDrag}
                  className="inline-flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-lg text-[10px] font-mono transition-all"
                  style={{
                    background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)',
                    cursor: 'grab',
                    opacity: dragPayload?.type === 'unseated' && dragPayload.deviceId === d.id ? 0.35 : 1,
                  }}>
                  <GripVertical size={10} style={{ color: 'var(--text-faint)' }} />
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.status === 'online' ? 'bg-accent-green' : 'bg-slate-600'}`} />
                  {d.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {devices.length === 0 && (
          <p className="text-xs text-center py-4" style={{ color: 'var(--text-faint)' }}>
            This group has no devices to seat yet — add devices to it first.
          </p>
        )}
      </div>

      {/* Seat-assignment picker */}
      {pickerSeat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setPickerSeat(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-sm rounded-2xl overflow-hidden animate-slide-up" onClick={e => e.stopPropagation()}
            style={{ background: isLight ? '#fff' : 'var(--bg-surface-1)', border: '1px solid var(--border-mid)', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <h4 className="font-display text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                Assign — Row {pickerSeat.row + 1}, Seat {pickerSeat.col + 1}
              </h4>
              <button onClick={() => setPickerSeat(null)} style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
            </div>
            <div className="p-3 max-h-80 overflow-y-auto">
              {unseated.length === 0 ? (
                <p className="text-xs text-center py-6" style={{ color: 'var(--text-faint)' }}>
                  Every device in this group is already seated.
                </p>
              ) : unseated.map(d => (
                <button key={d.id} onClick={() => assignSeat(pickerSeat.row, pickerSeat.col, d.id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all mb-1"
                  style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(168,85,247,0.4)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}>
                  <UserRound size={14} style={{ color: 'var(--text-faint)' }} />
                  <span className="text-xs font-mono flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</span>
                  <span className={`w-1.5 h-1.5 rounded-full ${d.status === 'online' ? 'bg-accent-green' : 'bg-slate-600'}`} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}