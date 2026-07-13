import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Radar, Plus, X, Loader2, RefreshCw, Play, Square, Trash2,
  ChevronDown, ChevronRight, Download,
  CheckCircle2, XCircle, Lock, AlertTriangle,
  Server, Eye, EyeOff, Layers, Key, User, Monitor, Network,
  Info, Tag,
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import PageHeader from '../components/ui/PageHeader'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'
import { usePermissions } from '../hooks/usePermissions'
import { useThemeStore } from '../store/themeStore'

const METHODS = [
  { key: 'ping',     label: 'ICMP Ping Sweep',      desc: 'Find live hosts across the range' },
  { key: 'snmp',     label: 'SNMP Discovery',        desc: 'sysDescr / sysName via community string' },
  { key: 'lldp_cdp', label: 'LLDP / CDP Neighbors', desc: 'Switch/router neighbor tables (needs SNMP)' },
  { key: 'nmap',     label: 'Nmap Port Scan',        desc: 'Open ports, service + OS fingerprinting' },
]

const STATUS_CFG = {
  queued:    { color: '#94a3b8', icon: Loader2,       label: 'Queued' },
  running:   { color: '#38bdf8', icon: Loader2,       label: 'Running' },
  completed: { color: '#34d399', icon: CheckCircle2,  label: 'Completed' },
  cancelled: { color: '#fbbf24', icon: Square,        label: 'Cancelled' },
  failed:    { color: '#f87171', icon: XCircle,       label: 'Failed' },
}

function StatusPill({ status }) {
  const c = STATUS_CFG[status] || STATUS_CFG.queued
  const Icon = c.icon
  const spinning = status === 'queued' || status === 'running'
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-body font-bold px-2 py-0.5 rounded-full"
      style={{ background: `${c.color}18`, border: `1px solid ${c.color}40`, color: c.color }}>
      <Icon size={11} className={spinning ? 'animate-spin' : ''} /> {c.label}
    </span>
  )
}

// ── Determine os_type from an nmap/SNMP OS guess string ─────────────────────
// No guess at all (e.g. a ping-only ICMP sweep — ping tells you nothing about
// the OS) must NOT be silently assumed to be Linux. Same for a guess that's
// neither confidently Windows nor Linux (e.g. "Cisco IOS", "FreeBSD") — those
// need a human to pick, not a guess baked in as if it were a fact.
function osGuessToType(osGuess) {
  if (!osGuess) return 'unknown'
  const s = osGuess.toLowerCase()
  if (s.includes('windows') || s.includes('microsoft')) return 'windows'
  if (s.includes('linux') || s.includes('ubuntu') || s.includes('debian') || s.includes('centos') || s.includes('red hat') || s.includes('unix')) return 'linux'
  return 'unknown'
}

// ── OS type badge (matches DeviceModal style) ─────────────────────────────────
function OsBadge({ type }) {
  const label = type === 'windows' ? 'WIN' : type === 'linux' ? 'LNX' : 'UNK'
  const style = type === 'windows'
    ? 'bg-sky-400/10 text-sky-400'
    : type === 'linux'
      ? 'bg-emerald-400/10 text-emerald-400'
      : 'bg-slate-400/10 text-slate-400'
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold shrink-0 ${style}`}>
      {label}
    </span>
  )
}

// ── Field wrapper with label (mirrors DeviceModal's <F> component) ────────────
function Field({ label, children, hint }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[10px] font-body font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}>{label}</label>
      {children}
      {hint && <p className="text-[10px] font-body" style={{ color: 'var(--text-faint)' }}>{hint}</p>}
    </div>
  )
}

// ── New scan form modal ───────────────────────────────────────────────────────
function NewScanModal({ open, onClose, onCreated }) {
  const [name, setName]               = useState('')
  const [cidr, setCidr]               = useState('')
  const [methods, setMethods]         = useState(['ping'])
  const [communities, setCommunities] = useState('public')
  const [nmapTopPorts, setNmapTopPorts] = useState(100)
  const [nmapPorts, setNmapPorts]     = useState('')
  const [osDetection, setOsDetection] = useState(false)
  const [serviceDetection, setServiceDetection] = useState(true)
  const [pinModalOpen, setPinModalOpen] = useState(false)
  const [errors, setErrors]           = useState({})

  useEffect(() => {
    if (open) {
      setName(''); setCidr(''); setMethods(['ping']); setCommunities('public')
      setNmapTopPorts(100); setNmapPorts(''); setOsDetection(false); setServiceDetection(true)
      setErrors({}); setPinModalOpen(false)
    }
  }, [open])

  const toggleMethod = (key) =>
    setMethods(prev => prev.includes(key) ? prev.filter(m => m !== key) : [...prev, key])

  const validateForm = () => {
    const e = {}
    if (!name.trim()) e.name = 'Name is required'
    if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(cidr.trim())) e.cidr = 'Use an IP or CIDR, e.g. 192.168.1.0/24'
    if (methods.length === 0) e.methods = 'Select at least one discovery method'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const openConfirm = () => { if (validateForm()) setPinModalOpen(true) }

  const submit = async (pin) => {
    const payload = { name: name.trim(), cidr: cidr.trim(), methods, actionPin: pin }
    if (methods.includes('snmp')) {
      payload.snmpCommunities = communities.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5)
    }
    if (methods.includes('nmap')) {
      payload.nmapOptions = {
        osDetection, serviceDetection,
        ...(nmapPorts.trim() ? { ports: nmapPorts.trim() } : { topPorts: Number(nmapTopPorts) || 100 }),
      }
    }
    const { data } = await api.post('/discovery/scans', payload)
    toast.success(`Scan started — ${data.totalHosts} hosts queued`)
    onCreated()
    onClose()
  }

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div className="relative z-10 w-full max-w-lg animate-slide-up" onClick={e => e.stopPropagation()}>
          <div className="rounded-2xl overflow-hidden max-h-[85vh] flex flex-col"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-mid)', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>
            <div style={{ height: 2, background: 'linear-gradient(90deg,#38bdf8,#a78bfa)' }} />
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.3)' }}>
                  <Radar size={15} style={{ color: '#38bdf8' }} />
                </div>
                <h3 className="font-display text-sm" style={{ color: 'var(--text-primary)' }}>New Discovery Scan</h3>
              </div>
              <button onClick={onClose} className="p-1 rounded-lg hover:text-accent-red" style={{ color: 'var(--text-muted)' }}><X size={16} /></button>
            </div>

            <div className="px-6 py-5 space-y-4 overflow-y-auto">
              <div>
                <label className="label">Scan Name</label>
                <input className={`input-field ${errors.name ? 'border-rose-500/50' : ''}`} placeholder="e.g. Lab 1 subnet sweep"
                  value={name} onChange={e => setName(e.target.value)} />
                {errors.name && <p className="text-xs text-rose-400 mt-1">{errors.name}</p>}
              </div>

              <div>
                <label className="label">Target Range (CIDR)</label>
                <input className={`input-field font-mono ${errors.cidr ? 'border-rose-500/50' : ''}`} placeholder="192.168.1.0/24"
                  value={cidr} onChange={e => setCidr(e.target.value)} />
                <p className="text-[11px] font-body mt-1" style={{ color: 'var(--text-muted)' }}>
                  Max /20 (4096 hosts) per scan — split larger networks into multiple scans.
                </p>
                {errors.cidr && <p className="text-xs text-rose-400 mt-1">{errors.cidr}</p>}
              </div>

              <div>
                <label className="label">Discovery Methods</label>
                <div className="space-y-2">
                  {METHODS.map(m => (
                    <label key={m.key} className="flex items-start gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all"
                      style={{ background: methods.includes(m.key) ? 'rgba(56,189,248,0.08)' : 'var(--bg-input)',
                               border: `1px solid ${methods.includes(m.key) ? 'rgba(56,189,248,0.35)' : 'var(--border-subtle)'}` }}>
                      <input type="checkbox" className="mt-0.5" checked={methods.includes(m.key)} onChange={() => toggleMethod(m.key)} />
                      <div>
                        <p className="text-sm font-body font-medium" style={{ color: 'var(--text-primary)' }}>{m.label}</p>
                        <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>{m.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
                {errors.methods && <p className="text-xs text-rose-400 mt-1">{errors.methods}</p>}
              </div>

              {methods.includes('snmp') && (
                <div>
                  <label className="label">SNMP Community Strings</label>
                  <input className="input-field font-mono" placeholder="public, private"
                    value={communities} onChange={e => setCommunities(e.target.value)} />
                  <p className="text-[11px] font-body mt-1" style={{ color: 'var(--text-muted)' }}>
                    Comma-separated — tried in order per host, up to 5.
                  </p>
                </div>
              )}

              {methods.includes('nmap') && (
                <div className="space-y-3 px-3 py-3 rounded-xl" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Top Ports</label>
                      <input type="number" min={1} max={1000} className="input-field" value={nmapTopPorts}
                        onChange={e => setNmapTopPorts(e.target.value)} disabled={!!nmapPorts.trim()} />
                    </div>
                    <div>
                      <label className="label">Or Specific Ports</label>
                      <input className="input-field font-mono" placeholder="22,80,443" value={nmapPorts}
                        onChange={e => setNmapPorts(e.target.value)} />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm font-body" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={serviceDetection} onChange={e => setServiceDetection(e.target.checked)} />
                    Service/version detection (-sV)
                  </label>
                  <label className="flex items-center gap-2 text-sm font-body" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={osDetection} onChange={e => setOsDetection(e.target.checked)} />
                    OS fingerprinting (-O, requires nmap run as root on the server)
                  </label>
                </div>
              )}

              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg" style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}>
                <AlertTriangle size={13} style={{ color: '#fbbf24' }} className="shrink-0 mt-0.5" />
                <p className="text-[11px] font-body leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Scans actively probe every host in range. Only target networks you're authorised to scan. This action is logged in the audit trail.
                </p>
              </div>
            </div>

            <div className="flex gap-3 px-6 py-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
              <button onClick={openConfirm} className="btn-primary flex-1 justify-center"><Play size={14} /> Start Scan</button>
            </div>
          </div>
        </div>
      </div>

      <ActionConfirmModal open={pinModalOpen} onClose={() => setPinModalOpen(false)} onConfirm={submit}
        title="Confirm Discovery Scan" description={`Scan ${cidr || 'range'} using ${methods.join(', ') || 'no methods selected'}`} />
    </>
  )
}

// ── Result row ────────────────────────────────────────────────────────────────
function ResultRow({ r, selected, onToggle }) {
  const ports  = r.open_ports || []
  const osType = osGuessToType(r.os_guess)
  return (
    <div className="grid items-center gap-2 px-4 py-2.5 text-xs font-body transition-colors hover:bg-white/[0.02]"
      style={{ gridTemplateColumns: '24px 36px 130px 150px 150px 1fr', borderBottom: '1px solid var(--border-subtle)' }}>
      <input type="checkbox" checked={selected} disabled={r.imported} onChange={() => onToggle(r.id)} />
      <OsBadge type={osType} />
      <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{r.ip_address}</span>
      <span className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{r.mac_address || '—'}</span>
      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{r.vendor || '—'}</span>
      <span className="truncate" style={{ color: 'var(--text-muted)' }}>
        {ports.length ? ports.map(p => `${p.port}/${p.proto}${p.service ? ` (${p.service})` : ''}`).join(', ') : (r.imported ? '✓ Imported' : '—')}
      </span>
    </div>
  )
}

// ── Import config modal ───────────────────────────────────────────────────────
function ImportModal({ open, onClose, onDone, scanId, results }) {
  const [groups,  setGroups]  = useState([])
  const [specs,   setSpecs]   = useState([])
  const [saving,  setSaving]  = useState(false)
  const [showPw,  setShowPw]  = useState({})

  useEffect(() => {
    if (!open) return
    api.get('/groups').then(r => setGroups(r.data)).catch(() => {})
    setSpecs(results.map(r => ({
      resultId:       r.id,
      ip:             r.ip_address,
      mac:            r.mac_address,
      hostname:       r.hostname,
      osGuess:        r.os_guess,
      name:           r.hostname && r.hostname !== r.ip_address ? r.hostname : r.ip_address,
      // BUG FIX: Use osGuessToType() so "Microsoft Windows Server 2022" → 'windows'
      // Previously only checked /windows/i directly which is fine, but centralising
      // the logic means future changes only need to happen in one place.
      os_type:        osGuessToType(r.os_guess),
      group_id:       '',
      ssh_username:   '',
      ssh_password:   '',
      winrm_username: '',
      winrm_password: '',
    })))
  }, [open, results])

  const setField = (resultId, field, value) =>
    setSpecs(prev => prev.map(s => s.resultId === resultId ? { ...s, [field]: value } : s))

  const applyAll = (field, value) =>
    setSpecs(prev => prev.map(s => ({ ...s, [field]: value })))

  const handleSubmit = async () => {
    const invalid = specs.find(s => !s.name.trim())
    if (invalid) { toast.error(`Device at ${invalid.ip} needs a name`); return }
    // os_type is a strict windows/linux enum on the backend — a scan that
    // couldn't confidently guess the OS (e.g. a ping-only sweep) leaves this
    // as 'unknown' on purpose, and must be resolved by a human before import
    // rather than silently defaulting to Linux.
    const unresolved = specs.find(s => s.os_type === 'unknown')
    if (unresolved) { toast.error(`${unresolved.ip} — OS type unknown, please select Windows or Linux`); return }
    setSaving(true)
    try {
      const payload = specs.map(s => ({
        resultId:       s.resultId,
        name:           s.name.trim(),
        os_type:        s.os_type,
        group_id:       s.group_id || null,
        ssh_username:   s.ssh_username   || null,
        ssh_password:   s.ssh_password   || null,
        winrm_username: s.winrm_username || null,
        winrm_password: s.winrm_password || null,
      }))
      const { data } = await api.post(`/discovery/scans/${scanId}/import`, { devices: payload })
      toast.success(`Imported ${data.imported.length} device${data.imported.length !== 1 ? 's' : ''}` +
        (data.skipped.length ? `, ${data.skipped.length} skipped` : ''))
      onDone()
      onClose()
    } catch (e) { toast.error(e.response?.data?.error || 'Import failed') }
    finally { setSaving(false) }
  }

  if (!open) return null

  const inp = 'input-field text-xs py-1.5'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/65 backdrop-blur-md" />
      <div className="relative z-10 w-full max-w-6xl animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="glass rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.1)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
          {/* Accent bar */}
          <div style={{ height: 2, background: 'linear-gradient(90deg,#38bdf8,#a78bfa,#34d399)' }} />

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.25)' }}>
                <Download size={16} className="text-sky-400" />
              </div>
              <div>
                <h3 className="font-display text-base" style={{ color: 'var(--text-primary)' }}>Import Devices</h3>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Review and configure {specs.length} device{specs.length !== 1 ? 's' : ''} before adding to inventory
                </p>
              </div>
            </div>
            <button onClick={onClose} className="icon-btn p-1.5"><X size={15} /></button>
          </div>

          {/* Bulk-apply toolbar */}
          <div className="px-6 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 shrink-0"
            style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface-3)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Apply to all:</span>

            <div className="flex items-center gap-2">
              <Layers size={12} style={{ color: 'var(--text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Group</span>
              <select className="input-field text-xs py-1 w-36"
                onChange={e => applyAll('group_id', e.target.value)}>
                <option value="">No group</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <Monitor size={12} style={{ color: 'var(--text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>OS Type</span>
              <select className="input-field text-xs py-1 w-28"
                onChange={e => applyAll('os_type', e.target.value)}>
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <User size={12} style={{ color: 'var(--text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>SSH user</span>
              <input className="input-field text-xs py-1 w-28" placeholder="e.g. ubuntu"
                onChange={e => applyAll('ssh_username', e.target.value)} />
            </div>

            <div className="flex items-center gap-2">
              <Key size={12} style={{ color: 'var(--text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>SSH pass</span>
              <input type="password" className="input-field text-xs py-1 w-28" placeholder="••••••"
                onChange={e => applyAll('ssh_password', e.target.value)} />
            </div>
          </div>

          {/* Column headers — match row grid exactly */}
          <div className="grid px-4 py-2.5 shrink-0 sticky top-0 z-10"
            style={{
              gridTemplateColumns: '120px 90px 90px 150px 1fr 1fr',
              background: 'var(--bg-surface-2)',
              borderBottom: '1px solid var(--border-subtle)',
            }}>
            {[
              { icon: Tag,     label: 'Device Name *' },
              { icon: Monitor, label: 'OS Type' },
              { icon: Layers,  label: 'Group / Lab' },
              { icon: Network, label: 'IP Address' },
              { icon: User,    label: 'SSH Credentials' },
              { icon: User,    label: 'WinRM Credentials' },
            ].map((col, i) => (
              <div key={i} className="flex items-center gap-1">
                <col.icon size={10} style={{ color: 'var(--text-muted)' }} />
                <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {col.label}
                </span>
              </div>
            ))}
          </div>

          {/* Device rows */}
          <div className="overflow-y-auto flex-1 divide-y" style={{ '--divide-color': 'var(--border-subtle)' }}>
            {specs.map((s, idx) => (
              <div key={s.resultId}
                className="grid px-4 py-3 items-start gap-3 transition-colors hover:bg-white/[0.015]"
                style={{ gridTemplateColumns: '120px 90px 90px 150px 1fr 1fr' }}>

                {/* ── Device Name ────────────────────────────────────── */}
                <Field label="">
                  <input className={`${inp} ${!s.name.trim() ? 'border-rose-500/50' : ''}`}
                    value={s.name}
                    onChange={e => setField(s.resultId, 'name', e.target.value)}
                    placeholder="Device name" />
                  {s.hostname && s.hostname !== s.ip && (
                    <p className="text-[10px] mt-0.5 font-mono truncate" style={{ color: 'var(--text-faint)' }}
                       title={s.hostname}>{s.hostname}</p>
                  )}
                </Field>

                {/* ── OS Type ───────────────────────────────────────── */}
                <Field label="">
                  <select className={`${inp} ${s.os_type === 'unknown' ? 'border-amber-500/50' : ''}`}
                    value={s.os_type}
                    onChange={e => setField(s.resultId, 'os_type', e.target.value)}>
                    <option value="unknown" disabled>Unknown — pick one</option>
                    <option value="linux">Linux</option>
                    <option value="windows">Windows</option>
                  </select>
                </Field>

                {/* ── Group ─────────────────────────────────────────── */}
                <Field label="">
                  <select className={inp} value={s.group_id}
                    onChange={e => setField(s.resultId, 'group_id', e.target.value)}>
                    <option value="">No group</option>
                    {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </Field>

                {/* ── IP (read-only info) ───────────────────────────── */}
                <div className="flex flex-col gap-1 pt-1">
                  <span className="text-xs font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>{s.ip}</span>
                  {s.mac && (
                    <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{s.mac}</span>
                  )}
                </div>

                {/* ── SSH Credentials ───────────────────────────────── */}
                <div className="flex flex-col gap-1.5">
                  <Field label="Username">
                    <div className="relative">
                      <User size={10} className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-faint)' }} />
                      <input className={`${inp} pl-5`} placeholder="e.g. ubuntu"
                        value={s.ssh_username}
                        onChange={e => setField(s.resultId, 'ssh_username', e.target.value)} />
                    </div>
                  </Field>
                  <Field label="Password">
                    <div className="relative">
                      <Key size={10} className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-faint)' }} />
                      <input className={`${inp} pl-5 pr-6`}
                        type={showPw[s.resultId + '_ssh'] ? 'text' : 'password'}
                        placeholder="SSH password"
                        value={s.ssh_password}
                        onChange={e => setField(s.resultId, 'ssh_password', e.target.value)} />
                      <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2"
                        style={{ color: 'var(--text-faint)' }}
                        onClick={() => setShowPw(p => ({ ...p, [s.resultId + '_ssh']: !p[s.resultId + '_ssh'] }))}>
                        {showPw[s.resultId + '_ssh'] ? <EyeOff size={10} /> : <Eye size={10} />}
                      </button>
                    </div>
                  </Field>
                </div>

                {/* ── WinRM Credentials ─────────────────────────────── */}
                <div className="flex flex-col gap-1.5">
                  <Field label="Username">
                    <div className="relative">
                      <User size={10} className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-faint)' }} />
                      <input className={`${inp} pl-5`} placeholder="e.g. Administrator"
                        value={s.winrm_username}
                        onChange={e => setField(s.resultId, 'winrm_username', e.target.value)} />
                    </div>
                  </Field>
                  <Field label="Password">
                    <div className="relative">
                      <Key size={10} className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-faint)' }} />
                      <input className={`${inp} pl-5 pr-6`}
                        type={showPw[s.resultId + '_winrm'] ? 'text' : 'password'}
                        placeholder="WinRM password"
                        value={s.winrm_password}
                        onChange={e => setField(s.resultId, 'winrm_password', e.target.value)} />
                      <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2"
                        style={{ color: 'var(--text-faint)' }}
                        onClick={() => setShowPw(p => ({ ...p, [s.resultId + '_winrm']: !p[s.resultId + '_winrm'] }))}>
                        {showPw[s.resultId + '_winrm'] ? <EyeOff size={10} /> : <Eye size={10} />}
                      </button>
                    </div>
                  </Field>
                </div>

              </div>
            ))}
          </div>

          {/* Security note */}
          <div className="px-6 py-2.5 shrink-0 flex items-center gap-2"
            style={{ borderTop: '1px solid var(--border-subtle)', background: 'rgba(124,92,245,0.05)' }}>
            <Info size={11} style={{ color: '#a78bfa' }} />
            <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
              Credentials are AES-256 encrypted at rest and never exposed back to the browser.
            </p>
          </div>

          {/* Footer */}
          <div className="flex gap-3 px-6 py-4 shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
            <button onClick={handleSubmit} disabled={saving || specs.length === 0} className="btn-primary flex-1 justify-center">
              {saving
                ? <><Loader2 size={14} className="animate-spin" /> Importing…</>
                : <><Download size={14} /> Import {specs.length} Device{specs.length !== 1 ? 's' : ''}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ScanCard({ scan, expanded, onToggleExpand, onCancel, onDelete, onImported, canManageDevices }) {
  const [results,       setResults]       = useState([])
  const [loadingResults, setLoadingResults] = useState(false)
  const [selected,      setSelected]      = useState(new Set())
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importTargets, setImportTargets] = useState([])

  const loadResults = useCallback(async () => {
    setLoadingResults(true)
    try {
      const { data } = await api.get(`/discovery/scans/${scan.id}/results`)
      setResults(data)
    } catch { toast.error('Failed to load results') }
    finally { setLoadingResults(false) }
  }, [scan.id])

  useEffect(() => { if (expanded) loadResults() }, [expanded, loadResults])
  useEffect(() => {
    if (!expanded || scan.status !== 'running') return
    const t = setInterval(loadResults, 3000)
    return () => clearInterval(t)
  }, [expanded, scan.status, loadResults])

  const toggleSelect = (id) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const selectAll = () => setSelected(new Set(results.filter(r => !r.imported).map(r => r.id)))

  const openImportModal = () => {
    if (selected.size === 0) return
    setImportTargets(results.filter(r => selected.has(r.id)))
    setImportModalOpen(true)
  }

  const pct = scan.total_hosts > 0 ? Math.min(100, Math.round((scan.scanned_hosts / scan.total_hosts) * 100)) : 0

  return (
    <div className="glass rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 cursor-pointer" onClick={onToggleExpand}>
        {expanded ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-body font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{scan.name}</p>
            <StatusPill status={scan.status} />
          </div>
          <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {scan.cidr} · {(scan.methods || []).join(', ')} · by {scan.created_by_name || 'unknown'}
          </p>
        </div>
        {(scan.status === 'running' || scan.status === 'queued') && (
          <div className="w-32 hidden sm:block">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-input)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: '#38bdf8' }} />
            </div>
            <p className="text-[10px] font-mono mt-1 text-right" style={{ color: 'var(--text-muted)' }}>
              {scan.scanned_hosts}/{scan.total_hosts}
            </p>
          </div>
        )}
        {scan.status === 'completed' && (
          <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>{scan.alive_hosts} alive</span>
        )}
        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          {(scan.status === 'running' || scan.status === 'queued') && (
            <button onClick={() => onCancel(scan)} title="Cancel scan" className="icon-btn"><Square size={12} /></button>
          )}
          {scan.status !== 'running' && (
            <button onClick={() => onDelete(scan)} title="Delete scan" className="icon-btn hover:text-accent-red"><Trash2 size={12} /></button>
          )}
        </div>
      </div>

      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onDone={() => { setSelected(new Set()); loadResults(); onImported() }}
        scanId={scan.id}
        results={importTargets}
      />

      {expanded && (
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {scan.error && (
            <div className="px-5 py-3 text-xs font-body text-accent-red" style={{ background: 'rgba(248,113,113,0.06)' }}>
              {scan.error}
            </div>
          )}
          <div className="flex items-center justify-between px-5 py-3" style={{ background: 'var(--bg-input)' }}>
            <p className="text-[11px] font-body" style={{ color: 'var(--text-muted)' }}>
              {results.length} host{results.length !== 1 ? 's' : ''} discovered
            </p>
            {canManageDevices && (
              <div className="flex items-center gap-2">
                <button onClick={selectAll} className="text-[11px] font-body hover:underline" style={{ color: '#38bdf8' }}>
                  Select all
                </button>
                <button onClick={openImportModal} disabled={selected.size === 0}
                  className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40">
                  <Download size={12} />
                  Configure & Import {selected.size > 0 ? `(${selected.size})` : ''}
                </button>
              </div>
            )}
          </div>

          {/* Results table header */}
          <div className="grid gap-2 px-4 py-2 text-[10px] font-body font-bold uppercase tracking-wider"
            style={{ gridTemplateColumns: '24px 36px 130px 150px 150px 1fr', background: 'var(--bg-input)', color: 'var(--text-muted)' }}>
            <span /><span>OS</span><span>IP</span><span>MAC</span><span>Vendor</span><span>Open Ports</span>
          </div>

          {loadingResults ? (
            <div className="py-10 flex justify-center"><Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
          ) : results.length === 0 ? (
            <div className="py-10 text-center text-xs font-body" style={{ color: 'var(--text-muted)' }}>
              {scan.status === 'running' || scan.status === 'queued' ? 'Scanning…' : 'No hosts responded'}
            </div>
          ) : results.map(r => (
            <ResultRow key={r.id} r={r} selected={selected.has(r.id)} onToggle={toggleSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DiscoveryPage() {
  const [scans,       setScans]       = useState([])
  const [loading,     setLoading]     = useState(true)
  const [newScanOpen, setNewScanOpen] = useState(false)
  const [expandedId,  setExpandedId]  = useState(null)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const { can } = usePermissions()
  const canDiscover      = can(1024)
  const canManageDevices = can(2)

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/discovery/scans')
      setScans(data)
    } catch { toast.error('Failed to load scans') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const hasActive = scans.some(s => s.status === 'running' || s.status === 'queued')
    if (!hasActive) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [scans, load])

  const doCancel = async () => {
    if (!cancelTarget) return
    try {
      await api.post(`/discovery/scans/${cancelTarget.id}/cancel`)
      toast.success('Cancellation requested')
      setCancelTarget(null); load()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to cancel') }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    try {
      await api.delete(`/discovery/scans/${deleteTarget.id}`)
      toast.success('Scan deleted')
      setDeleteTarget(null); load()
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to delete') }
  }

  if (!canDiscover) return (
    <div className="p-6 flex flex-col items-center justify-center min-h-[60vh]">
      <Lock size={36} style={{ color: 'var(--text-muted)' }} className="mb-3" />
      <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>Network discovery access required</p>
    </div>
  )

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto animate-fade-in pb-10">
      <PageHeader icon={Radar} title="Network Discovery"
        description="ICMP ping sweep, SNMP, LLDP/CDP neighbors, nmap port scan and vendor detection"
        actions={
          <div className="flex gap-2">
            <button onClick={load} className="icon-btn"><RefreshCw size={13} /></button>
            <button onClick={() => setNewScanOpen(true)} className="btn-primary"><Plus size={14} /> New Scan</button>
          </div>
        }
      />

      {loading ? (
        <div className="py-16 flex justify-center"><Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-muted)' }} /></div>
      ) : scans.length === 0 ? (
        <div className="glass rounded-2xl py-16 flex flex-col items-center gap-3">
          <Radar size={28} style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm font-body" style={{ color: 'var(--text-muted)' }}>No discovery scans yet</p>
          <button onClick={() => setNewScanOpen(true)} className="btn-primary text-sm mt-1"><Plus size={13} /> Start your first scan</button>
        </div>
      ) : (
        <div className="space-y-3">
          {scans.map(scan => (
            <ScanCard key={scan.id} scan={scan}
              expanded={expandedId === scan.id}
              onToggleExpand={() => setExpandedId(expandedId === scan.id ? null : scan.id)}
              onCancel={setCancelTarget} onDelete={setDeleteTarget}
              onImported={load} canManageDevices={canManageDevices} />
          ))}
        </div>
      )}

      <NewScanModal open={newScanOpen} onClose={() => setNewScanOpen(false)} onCreated={load} />

      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setCancelTarget(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-sm rounded-2xl p-6 animate-slide-up"
            style={{ background: 'var(--bg-card)', border: '1px solid rgba(251,191,36,0.3)' }} onClick={e => e.stopPropagation()}>
            <h3 className="font-display text-base mb-1" style={{ color: 'var(--text-primary)' }}>Cancel "{cancelTarget.name}"?</h3>
            <p className="text-sm font-body mb-5" style={{ color: 'var(--text-muted)' }}>In-flight probes will finish; no new hosts will be scanned.</p>
            <div className="flex gap-3">
              <button onClick={() => setCancelTarget(null)} className="btn-ghost flex-1 justify-center">Keep running</button>
              <button onClick={doCancel} className="btn-danger flex-1 justify-center">Cancel Scan</button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setDeleteTarget(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-sm rounded-2xl p-6 animate-slide-up"
            style={{ background: 'var(--bg-card)', border: '1px solid rgba(248,113,113,0.3)' }} onClick={e => e.stopPropagation()}>
            <h3 className="font-display text-base mb-1" style={{ color: 'var(--text-primary)' }}>Delete "{deleteTarget.name}"?</h3>
            <p className="text-sm font-body mb-5" style={{ color: 'var(--text-muted)' }}>Removes the scan and all discovered results permanently.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteTarget(null)} className="btn-ghost flex-1 justify-center">Cancel</button>
              <button onClick={doDelete} className="btn-danger flex-1 justify-center">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}