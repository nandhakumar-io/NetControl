import React, { useState, useEffect, useRef } from 'react'
import { X, Monitor, Loader2, FileSpreadsheet, Download, AlertCircle, CheckCircle2, SkipForward } from 'lucide-react'
import * as XLSX from 'xlsx'
import api from '../../lib/api'
import toast from 'react-hot-toast'

const EMPTY = {
  name: '', ip_address: '', mac_address: '',
  os_type: 'linux', group_id: '',
  ssh_username: '', ssh_password: '', ssh_key: '',
  winrm_username: '', winrm_password: '',
}

const F = ({ label, id, errors, children }) => (
  <div>
    <label className="label" htmlFor={id}>{label}</label>
    {children}
    {errors?.[id] && <p className="text-xs text-rose-400 mt-1 font-body">{errors[id]}</p>}
  </div>
)

// ── Excel template helpers ────────────────────────────────────────────────────
const EXCEL_COLUMNS = [
  'name','ip_address','mac_address','os_type','group_name',
  'ssh_username','ssh_password','winrm_username','winrm_password',
]
const EXCEL_EXAMPLE = [
  { name:'LAB1-PC-01', ip_address:'192.168.1.101', mac_address:'AA:BB:CC:DD:EE:01',
    os_type:'linux',   group_name:'LAB 1', ssh_username:'ubuntu',
    ssh_password:'pass123', winrm_username:'', winrm_password:'' },
  { name:'LAB1-PC-02', ip_address:'192.168.1.102', mac_address:'AA:BB:CC:DD:EE:02',
    os_type:'windows', group_name:'LAB 1', ssh_username:'',
    ssh_password:'', winrm_username:'Administrator', winrm_password:'pass456' },
]

function downloadTemplate() {
  const ws = XLSX.utils.json_to_sheet(EXCEL_EXAMPLE, { header: EXCEL_COLUMNS })
  ws['!cols'] = EXCEL_COLUMNS.map(c => ({ wch: Math.max(c.length + 4, 18) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Devices')
  XLSX.writeFile(wb, 'netcontrol_devices_template.xlsx')
}

function parseExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb   = XLSX.read(e.target.result, { type: 'binary' })
        const ws   = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
        resolve(rows)
      } catch (err) { reject(err) }
    }
    reader.onerror = reject
    reader.readAsBinaryString(file)
  })
}

// ── Client-side row validation (mirrors backend) ──────────────────────────────
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/
const IP_RE  = /^(\d{1,3}\.){3}\d{1,3}$/

function validateRows(rows) {
  const errors = []
  rows.forEach((r, i) => {
    const label = `Row ${i + 2}`
    if (!r.name || !String(r.name).trim())
      errors.push(`${label}: name is required`)
    else if (String(r.name).trim().length > 100)
      errors.push(`${label}: name too long (max 100 chars)`)

    if (!r.ip_address || !IP_RE.test(String(r.ip_address).trim()))
      errors.push(`${label}: invalid IP address`)

    if (!r.mac_address || !MAC_RE.test(String(r.mac_address).trim()))
      errors.push(`${label}: invalid MAC address (expected AA:BB:CC:DD:EE:FF)`)

    const os = (r.os_type || '').toLowerCase()
    if (!['linux', 'windows'].includes(os))
      errors.push(`${label}: os_type must be "linux" or "windows"`)
  })
  return errors
}

// ── Import panel ──────────────────────────────────────────────────────────────
function ImportPanel({ groups, onImported }) {
  const inputRef              = useRef(null)
  const [file, setFile]       = useState(null)
  const [rows, setRows]       = useState([])
  const [preview, setPreview] = useState([])
  const [valErrors, setValErrors] = useState([])
  const [importing, setImporting] = useState(false)
  const [results, setResults]     = useState(null)

  const handleFile = async (f) => {
    setFile(f)
    setResults(null)
    setValErrors([])
    setRows([])
    setPreview([])
    try {
      const parsed = await parseExcel(f)
      const errs   = validateRows(parsed)
      setValErrors(errs)
      setRows(parsed)
      setPreview(parsed.slice(0, 5))
    } catch {
      toast.error('Failed to parse spreadsheet')
    }
  }

  const handleImport = async () => {
    if (!file || valErrors.length > 0 || rows.length === 0) return
    if (rows.length > 500) {
      toast.error('Maximum 500 devices per import. Please split your spreadsheet.')
      return
    }

    // ── Warn about unresolved group names before touching the DB ──────────
    const unknownGroups = new Set()
    rows.forEach(row => {
      const gName = (row.group_name || '').trim()
      if (gName) {
        const match = groups.find(g => g.name.toLowerCase() === gName.toLowerCase())
        if (!match) unknownGroups.add(gName)
      }
    })
    if (unknownGroups.size > 0) {
      toast.error(
        `Unknown group name(s): ${[...unknownGroups].join(', ')}. Create these groups first or fix the spelling in your spreadsheet.`,
        { duration: 7000 }
      )
      return
    }
    // ─────────────────────────────────────────────────────────────────────

    setImporting(true)
    setResults(null)

    try {
      // Build payload — resolve group_name → group_id, encrypt nothing here
      // (backend handles encryption). We just map the group name to an ID.
      const devices = rows.map(row => {
        const group = groups.find(
          g => g.name.toLowerCase() === (row.group_name || '').trim().toLowerCase()
        )
        const os = (row.os_type || 'linux').toLowerCase()
        return {
          name:           String(row.name          || '').trim(),
          ip_address:     String(row.ip_address    || '').trim(),
          mac_address:    String(row.mac_address   || '').trim(),
          os_type:        os,
          group_id:       group?.id || null,
          ssh_username:   String(row.ssh_username  || '').trim() || null,
          ssh_password:   String(row.ssh_password  || '').trim() || null,
          // For Windows, map winrm → rpc fields on the backend naming
          rpc_username:   String(row.winrm_username || row.ssh_username || '').trim() || null,
          rpc_password:   String(row.winrm_password || row.ssh_password || '').trim() || null,
        }
      })

      // Single HTTP request — no more N individual POSTs
      const { data } = await api.post('/devices/bulk-import', { devices })

      setResults(data)
      if (data.imported > 0) {
        toast.success(`${data.imported} device${data.imported > 1 ? 's' : ''} imported`)
        onImported()
      } else if (data.skipped > 0 && data.imported === 0) {
        toast(`All ${data.skipped} devices already exist — nothing to import`, { icon: 'ℹ' })
      }
    } catch (err) {
      const msg = err.response?.data?.error || 'Import failed'
      const validationErrors = err.response?.data?.validationErrors
      if (validationErrors?.length) {
        setValErrors(validationErrors)
        toast.error('Server rejected the file — see errors below')
      } else {
        toast.error(msg)
      }
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-4">

      {/* Template download */}
      <div className="flex items-center gap-3 p-3 rounded-xl"
        style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(129,140,248,0.2)' }}>
        <FileSpreadsheet size={18} className="text-indigo-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-body font-medium" style={{ color: 'var(--text-primary)' }}>Download template first</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Fill it in, then upload below — up to 500 devices</p>
        </div>
        <button onClick={downloadTemplate} className="btn-ghost text-xs px-3 py-1.5 whitespace-nowrap flex items-center gap-1.5">
          <Download size={12} /> Template
        </button>
      </div>

      {/* File picker */}
      <div
        onClick={() => inputRef.current?.click()}
        className="flex flex-col items-center justify-center gap-2 h-28 rounded-xl border-2 border-dashed cursor-pointer transition-all"
        style={{
          borderColor: file ? 'rgba(52,211,153,0.4)' : 'rgba(129,140,248,0.25)',
          background:  file ? 'rgba(52,211,153,0.05)' : 'rgba(99,102,241,0.04)',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={e => e.target.files[0] && handleFile(e.target.files[0])}
        />
        <FileSpreadsheet size={22} style={{ color: file ? '#34d399' : 'var(--text-muted)' }} />
        <p className="text-sm font-body" style={{ color: 'var(--text-secondary)' }}>
          {file ? file.name : 'Click to select .xlsx / .xls / .csv'}
        </p>
        {rows.length > 0 && (
          <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {rows.length} device{rows.length !== 1 ? 's' : ''} found
          </p>
        )}
      </div>

      {/* Validation errors */}
      {valErrors.length > 0 && (
        <div className="space-y-1 p-3 rounded-xl"
          style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-xs font-body font-semibold text-rose-400 mb-1">
            Fix these errors before importing:
          </p>
          {valErrors.slice(0, 8).map((e, i) => (
            <p key={i} className="text-xs text-rose-400 font-body flex items-center gap-1.5">
              <AlertCircle size={11} className="shrink-0" /> {e}
            </p>
          ))}
          {valErrors.length > 8 && (
            <p className="text-xs text-rose-400">…and {valErrors.length - 8} more</p>
          )}
        </div>
      )}

      {/* Group name warnings */}
      {rows.length > 0 && valErrors.length === 0 && (() => {
        const unknown = new Set()
        rows.forEach(row => {
          const gName = (row.group_name || '').trim()
          if (gName && !groups.find(g => g.name.toLowerCase() === gName.toLowerCase()))
            unknown.add(gName)
        })
        return unknown.size > 0 ? (
          <div className="space-y-1 p-3 rounded-xl"
            style={{ background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)' }}>
            <p className="text-xs font-body font-semibold text-amber-400 mb-1">
              ⚠ Unknown group name(s) — devices will not be grouped:
            </p>
            {[...unknown].map((name, i) => (
              <p key={i} className="text-xs text-amber-400 font-mono">"{name}"</p>
            ))}
            <p className="text-xs text-amber-400/70 font-body mt-1">
              Create these groups first, or fix the spelling in your spreadsheet.
            </p>
          </div>
        ) : null
      })()}

      {/* Preview */}
      {preview.length > 0 && valErrors.length === 0 && (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
          <div className="px-3 py-2" style={{ background: 'var(--bg-surface-3)' }}>
            <p className="text-xs font-body font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Preview — first {preview.length} of {rows.length} rows
            </p>
          </div>
          <div className="divide-y" style={{ divideColor: 'var(--border-subtle)' }}>
            {preview.map((r, i) => {
              const gName = (r.group_name || '').trim()
              const groupResolved = !gName || groups.find(g => g.name.toLowerCase() === gName.toLowerCase())
              return (
                <div key={i} className="flex items-center gap-3 px-3 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0
                    ${(r.os_type||'').toLowerCase() === 'windows'
                      ? 'bg-sky-400/10 text-sky-400'
                      : 'bg-emerald-400/10 text-emerald-400'
                    }`}>
                    {(r.os_type||'linux').toLowerCase()}
                  </span>
                  <span className="text-sm font-body font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {r.name}
                  </span>
                  {gName && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-body shrink-0 ${
                      groupResolved ? 'bg-indigo-400/10 text-indigo-400' : 'bg-amber-400/10 text-amber-400'
                    }`}>
                      {groupResolved ? gName : `⚠ ${gName}`}
                    </span>
                  )}
                  <span className="text-xs font-mono ml-auto shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {r.ip_address}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="p-3 rounded-xl space-y-3"
          style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)' }}>

          {/* Summary row */}
          <div className="flex flex-wrap gap-4">
            <span className="text-sm font-body text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={14} />
              <span className="font-bold text-lg leading-none">{results.imported}</span> imported
            </span>
            {results.skipped > 0 && (
              <span className="text-sm font-body text-slate-400 flex items-center gap-1.5">
                <SkipForward size={14} />
                <span className="font-bold text-lg leading-none">{results.skipped}</span> skipped (duplicates)
              </span>
            )}
            {results.failed > 0 && (
              <span className="text-sm font-body text-rose-400 flex items-center gap-1.5">
                <AlertCircle size={14} />
                <span className="font-bold text-lg leading-none">{results.failed}</span> failed
              </span>
            )}
          </div>

          {/* Failure details */}
          {results.results?.filter(r => r.status === 'failed').length > 0 && (
            <div className="max-h-28 overflow-y-auto space-y-1">
              {results.results.filter(r => r.status === 'failed').map((r, i) => (
                <p key={i} className="text-xs text-rose-400 font-body flex items-start gap-1.5">
                  <AlertCircle size={11} className="shrink-0 mt-0.5" />
                  <span><span className="font-medium">{r.name}:</span> {r.reason}</span>
                </p>
              ))}
            </div>
          )}

          {/* Skipped details (collapsed) */}
          {results.skipped > 0 && (
            <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
              Skipped devices already exist in the database (matched by IP + MAC).
              Re-uploading the same spreadsheet is safe — duplicates are always ignored.
            </p>
          )}
        </div>
      )}

      {/* Import button */}
      <button
        onClick={handleImport}
        disabled={!file || valErrors.length > 0 || importing || rows.length === 0}
        className="btn-primary w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {importing
          ? <><Loader2 size={14} className="animate-spin" /> Importing {rows.length} devices…</>
          : <><FileSpreadsheet size={14} /> Import {rows.length > 0 ? `${rows.length} Devices` : 'Devices'}</>
        }
      </button>

      {rows.length > 500 && (
        <p className="text-xs text-rose-400 text-center font-body">
          ⚠ Maximum 500 devices per import. Please split your spreadsheet into smaller batches.
        </p>
      )}
    </div>
  )
}

// ── Main Modal ────────────────────────────────────────────────────────────────
export default function DeviceModal({ open, onClose, onSaved, device, groups }) {
  const [tab, setTab]         = useState('manual')
  const [form, setForm]       = useState(EMPTY)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors]   = useState({})

  useEffect(() => {
    if (open) {
      setTab('manual')
      setForm(device ? {
        name:           device.name           || '',
        ip_address:     device.ip_address     || '',
        mac_address:    device.mac_address    || '',
        os_type:        device.os_type        || 'linux',
        group_id:       device.group_id       || '',
        ssh_username:   device.ssh_username   || '',
        ssh_password:   '',
        ssh_key:        '',
        winrm_username: device.winrm_username || '',
        winrm_password: '',
      } : EMPTY)
      setErrors({})
    }
  }, [open, device])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const validate = () => {
    const e = {}
    if (!form.name.trim())        e.name        = 'Required'
    if (!form.ip_address.trim())  e.ip_address  = 'Required'
    if (!form.mac_address.trim()) e.mac_address = 'Required'
    if (form.mac_address && !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(form.mac_address))
      e.mac_address = 'Invalid MAC (e.g. AA:BB:CC:DD:EE:FF)'
    if (form.os_type === 'linux') {
      if (!form.ssh_username.trim())                e.ssh_username = 'Required'
      if (!device && !form.ssh_password.trim())     e.ssh_password = 'Required for new device'
    } else {
      if (!form.winrm_username.trim())              e.winrm_username = 'Required'
      if (!device && !form.winrm_password.trim())   e.winrm_password = 'Required for new device'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return
    setLoading(true)
    try {
      const payload = { ...form }
      if (!payload.group_id) payload.group_id = null
      if (!payload.ssh_password)   delete payload.ssh_password
      if (!payload.ssh_key)        delete payload.ssh_key
      if (!payload.winrm_password) delete payload.winrm_password

      if (payload.os_type === 'linux') {
        delete payload.winrm_username
        delete payload.winrm_password
      } else {
        payload.ssh_username = payload.winrm_username
        if (payload.ssh_password === undefined && payload.winrm_password)
          payload.ssh_password = payload.winrm_password
        delete payload.ssh_key
      }

      if (device) {
        await api.put(`/devices/${device.id}`, payload)
        toast.success('Device updated')
      } else {
        await api.post('/devices', payload)
        toast.success('Device added')
      }
      onSaved(); onClose()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  const isLinux = form.os_type === 'linux'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 modal-backdrop" />
      <div className="relative z-10 w-full max-w-lg animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="glass rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(129,140,248,0.18)' }}>
          <div className="h-px glow-line" />

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(129,140,248,0.25)' }}>
                <Monitor size={15} className="text-indigo-400" />
              </div>
              <h3 className="font-display text-base" style={{ color: 'var(--text-primary)' }}>
                {device ? 'Edit Device' : 'Add Device'}
              </h3>
            </div>
            <button onClick={onClose} className="icon-btn p-1.5"><X size={15} /></button>
          </div>

          {/* Tabs — only for new device */}
          {!device && (
            <div className="flex gap-1 px-6 pt-4">
              {[['manual', 'Manual'], ['excel', 'Import from Spreadsheet']].map(([val, lbl]) => (
                <button key={val} onClick={() => setTab(val)}
                  className={`px-4 py-1.5 rounded-lg text-xs font-body font-semibold transition-all flex items-center gap-1.5
                    ${tab === val
                      ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                      : 'text-slate-500 hover:text-slate-300'
                    }`}>
                  {val === 'excel' && <FileSpreadsheet size={12} />}{lbl}
                </button>
              ))}
            </div>
          )}

          {/* Body */}
          <div className="p-6 max-h-[68vh] overflow-y-auto">
            {tab === 'excel' && !device ? (
              <ImportPanel groups={groups} onImported={onSaved} onClose={onClose} />
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <F label="Display Name" id="name" errors={errors}>
                    <input id="name" className={`input-field ${errors.name ? 'border-rose-500/50' : ''}`}
                      placeholder="e.g. LAB1-PC-01" value={form.name} onChange={e => set('name', e.target.value)} />
                  </F>
                </div>

                <F label="IP Address" id="ip_address" errors={errors}>
                  <input id="ip_address" className={`input-field ${errors.ip_address ? 'border-rose-500/50' : ''}`}
                    placeholder="192.168.1.100" value={form.ip_address} onChange={e => set('ip_address', e.target.value)} />
                </F>

                <F label="MAC Address" id="mac_address" errors={errors}>
                  <input id="mac_address" className={`input-field ${errors.mac_address ? 'border-rose-500/50' : ''}`}
                    placeholder="AA:BB:CC:DD:EE:FF" value={form.mac_address} onChange={e => set('mac_address', e.target.value)} />
                </F>

                <F label="OS Type" id="os_type" errors={errors}>
                  <select id="os_type" className="input-field" value={form.os_type} onChange={e => set('os_type', e.target.value)}>
                    <option value="linux">Linux</option>
                    <option value="windows">Windows</option>
                  </select>
                </F>

                <F label="Group / Lab" id="group_id" errors={errors}>
                  <select id="group_id" className="input-field" value={form.group_id} onChange={e => set('group_id', e.target.value)}>
                    <option value="">No Group</option>
                    {groups?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </F>

                {isLinux ? (<>
                  <F label="SSH Username" id="ssh_username" errors={errors}>
                    <input id="ssh_username" className={`input-field ${errors.ssh_username ? 'border-rose-500/50' : ''}`}
                      placeholder="ubuntu" value={form.ssh_username} onChange={e => set('ssh_username', e.target.value)} />
                  </F>
                  <F label={device ? 'SSH Password (blank = keep)' : 'SSH Password'} id="ssh_password" errors={errors}>
                    <input id="ssh_password" type="password" className={`input-field ${errors.ssh_password ? 'border-rose-500/50' : ''}`}
                      placeholder={device ? '••••••••' : 'SSH password'} value={form.ssh_password} onChange={e => set('ssh_password', e.target.value)} />
                  </F>
                  <div className="col-span-2">
                    <F label="SSH Private Key (optional)" id="ssh_key" errors={errors}>
                      <textarea id="ssh_key" rows={3} className="input-field resize-none font-mono text-xs"
                        placeholder={device ? '(leave blank to keep existing key)' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                        value={form.ssh_key} onChange={e => set('ssh_key', e.target.value)} />
                    </F>
                  </div>
                </>) : (<>
                  <F label="Username" id="winrm_username" errors={errors}>
                    <input id="winrm_username" className={`input-field ${errors.winrm_username ? 'border-rose-500/50' : ''}`}
                      placeholder="Administrator" value={form.winrm_username} onChange={e => set('winrm_username', e.target.value)} />
                  </F>
                  <F label={device ? 'Password (blank = keep)' : 'Password'} id="winrm_password" errors={errors}>
                    <input id="winrm_password" type="password" className={`input-field ${errors.winrm_password ? 'border-rose-500/50' : ''}`}
                      placeholder={device ? '••••••••' : 'Windows password'} value={form.winrm_password} onChange={e => set('winrm_password', e.target.value)} />
                  </F>
                  <div className="col-span-2 px-3 py-2 rounded-xl" style={{ background: 'var(--bg-surface-3)', border: '1px solid var(--border-subtle)' }}>
                    <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
                      Used with <span className="font-mono text-indigo-400">net rpc shutdown</span> and SSH terminal.
                    </p>
                  </div>
                </>)}

                <div className="col-span-2 px-3 py-2.5 rounded-xl"
                  style={{ background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(129,140,248,0.15)' }}>
                  <p className="text-xs font-body" style={{ color: 'var(--text-muted)' }}>
                    <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>Security: </span>
                    Credentials are AES-256 encrypted at rest and never sent to the browser.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Footer — only for manual tab */}
          {tab === 'manual' && (
            <div className="flex gap-3 px-6 pb-6">
              <button onClick={onClose} className="btn-ghost flex-1 justify-center" disabled={loading}>Cancel</button>
              <button onClick={handleSubmit} className="btn-primary flex-1 justify-center" disabled={loading}>
                {loading ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : device ? 'Save Changes' : 'Add Device'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
