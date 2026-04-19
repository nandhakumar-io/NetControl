// pages/AlertsPage.jsx — Enterprise alert management
import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Bell, BellOff, BellRing, Plus, Trash2, Pencil, X,
  AlertTriangle, CheckCircle2, Info, Cpu, HardDrive,
  WifiOff, Clock, RefreshCw, Power, RotateCcw, Activity,
  ToggleLeft, ToggleRight, List, Filter, ChevronDown,
  Shield, TrendingUp, Zap, Search, Calendar, MemoryStick
} from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import { useThemeStore } from '../store/themeStore'
import PageHeader from '../components/ui/PageHeader'

// ── Constants ─────────────────────────────────────────────────────────────────
const METRICS = [
  { v: 'cpu',           label: 'CPU Usage',      icon: Cpu,         unit: '%',  hasThresh: true  },
  { v: 'ram',           label: 'RAM Usage',       icon: MemoryStick, unit: '%',  hasThresh: true  },
  { v: 'disk',          label: 'Disk Usage',      icon: HardDrive,   unit: '%',  hasThresh: true  },
  { v: 'offline',       label: 'Device Offline',  icon: WifiOff,     unit: null, hasThresh: false },
  { v: 'process_count', label: 'Process Count',   icon: List,        unit: '',   hasThresh: true  },
]
const SEVERITIES = [
  { v: 'info',     label: 'Info',     hex: '#38bdf8', bg: 'rgba(56,189,248,0.09)',   border: 'rgba(56,189,248,0.22)'  },
  { v: 'warning',  label: 'Warning',  hex: '#fbbf24', bg: 'rgba(251,191,36,0.09)',   border: 'rgba(251,191,36,0.22)'  },
  { v: 'critical', label: 'Critical', hex: '#f87171', bg: 'rgba(248,113,113,0.09)',  border: 'rgba(248,113,113,0.22)' },
]
const COOLDOWNS = [
  {v:60,l:'1 min'},{v:300,l:'5 min'},{v:600,l:'10 min'},
  {v:1800,l:'30 min'},{v:3600,l:'1 hr'},{v:86400,l:'24 hr'},
]
const ACTIONS_DEF = [
  { v: 'notify',   label: 'Notify Admins', icon: Bell,      danger: false },
  { v: 'shutdown', label: 'Shutdown',       icon: Power,     danger: true  },
  { v: 'restart',  label: 'Restart',        icon: RotateCcw, danger: true  },
]
const EMPTY = {
  name:'', metric:'cpu', operator:'gt', threshold:90,
  severity:'warning', device_id:null, actions:['notify'],
  notify_admins:true, cooldown_sec:300, enabled:true,
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const sev  = (v) => SEVERITIES.find(s => s.v === v) || SEVERITIES[1]
const met  = (v) => METRICS.find(m => m.v === v)
const fmtTs = (ts) => {
  if (!ts) return '—'
  const d = new Date(ts * 1000), now = Date.now(), diff = now - d
  if (diff < 60e3)   return 'just now'
  if (diff < 3600e3) return `${Math.floor(diff/60e3)}m ago`
  if (diff < 86400e3)return `${Math.floor(diff/3600e3)}h ago`
  return d.toLocaleDateString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
}
const fmtCd = (s) => s<60?`${s}s`:s<3600?`${s/60|0}m`:`${s/3600|0}h`

// ── Reusable atoms ────────────────────────────────────────────────────────────
function SevBadge({ v, sm }) {
  const s = sev(v)
  return (
    <span className={`inline-flex items-center gap-1 font-bold uppercase tracking-wide rounded-full
      ${sm ? 'px-1.5 py-0.5 text-[9px]' : 'px-2.5 py-1 text-[10px]'}`}
      style={{background:s.bg, border:`1px solid ${s.border}`, color:s.hex}}>
      {v==='critical'?<AlertTriangle size={sm?7:9}/>:v==='info'?<Info size={sm?7:9}/>:<Bell size={sm?7:9}/>}
      {s.label}
    </span>
  )
}

function Toggle({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)}
      className={`w-10 h-5 rounded-full transition-all duration-200 relative shrink-0 border
        ${on ? 'border-indigo-500/50' : 'border-white/10'}`}
      style={{background: on ? 'rgba(99,102,241,0.7)' : 'rgba(255,255,255,0.06)'}}>
      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200
        ${on ? 'left-5' : 'left-0.5'}`} />
    </button>
  )
}

// ── Rule form modal ────────────────────────────────────────────────────────────
function RuleModal({ open, onClose, onSaved, rule, devices }) {
  const [form, setForm]   = useState(EMPTY)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setForm(rule ? {...EMPTY,...rule, actions:rule.actions||['notify']} : EMPTY)
  }, [open, rule])

  const set = (k,v) => setForm(f=>({...f,[k]:v}))
  const toggleAct = (a) => setForm(f=>({...f, actions: f.actions.includes(a)?f.actions.filter(x=>x!==a):[...f.actions,a]}))

  const save = async () => {
    if (!form.name.trim()) return toast.error('Name is required')
    setSaving(true)
    try {
      rule
        ? await api.put(`/alerts/rules/${rule.id}`, form)
        : await api.post('/alerts/rules', form)
      toast.success(rule ? 'Rule updated' : 'Rule created')
      onSaved(); onClose()
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed') }
    finally { setSaving(false) }
  }

  if (!open) return null
  const inp = 'input-field text-sm'
  const lbl = 'label'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/65 backdrop-blur-md" />
      <div className="relative z-10 w-full max-w-xl animate-slide-up" onClick={e=>e.stopPropagation()}>
        <div className="glass rounded-2xl overflow-hidden" style={{border:'1px solid rgba(255,255,255,0.1)'}}>
          <div className="h-px" style={{background:'linear-gradient(90deg,transparent,rgba(99,102,241,0.6),transparent)'}} />

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b" style={{borderColor:'var(--border-subtle)'}}>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{background:'rgba(251,191,36,0.12)',border:'1px solid rgba(251,191,36,0.25)'}}>
                <Bell size={15} className="text-amber-400" />
              </div>
              <h3 className="font-display text-base" style={{color:'var(--text-primary)'}}>
                {rule ? 'Edit Rule' : 'New Alert Rule'}
              </h3>
            </div>
            <button onClick={onClose} className="icon-btn p-1.5"><X size={15}/></button>
          </div>

          <div className="p-6 space-y-5 max-h-[72vh] overflow-y-auto">
            {/* Name */}
            <div>
              <label className={lbl}>Rule Name</label>
              <input className={inp} placeholder="e.g. High CPU on Lab PCs"
                value={form.name} onChange={e=>set('name',e.target.value)} autoFocus />
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Metric */}
              <div>
                <label className={lbl}>Metric</label>
                <select className={inp} value={form.metric} onChange={e=>set('metric',e.target.value)}>
                  {METRICS.map(m=><option key={m.v} value={m.v}>{m.label}</option>)}
                </select>
              </div>

              {/* Severity */}
              <div>
                <label className={lbl}>Severity</label>
                <div className="flex gap-2 mt-1">
                  {SEVERITIES.map(s=>(
                    <button key={s.v} onClick={()=>set('severity',s.v)}
                      className="flex-1 py-1.5 rounded-lg text-[11px] font-bold uppercase transition-all border"
                      style={form.severity===s.v
                        ?{background:s.bg,borderColor:s.border,color:s.hex}
                        :{background:'transparent',borderColor:'var(--border-subtle)',color:'var(--text-muted)'}}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Condition row */}
            {met(form.metric)?.hasThresh && (
              <div>
                <label className={lbl}>Condition</label>
                <div className="flex gap-2">
                  <select className={`${inp} w-32`} value={form.operator} onChange={e=>set('operator',e.target.value)}>
                    <option value="gt">Above &gt;</option>
                    <option value="lt">Below &lt;</option>
                  </select>
                  <div className="relative flex-1">
                    <input type="number" min={0} max={100} className={inp}
                      value={form.threshold} onChange={e=>set('threshold',parseFloat(e.target.value)||0)} />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs pointer-events-none"
                      style={{color:'var(--text-muted)'}}>{met(form.metric)?.unit}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              {/* Target */}
              <div>
                <label className={lbl}>Apply To</label>
                <select className={inp} value={form.device_id||''} onChange={e=>set('device_id',e.target.value||null)}>
                  <option value="">All Devices</option>
                  {devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>

              {/* Cooldown */}
              <div>
                <label className={lbl}>Repeat Cooldown</label>
                <select className={inp} value={form.cooldown_sec} onChange={e=>set('cooldown_sec',+e.target.value)}>
                  {COOLDOWNS.map(c=><option key={c.v} value={c.v}>{c.l}</option>)}
                </select>
              </div>
            </div>

            {/* Actions */}
            <div>
              <label className={lbl}>Actions on Trigger</label>
              <div className="flex gap-2 mt-1">
                {ACTIONS_DEF.map(a=>{
                  const Icon = a.icon
                  const on = form.actions.includes(a.v)
                  return (
                    <button key={a.v} onClick={()=>toggleAct(a.v)}
                      className="flex-1 flex flex-col items-center gap-1.5 py-3 rounded-xl border transition-all"
                      style={on
                        ? a.danger
                          ?{background:'rgba(248,113,113,0.12)',borderColor:'rgba(248,113,113,0.35)',color:'#f87171'}
                          :{background:'rgba(99,102,241,0.12)',borderColor:'rgba(129,140,248,0.35)',color:'#a5b4fc'}
                        :{background:'transparent',borderColor:'var(--border-subtle)',color:'var(--text-muted)'}}>
                      <Icon size={16}/>
                      <span className="text-[11px] font-semibold">{a.label}</span>
                      {a.danger && <span className="text-[9px] font-bold uppercase opacity-60">Destructive</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Options */}
            <div className="flex items-center gap-8 py-1">
              <label className="flex items-center gap-3 cursor-pointer">
                <Toggle on={form.notify_admins} onChange={v=>set('notify_admins',v)}/>
                <span className="text-sm" style={{color:'var(--text-secondary)'}}>Notify all admins</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <Toggle on={form.enabled} onChange={v=>set('enabled',v)}/>
                <span className="text-sm" style={{color:'var(--text-secondary)'}}>Rule enabled</span>
              </label>
            </div>
          </div>

          <div className="flex gap-3 px-6 pb-6">
            <button onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary flex-1 justify-center">
              {saving ? 'Saving…' : rule ? 'Update Rule' : 'Create Rule'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AlertsPage() {
  const [rules,     setRules]     = useState([])
  const [triggered, setTriggered] = useState([])
  const [devices,   setDevices]   = useState([])
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState('rules')
  const [showModal, setShowModal] = useState(false)
  const [editRule,  setEditRule]  = useState(null)
  const [search,    setSearch]    = useState('')
  const [sevFilt,   setSevFilt]   = useState('all')
  const { theme } = useThemeStore()
  const isLight = theme === 'light'

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true)
      const [r, t, d] = await Promise.all([
        api.get('/alerts/rules'),
        api.get('/alerts/triggered?limit=300'),
        api.get('/devices'),
      ])
      setRules(r.data)
      setTriggered(t.data)
      setDevices(d.data)
    } catch (e) {
      toast.error('Failed to load alert data')
      console.error(e)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])
  useEffect(() => {
    const t = setInterval(() => {
      api.get('/alerts/triggered?limit=300').then(r => setTriggered(r.data)).catch(()=>{})
    }, 30000)
    return () => clearInterval(t)
  }, [])

  const deleteRule = async (id) => {
    if (!confirm('Delete this alert rule?')) return
    try { await api.delete(`/alerts/rules/${id}`); toast.success('Deleted'); fetchAll() }
    catch { toast.error('Delete failed') }
  }

  const toggleRule = async (rule) => {
    try {
      await api.put(`/alerts/rules/${rule.id}`, {...rule, enabled:!rule.enabled})
      fetchAll()
    } catch { toast.error('Update failed') }
  }

  // Stats
  const activeRules = rules.filter(r=>r.enabled).length
  const crits   = triggered.filter(t=>t.severity==='critical').length
  const warns   = triggered.filter(t=>t.severity==='warning').length
  const last24h = triggered.filter(t=>t.triggered_at > Math.floor(Date.now()/1000)-86400).length

  // Filtered rules
  const filtRules = rules.filter(r => {
    if (sevFilt !== 'all' && r.severity !== sevFilt) return false
    if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  // Filtered triggered
  const filtTriggered = triggered.filter(t => {
    if (sevFilt !== 'all' && t.severity !== sevFilt) return false
    return true
  })

  // Stat cards config
  const stats = [
    { label:'Active Rules',   val: activeRules,         icon: Shield,        hex:'#818cf8' },
    { label:'Triggered Total',val: triggered.length,    icon: BellRing,      hex:'#fbbf24' },
    { label:'Critical',       val: crits,               icon: AlertTriangle, hex:'#f87171' },
    { label:'Last 24 Hours',  val: last24h,             icon: Clock,         hex:'#34d399' },
  ]

  const textPrimary   = { color: 'var(--text-primary)' }
  const textSecondary = { color: 'var(--text-secondary)' }
  const textMuted     = { color: 'var(--text-muted)' }
  const borderSubtle  = { borderColor: 'var(--border-subtle)' }

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6 animate-fade-in">

      {/* Header */}
      <PageHeader
        icon={Bell}
        title="Alert Rules"
        description="Automated monitoring thresholds and incident response"
        actions={
          <div className="flex gap-2">
            <button onClick={fetchAll} className="btn-ghost px-3"><RefreshCw size={14}/></button>
            <button onClick={()=>{setEditRule(null);setShowModal(true)}} className="btn-primary">
              <Plus size={14}/> New Rule
            </button>
          </div>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(s=>{
          const Icon = s.icon
          return (
            <div key={s.label} className="glass rounded-2xl p-5 flex items-center gap-4">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                style={{background:s.hex+'15',border:`1px solid ${s.hex}28`}}>
                <Icon size={20} style={{color:s.hex}}/>
              </div>
              <div>
                <p className="text-2xl font-display" style={{color:s.hex}}>{s.val}</p>
                <p className="text-xs font-body mt-0.5" style={textMuted}>{s.label}</p>
              </div>
            </div>
          )
        })}
      </div>

      {/* Tabs + filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Tabs */}
        <div className="flex gap-0.5 p-1 rounded-xl glass">
          {[['rules','Rules'],['history','History']].map(([v,l])=>(
            <button key={v} onClick={()=>setTab(v)}
              className={`px-4 py-2 rounded-lg text-sm font-body font-medium transition-all
                ${tab===v ? 'bg-indigo-500 text-white shadow-lg' : 'text-slate-400 hover:text-slate-200'}`}>
              {l}
              {v==='history' && triggered.length>0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-white/15">{triggered.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Search (rules only) */}
        {tab === 'rules' && (
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={textMuted}/>
            <input className="input-field pl-8 py-2 text-sm w-48"
              placeholder="Search rules…" value={search} onChange={e=>setSearch(e.target.value)}/>
          </div>
        )}

        {/* Severity filter */}
        <div className="flex gap-1">
          {['all','critical','warning','info'].map(s=>(
            <button key={s} onClick={()=>setSevFilt(s)}
              className={`chip text-xs ${sevFilt===s?'chip-selected':''}`}>
              {s==='all'?'All Severity':s.charAt(0).toUpperCase()+s.slice(1)}
            </button>
          ))}
        </div>

        <span className="ml-auto text-xs" style={textMuted}>
          {tab==='rules' ? `${filtRules.length} rule${filtRules.length!==1?'s':''}` : `${filtTriggered.length} events`}
        </span>
      </div>

      {/* ── Rules Tab ────────────────────────────────────────────────────── */}
      {tab === 'rules' && (
        <div className="space-y-3">
          {loading ? (
            Array.from({length:3}).map((_,i)=>(
              <div key={i} className="glass rounded-2xl h-24 animate-pulse"/>
            ))
          ) : filtRules.length === 0 ? (
            <div className="glass rounded-2xl py-20 flex flex-col items-center gap-4">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
                style={{background:'rgba(251,191,36,0.08)',border:'1px solid rgba(251,191,36,0.18)'}}>
                <BellOff size={24} className="text-amber-400 opacity-40"/>
              </div>
              <p className="text-sm font-body" style={textMuted}>
                {search || sevFilt!=='all' ? 'No rules match your filters' : 'No alert rules configured yet'}
              </p>
              {!search && sevFilt==='all' && (
                <button onClick={()=>{setEditRule(null);setShowModal(true)}} className="btn-primary">
                  <Plus size={14}/> Create your first rule
                </button>
              )}
            </div>
          ) : (
            filtRules.map(rule => {
              const m  = met(rule.metric)
              const MIcon = m?.icon || Activity
              const s  = sev(rule.severity)
              const fires = triggered.filter(t=>t.rule_id===rule.id).length
              return (
                <div key={rule.id}
                  className={`glass rounded-2xl p-5 transition-all ${!rule.enabled?'opacity-45':''}`}
                  style={{border: rule.enabled ? `1px solid ${s.border}` : '1px solid var(--border-subtle)'}}>
                  <div className="flex items-start gap-4">
                    {/* Icon */}
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
                      style={{background:s.bg, border:`1px solid ${s.border}`}}>
                      <MIcon size={18} style={{color:s.hex}}/>
                    </div>

                    {/* Body */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold" style={textPrimary}>{rule.name}</span>
                        <SevBadge v={rule.severity} sm/>
                        {!rule.enabled && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400 font-bold uppercase">
                            Disabled
                          </span>
                        )}
                      </div>

                      {/* Condition line */}
                      <p className="text-xs font-mono mt-1" style={textMuted}>
                        {m?.label}
                        {m?.hasThresh && ` ${rule.operator==='gt'?'>':'<'} ${rule.threshold}${m?.unit}`}
                        {' · '}cooldown {fmtCd(rule.cooldown_sec)}
                        {' · '}{rule.device_name ? `📍 ${rule.device_name}` : '🌐 All devices'}
                        {fires > 0 && <span className="ml-2 text-amber-400"> ⚡ {fires} fires</span>}
                      </p>

                      {/* Action chips */}
                      <div className="flex gap-1.5 mt-2.5 flex-wrap">
                        {(rule.actions||[]).map(a=>{
                          const ad = ACTIONS_DEF.find(x=>x.v===a)
                          if(!ad) return null
                          const Ic = ad.icon
                          return (
                            <span key={a}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
                              style={{
                                background: ad.danger?'rgba(248,113,113,0.08)':'rgba(99,102,241,0.08)',
                                border: `1px solid ${ad.danger?'rgba(248,113,113,0.2)':'rgba(129,140,248,0.2)'}`,
                                color: ad.danger?'#f87171':'#a5b4fc'
                              }}>
                              <Ic size={9}/> {ad.label}
                            </span>
                          )
                        })}
                      </div>
                    </div>

                    {/* Controls */}
                    <div className="flex items-center gap-2 shrink-0">
                      <Toggle on={rule.enabled} onChange={()=>toggleRule(rule)}/>
                      <button onClick={()=>{setEditRule(rule);setShowModal(true)}} className="icon-btn">
                        <Pencil size={14}/>
                      </button>
                      <button onClick={()=>deleteRule(rule.id)}
                        className="icon-btn hover:text-rose-400"
                        style={{'--hover-border':'rgba(248,113,113,0.3)'}}>
                        <Trash2 size={14}/>
                      </button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}

      {/* ── History Tab ───────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div>
          {loading ? (
            <div className="glass rounded-2xl h-64 animate-pulse"/>
          ) : filtTriggered.length === 0 ? (
            <div className="glass rounded-2xl py-20 flex flex-col items-center gap-3">
              <CheckCircle2 size={32} className="text-emerald-400 opacity-40"/>
              <p className="text-sm font-body" style={textMuted}>No alerts in history</p>
            </div>
          ) : (
            <div className="glass rounded-2xl overflow-hidden">
              {/* Table head */}
              <div className="grid px-5 py-3 border-b text-[11px] font-semibold uppercase tracking-wider"
                style={{...borderSubtle, ...textMuted,
                  gridTemplateColumns:'160px 1fr 140px 110px 90px'}}>
                <span>Time</span>
                <span>Details</span>
                <span>Device</span>
                <span>Metric</span>
                <span>Severity</span>
              </div>

              <div className="divide-y" style={borderSubtle}>
                {filtTriggered.slice(0,200).map((t,i)=>{
                  const s = sev(t.severity)
                  const m = met(t.metric)
                  return (
                    <div key={t.id||i}
                      className="grid px-5 py-3.5 items-center hover:bg-white/[0.015] transition-colors"
                      style={{gridTemplateColumns:'160px 1fr 140px 110px 90px'}}>
                      <span className="text-xs font-mono" style={textMuted}>{fmtTs(t.triggered_at)}</span>
                      <div className="pr-4 min-w-0">
                        <p className="text-sm truncate" style={textPrimary}>
                          {t.details || t.rule_name || '—'}
                        </p>
                        {t.rule_name && t.details && (
                          <p className="text-[11px] truncate mt-0.5" style={textMuted}>{t.rule_name}</p>
                        )}
                      </div>
                      <span className="text-xs truncate" style={textSecondary}>{t.device_name||'—'}</span>
                      <span className="text-xs" style={textMuted}>{m?.label||t.metric}</span>
                      <SevBadge v={t.severity} sm/>
                    </div>
                  )
                })}
              </div>

              {filtTriggered.length > 200 && (
                <div className="px-5 py-3 text-xs text-center border-t" style={{...borderSubtle,...textMuted}}>
                  Showing 200 of {filtTriggered.length} events
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <RuleModal
        open={showModal}
        onClose={()=>setShowModal(false)}
        onSaved={fetchAll}
        rule={editRule}
        devices={devices}
      />
    </div>
  )
}

