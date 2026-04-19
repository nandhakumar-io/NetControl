import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Activity, RefreshCw, Wifi, WifiOff, AlertTriangle,
  Clock, ScrollText, ChevronRight, TrendingUp, TrendingDown,
  Minus, Server, Cpu, MemoryStick, HardDrive, Bell,
  CheckCircle, XCircle, AlertCircle, Radio, Zap, Shield
} from 'lucide-react'
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine
} from 'recharts'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import toast from 'react-hot-toast'
import { useThemeStore } from '../store/themeStore'
import { useAuthStore } from '../store/authStore'
import ActionConfirmModal from '../components/modals/ActionConfirmModal'

// ─── Constants ────────────────────────────────────────────────────────────────
const UPTIME_BUCKETS   = 90   // 90 × 20s = 30 min of uptime history per device
const FLEET_HISTORY    = 60   // fleet-wide metric rolling window
const REFRESH_MS       = 15000

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtTime       = ts => ts ? new Date(ts*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '—'
const fmtDateTime   = ts => ts ? new Date(ts*1000).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'
const fmtUptime     = s => {
  if (!s) return '—'
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60)
  if (d>0) return `${d}d ${h}h`
  if (h>0) return `${h}h ${m}m`
  return `${m}m`
}
const fmtBytes      = b => { if(!b) return '—'; const u=['B','KB','MB','GB','TB']; let i=0; while(b>=1024&&i<4){b/=1024;i++} return `${b.toFixed(1)}${u[i]}` }
const pct           = (u,t) => t ? Math.round(u/t*100) : 0
const isStale       = (ts,s=35) => !ts||(Math.floor(Date.now()/1000)-ts)>s
const cpuColor      = v => !v?'#475569':v>=90?'#ef4444':v>=70?'#f97316':v>=50?'#eab308':'#22c55e'
const ramColor      = v => v>=90?'#ef4444':v>=75?'#f97316':v>=60?'#eab308':'#22c55e'
const statusColor   = s => s==='online'?'#22c55e':s==='offline'?'#ef4444':'#475569'
const sevColor      = s => s==='critical'?'#ef4444':s==='warning'?'#f97316':'#38bdf8'

const TT_STYLE = {
  background:'rgba(8,8,20,0.97)', border:'1px solid rgba(255,255,255,0.08)',
  borderRadius:8, fontSize:11, fontFamily:'monospace', padding:'8px 12px'
}

// ─── Micro sparkline ──────────────────────────────────────────────────────────
function Spark({ data, color='#818cf8', height=28 }) {
  if (!data?.length) return <div style={{height}} className="flex items-center justify-center opacity-20 text-[9px] font-mono text-slate-500">no data</div>
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{top:2,right:0,left:0,bottom:2}}>
        <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false}/>
      </LineChart>
    </ResponsiveContainer>
  )
}

// ─── Uptime pill strip (Statuspage-style) ─────────────────────────────────────
function UptimeStrip({ buckets = [], height = 20 }) {
  // buckets: array of 'online'|'offline'|'unknown', oldest→newest
  const display = [...Array(UPTIME_BUCKETS)].map((_, i) => buckets[buckets.length - UPTIME_BUCKETS + i] ?? 'unknown')
  const uptimePct = (() => {
    const known = display.filter(b => b !== 'unknown')
    if (!known.length) return null
    return Math.round(known.filter(b => b === 'online').length / known.length * 100)
  })()

  return (
    <div>
      <div className="flex gap-px items-end" style={{height}}>
        {display.map((b, i) => (
          <div key={i} className="flex-1 rounded-[2px] transition-opacity"
            style={{
              height: b === 'offline' ? height * 0.5 : b === 'unknown' ? height * 0.3 : height,
              background: b === 'online' ? '#22c55e' : b === 'offline' ? '#ef4444' : 'rgba(255,255,255,0.08)',
              opacity: b === 'unknown' ? 0.4 : 1,
            }}
          />
        ))}
      </div>
      {uptimePct !== null && (
        <p className="text-[9px] font-mono mt-1" style={{color: uptimePct>=99?'#22c55e':uptimePct>=95?'#eab308':'#ef4444'}}>
          {uptimePct}% uptime
        </p>
      )}
    </div>
  )
}

// ─── Gauge ring ───────────────────────────────────────────────────────────────
function Gauge({ value, color, size=56, label }) {
  const r = size/2 - 5
  const circ = 2*Math.PI*r
  const dash  = (Math.min(100, value||0)/100)*circ
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{width:size,height:size}}>
        <svg width={size} height={size} style={{transform:'rotate(-90deg)'}}>
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5"/>
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="5"
            strokeDasharray={`${dash} ${circ-dash}`} strokeLinecap="round"
            style={{transition:'stroke-dasharray 0.6s ease'}}/>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[11px] font-mono font-bold" style={{color}}>
            {value==null?'—':`${Math.round(value)}%`}
          </span>
        </div>
      </div>
      {label && <span className="text-[9px] font-mono uppercase tracking-wider" style={{color:'var(--text-muted)'}}>{label}</span>}
    </div>
  )
}

// ─── Section label ────────────────────────────────────────────────────────────
function SectionLabel({ children, action }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="text-[10px] font-body font-bold uppercase tracking-[0.12em]" style={{color:'var(--text-muted)'}}>{children}</span>
      {action && <button onClick={action.fn} className="text-[10px] font-body flex items-center gap-0.5 opacity-60 hover:opacity-100 transition-opacity" style={{color:'var(--text-muted)'}}>{action.label}<ChevronRight size={9}/></button>}
    </div>
  )
}

// ─── Stat card ────────────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, sub, color='#818cf8', trend, spark }) {
  return (
    <div className="glass rounded-2xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{background:`${color}15`,border:`1px solid ${color}30`}}>
          <Icon size={14} style={{color}}/>
        </div>
        {trend!=null && (
          <span className={`flex items-center gap-0.5 text-[10px] font-mono font-bold ${trend>0?'text-accent-green':trend<0?'text-accent-red':'text-slate-500'}`}>
            {trend>0?<TrendingUp size={9}/>:trend<0?<TrendingDown size={9}/>:<Minus size={9}/>}
            {trend!==0&&Math.abs(trend)+'%'}
          </span>
        )}
      </div>
      {spark ? <Spark data={spark} color={color} height={24}/> : <div className="h-6"/>}
      <div>
        <p className="text-xl font-display font-bold leading-none" style={{color}}>{value}</p>
        <p className="text-[10px] font-body font-bold uppercase tracking-widest mt-1" style={{color:'var(--text-muted)'}}>{label}</p>
        {sub && <p className="text-[10px] font-body mt-0.5" style={{color:'var(--text-faint)'}}>{sub}</p>}
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [devices,    setDevices]    = useState([])
  const [groups,     setGroups]     = useState([])
  const [metrics,    setMetrics]    = useState({})
  const [alerts,     setAlerts]     = useState([])
  const [auditLog,   setAuditLog]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh,setLastRefresh]= useState(null)
  const [actionModal,setActionModal]= useState(null)

  // Uptime buckets: deviceId → string[] of 'online'|'offline'|'unknown'
  const uptimeBuckets = useRef({})
  // Fleet history: [{t, online, offline, cpu, ram}]
  const fleetHistory  = useRef([])

  const navigate = useNavigate()
  const { theme } = useThemeStore()
  const user = useAuthStore(s => s.user)

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchAll = useCallback(async (quiet=false) => {
    if (!quiet) setLoading(true); else setRefreshing(true)
    try {
      const [devR,grpR,metR,altR,audR] = await Promise.allSettled([
        api.get('/devices'),
        api.get('/groups'),
        api.get('/metrics'),
        api.get('/alerts/triggered?limit=10'),
        api.get('/audit?limit=10'),
      ])

      const devs  = devR.status==='fulfilled' ? (devR.value.data||[])  : devices
      const grps  = grpR.status==='fulfilled' ? (grpR.value.data||[])  : groups
      const mets  = metR.status==='fulfilled' ? (metR.value.data||{})  : metrics
      const alts  = altR.status==='fulfilled' ? (Array.isArray(altR.value.data)?altR.value.data:altR.value.data?.logs||[]) : alerts
      const auds  = audR.status==='fulfilled' ? (audR.value.data?.logs||audR.value.data||[]) : auditLog

      setDevices(devs)
      setGroups(grps)
      setMetrics(mets)
      setAlerts(alts)
      setAuditLog(auds)

      // ── Record uptime bucket per device ──────────────────────────────────
      const now = Date.now()
      const buckets = uptimeBuckets.current
      for (const d of devs) {
        if (!buckets[d.id]) buckets[d.id] = []
        buckets[d.id].push(d.status || 'unknown')
        if (buckets[d.id].length > UPTIME_BUCKETS * 2) buckets[d.id].shift()
      }

      // ── Fleet history snapshot ────────────────────────────────────────────
      const online  = devs.filter(d=>d.status==='online').length
      const offline = devs.filter(d=>d.status==='offline').length
      const metVals = Object.values(mets).map(m=>m.latest).filter(m=>m&&!isStale(m.ts))
      const avgCpu  = metVals.length ? metVals.reduce((s,m)=>s+(m.cpu||0),0)/metVals.length : null
      const avgRam  = metVals.length ? metVals.reduce((s,m)=>s+(m.ram?pct(m.ram.used,m.ram.total):0),0)/metVals.length : null

      const hist = fleetHistory.current
      hist.push({
        t: new Date(now).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
        online, offline,
        cpu: avgCpu!=null ? Math.round(avgCpu*10)/10 : null,
        ram: avgRam!=null ? Math.round(avgRam) : null,
      })
      if (hist.length > FLEET_HISTORY) hist.shift()

      setLastRefresh(now)
    } catch(e) {
      if (!quiet) toast.error('Failed to load dashboard')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, []) // eslint-disable-line

  useEffect(() => { fetchAll() }, [fetchAll])
  useEffect(() => {
    const t = setInterval(() => fetchAll(true), REFRESH_MS)
    return () => clearInterval(t)
  }, [fetchAll])

  // ── Derived metrics ────────────────────────────────────────────────────────
  const online  = devices.filter(d=>d.status==='online').length
  const offline = devices.filter(d=>d.status==='offline').length
  const unknown = devices.filter(d=>!d.status||d.status==='unknown').length
  const fleetPct = devices.length ? Math.round(online/devices.length*100) : 0

  const metVals = useMemo(() =>
    Object.entries(metrics).map(([id,m])=>({id,...m.latest})).filter(m=>m.ts&&!isStale(m.ts)),
  [metrics])

  const avgCpu = metVals.length ? metVals.reduce((s,m)=>s+(m.cpu||0),0)/metVals.length : null
  const avgRam = metVals.length ? metVals.reduce((s,m)=>s+(m.ram?pct(m.ram.used,m.ram.total):0),0)/metVals.length : null
  const avgDisk = useMemo(() => {
    const withDisk = metVals.filter(m=>m.disk?.length)
    if (!withDisk.length) return null
    const p = withDisk.map(m=>m.disk.reduce((s,d)=>s+pct(d.used,d.total),0)/m.disk.length)
    return p.reduce((a,b)=>a+b,0)/p.length
  }, [metVals])

  const critAlerts = alerts.filter(a=>a.severity==='critical').length

  // top cpu, ram consumers
  const topCpu = useMemo(() =>
    [...metVals].sort((a,b)=>(b.cpu||0)-(a.cpu||0)).slice(0,6)
      .map(m=>({...m, device: devices.find(d=>d.id===m.id)}))
      .filter(m=>m.device),
  [metVals, devices])

  const topRam = useMemo(() =>
    [...metVals].filter(m=>m.ram).sort((a,b)=>pct(b.ram.used,b.ram.total)-pct(a.ram.used,a.ram.total)).slice(0,5)
      .map(m=>({...m, ramPct: pct(m.ram.used,m.ram.total), device: devices.find(d=>d.id===m.id)}))
      .filter(m=>m.device),
  [metVals, devices])

  // offline devices sorted by last_seen desc
  const offlineDevices = useMemo(() =>
    devices.filter(d=>d.status==='offline').sort((a,b)=>(b.last_seen||0)-(a.last_seen||0)).slice(0,8),
  [devices])

  // per-group uptime
  const groupUptime = useMemo(() =>
    groups.map(g => {
      const gDevs = devices.filter(d=>d.group_id===g.id)
      const on = gDevs.filter(d=>d.status==='online').length
      const pctVal = gDevs.length ? Math.round(on/gDevs.length*100) : null
      const color = pctVal==null?'#475569':pctVal>=90?'#22c55e':pctVal>=70?'#eab308':'#ef4444'
      const combinedBuckets = gDevs.length ? (() => {
        const len = UPTIME_BUCKETS
        return [...Array(len)].map((_,i) => {
          const slice = gDevs.map(d=>(uptimeBuckets.current[d.id]||[])[
            (uptimeBuckets.current[d.id]||[]).length - len + i
          ]).filter(Boolean)
          if (!slice.length) return 'unknown'
          const onCnt = slice.filter(s=>s==='online').length
          if (onCnt===slice.length) return 'online'
          if (onCnt===0) return 'offline'
          return 'partial'
        })
      })() : []
      return { ...g, gDevs, on, pctVal, color, combinedBuckets }
    }),
  [groups, devices])

  // fleet history for charts
  const histData = fleetHistory.current

  // sparklines per stat card
  const onlineSpark = histData.map(h=>({v:h.online}))
  const cpuSpark    = histData.map(h=>({v:h.cpu})).filter(h=>h.v!=null)
  const ramSpark    = histData.map(h=>({v:h.ram})).filter(h=>h.v!=null)

  const executeAction = async (pin) => {
    const {type,target} = actionModal
    if (target?.groupId) {
      const {data} = await api.post(`/actions/${type}`,{groupId:target.groupId,actionPin:pin})
      fetchAll(true); return data
    }
    const {data} = await api.post(`/actions/${type}`,{deviceId:target.id,actionPin:pin})
    fetchAll(true); return data
  }

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen" style={{background:'var(--bg-page)'}}>
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 rounded-2xl glass flex items-center justify-center">
          <Activity size={18} className="animate-pulse" style={{color:'#818cf8'}}/>
        </div>
        <p className="text-xs font-mono" style={{color:'var(--text-muted)'}}>Loading fleet data…</p>
      </div>
    </div>
  )

  const hour = new Date().getHours()
  const greeting = hour<12?'Good morning':hour<17?'Good afternoon':'Good evening'
  const fleetColor = fleetPct>=90?'#22c55e':fleetPct>=60?'#eab308':'#ef4444'

  return (
    <div className="p-5 space-y-5 animate-fade-in max-w-[1600px] mx-auto pb-10">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-display font-bold" style={{color:'var(--text-primary)'}}>
            {greeting}, <span style={{color:'#818cf8'}}>{user?.username}</span>
          </h1>
          <p className="text-[11px] font-mono mt-0.5" style={{color:'var(--text-muted)'}}>
            {new Date().toLocaleDateString([],{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
            {lastRefresh && <span className="ml-3 opacity-50">· refreshed {fmtTime(lastRefresh/1000)}</span>}
          </p>
        </div>
        <button onClick={()=>fetchAll(true)} disabled={refreshing}
          className="icon-btn" title="Refresh">
          <RefreshCw size={13} className={refreshing?'animate-spin':''}/>
        </button>
      </div>

      {/* ── Critical banner ──────────────────────────────────────────────── */}
      {critAlerts>0 && (
        <button onClick={()=>navigate('/alerts')} className="w-full text-left">
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl"
            style={{background:'rgba(239,68,68,0.07)',border:'1px solid rgba(239,68,68,0.25)'}}>
            <AlertTriangle size={13} style={{color:'#ef4444',flexShrink:0}}/>
            <p className="text-sm font-body font-semibold" style={{color:'#ef4444'}}>
              {critAlerts} critical alert{critAlerts>1?'s':''} require attention
            </p>
            <ChevronRight size={12} style={{color:'#ef4444',marginLeft:'auto'}}/>
          </div>
        </button>
      )}

      {/* ── Row 1: KPI stat cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard icon={Server}       label="Fleet"      value={devices.length}
          sub={`${groups.length} groups`} color="#818cf8" spark={onlineSpark}/>
        <StatCard icon={Wifi}         label="Online"     value={online}
          sub={`${fleetPct}% healthy`}   color="#22c55e" spark={onlineSpark}
          trend={histData.length>2?(online-(histData[histData.length-3]?.online||online)):null}/>
        <StatCard icon={WifiOff}      label="Offline"    value={offline}
          sub={`${unknown} unknown`}     color={offline>0?'#ef4444':'#475569'}/>
        <StatCard icon={Cpu}          label="Avg CPU"    value={avgCpu!=null?`${avgCpu.toFixed(1)}%`:'—'}
          sub={`${metVals.length} reporting`} color={cpuColor(avgCpu)} spark={cpuSpark}/>
        <StatCard icon={MemoryStick}  label="Avg RAM"    value={avgRam!=null?`${Math.round(avgRam)}%`:'—'}
          sub="memory used"              color={avgRam!=null?ramColor(avgRam):'#475569'} spark={ramSpark}/>
        <StatCard icon={Bell}         label="Alerts"     value={alerts.length}
          sub={`${critAlerts} critical`} color={critAlerts>0?'#ef4444':'#eab308'}/>
      </div>

      {/* ── Row 2: Fleet health + uptime timeline ──────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Fleet status bar + gauges */}
        <div className="glass rounded-2xl p-5">
          <SectionLabel>Fleet Health</SectionLabel>

          {/* Big uptime % with ring */}
          <div className="flex items-center gap-6 mb-5">
            <div className="relative">
              <svg width={88} height={88} style={{transform:'rotate(-90deg)'}}>
                <circle cx={44} cy={44} r={36} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="7"/>
                <circle cx={44} cy={44} r={36} fill="none" stroke={fleetColor} strokeWidth="7"
                  strokeDasharray={`${(fleetPct/100)*226} ${226-(fleetPct/100)*226}`}
                  strokeLinecap="round" style={{transition:'all 0.8s ease'}}/>
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-display font-bold leading-none" style={{color:fleetColor}}>{fleetPct}%</span>
                <span className="text-[8px] font-mono uppercase tracking-wider mt-0.5" style={{color:'var(--text-faint)'}}>online</span>
              </div>
            </div>
            <div className="flex-1 space-y-2">
              {[
                {label:'Online',  v:online,  c:'#22c55e'},
                {label:'Offline', v:offline, c:'#ef4444'},
                {label:'Unknown', v:unknown, c:'#475569'},
              ].map(({label,v,c})=>(
                <div key={label} className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{background:c}}/>
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.06)'}}>
                    <div className="h-full rounded-full transition-all duration-700" style={{width:`${devices.length?v/devices.length*100:0}%`,background:c}}/>
                  </div>
                  <span className="text-[11px] font-mono w-6 text-right font-bold" style={{color:c}}>{v}</span>
                  <span className="text-[10px] font-body w-12" style={{color:'var(--text-muted)'}}>{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Resource gauges */}
          <div className="grid grid-cols-3 gap-3 pt-4" style={{borderTop:'1px solid var(--border-subtle)'}}>
            <Gauge value={avgCpu!=null?Math.round(avgCpu):null} color={cpuColor(avgCpu)} label="CPU" size={52}/>
            <Gauge value={avgRam!=null?Math.round(avgRam):null} color={avgRam!=null?ramColor(avgRam):'#475569'} label="RAM" size={52}/>
            <Gauge value={avgDisk!=null?Math.round(avgDisk):null} color={avgDisk!=null?ramColor(avgDisk):'#475569'} label="Disk" size={52}/>
          </div>
        </div>

        {/* Fleet history chart */}
        <div className="lg:col-span-2 glass rounded-2xl p-5">
          <SectionLabel action={{label:'Monitoring',fn:()=>navigate('/monitoring')}}>
            Fleet History — Online / CPU / RAM
          </SectionLabel>
          {histData.length > 2 ? (
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={histData} margin={{top:4,right:0,left:-22,bottom:0}}>
                <defs>
                  <linearGradient id="gOnline" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="gCpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#818cf8" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#818cf8" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="gRam" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#06b6d4" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false}/>
                <XAxis dataKey="t" tick={{fontSize:9,fill:'#475569'}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
                <YAxis tick={{fontSize:9,fill:'#475569'}} tickLine={false} axisLine={false}/>
                <Tooltip contentStyle={TT_STYLE} labelStyle={{color:'#94a3b8',marginBottom:4,fontSize:10}}/>
                <Area type="monotone" dataKey="online" name="Online" stroke="#22c55e" strokeWidth={2} fill="url(#gOnline)" dot={false}/>
                <Area type="monotone" dataKey="cpu"    name="CPU %"  stroke="#818cf8" strokeWidth={1.5} fill="url(#gCpu)" dot={false}/>
                <Area type="monotone" dataKey="ram"    name="RAM %"  stroke="#06b6d4" strokeWidth={1.5} fill="url(#gRam)" dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[170px] flex items-center justify-center opacity-30">
              <div className="text-center">
                <Activity size={20} className="mx-auto mb-2" style={{color:'var(--text-muted)'}}/>
                <p className="text-[11px] font-mono" style={{color:'var(--text-muted)'}}>Collecting data — refreshes every {REFRESH_MS/1000}s</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Row 3: Group uptime strips ────────────────────────────────────── */}
      {groupUptime.length > 0 && (
        <div className="glass rounded-2xl p-5">
          <SectionLabel action={{label:'Groups',fn:()=>navigate('/groups')}}>
            Group Availability — Last {Math.round(UPTIME_BUCKETS*REFRESH_MS/60000)} min
          </SectionLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {groupUptime.map(g => (
              <div key={g.id} className="p-3 rounded-xl" style={{background:'var(--bg-surface-4)',border:'1px solid var(--border-subtle)'}}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{background:g.color}}/>
                    <span className="text-xs font-body font-semibold truncate" style={{color:'var(--text-primary)'}}>{g.name}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] font-mono" style={{color:'var(--text-muted)'}}>{g.on}/{g.gDevs.length}</span>
                    <span className="text-[11px] font-mono font-bold" style={{color:g.color}}>
                      {g.pctVal!=null?`${g.pctVal}%`:'—'}
                    </span>
                  </div>
                </div>
                {/* Statuspage-style strip using combined group buckets */}
                <div className="flex gap-px items-end" style={{height:18}}>
                  {(g.combinedBuckets.length ? g.combinedBuckets : Array(UPTIME_BUCKETS).fill('unknown')).map((b,i)=>(
                    <div key={i} className="flex-1 rounded-[2px]"
                      style={{
                        height: b==='offline'?9 : b==='partial'?13 : b==='unknown'?5 : 18,
                        background: b==='online'?'#22c55e' : b==='partial'?'#eab308' : b==='offline'?'#ef4444' : 'rgba(255,255,255,0.08)',
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Row 4: Top consumers + offline devices ───────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Top CPU consumers */}
        <div className="glass rounded-2xl overflow-hidden">
          <div className="px-5 py-3 flex items-center justify-between" style={{borderBottom:'1px solid var(--border-subtle)'}}>
            <SectionLabel>Top CPU Consumers</SectionLabel>
            <button onClick={()=>navigate('/monitoring')} className="text-[10px] font-body opacity-60 hover:opacity-100 transition-opacity flex items-center gap-0.5" style={{color:'var(--text-muted)'}}>All<ChevronRight size={9}/></button>
          </div>
          {topCpu.length===0 ? (
            <div className="py-8 text-center opacity-30">
              <Cpu size={18} className="mx-auto mb-2" style={{color:'var(--text-muted)'}}/>
              <p className="text-[11px] font-mono" style={{color:'var(--text-muted)'}}>No agent metrics</p>
            </div>
          ) : topCpu.map((m,i) => {
            const c = cpuColor(m.cpu)
            const hist = metrics[m.id]?.history?.slice(-20).map(h=>({v:h.cpu})) || []
            return (
              <div key={m.id} className="flex items-center gap-3 px-5 py-2.5 group transition-colors"
                style={{borderBottom:i<topCpu.length-1?'1px solid var(--border-subtle)':'none'}}
                onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <span className="text-[10px] font-mono w-4 shrink-0" style={{color:'var(--text-faint)'}}>{i+1}</span>
                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{background:statusColor(m.device.status)}}/>
                <span className="text-xs font-body font-medium flex-1 truncate" style={{color:'var(--text-primary)'}}>{m.device.name}</span>
                <div className="w-16 shrink-0"><Spark data={hist} color={c} height={20}/></div>
                <div className="w-10 text-right shrink-0">
                  <span className="text-[11px] font-mono font-bold" style={{color:c}}>{m.cpu?.toFixed(1)}%</span>
                </div>
                <div className="w-20 shrink-0">
                  <div className="w-full h-1.5 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.06)'}}>
                    <div className="h-full rounded-full transition-all" style={{width:`${Math.min(100,m.cpu||0)}%`,background:c}}/>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Top RAM consumers */}
        <div className="glass rounded-2xl overflow-hidden">
          <div className="px-5 py-3 flex items-center justify-between" style={{borderBottom:'1px solid var(--border-subtle)'}}>
            <SectionLabel>Top RAM Consumers</SectionLabel>
            <button onClick={()=>navigate('/monitoring')} className="text-[10px] font-body opacity-60 hover:opacity-100 transition-opacity flex items-center gap-0.5" style={{color:'var(--text-muted)'}}>All<ChevronRight size={9}/></button>
          </div>
          {topRam.length===0 ? (
            <div className="py-8 text-center opacity-30">
              <MemoryStick size={18} className="mx-auto mb-2" style={{color:'var(--text-muted)'}}/>
              <p className="text-[11px] font-mono" style={{color:'var(--text-muted)'}}>No agent metrics</p>
            </div>
          ) : topRam.map((m,i) => {
            const c = ramColor(m.ramPct)
            return (
              <div key={m.id} className="flex items-center gap-3 px-5 py-2.5 transition-colors"
                style={{borderBottom:i<topRam.length-1?'1px solid var(--border-subtle)':'none'}}
                onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <span className="text-[10px] font-mono w-4 shrink-0" style={{color:'var(--text-faint)'}}>{i+1}</span>
                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{background:statusColor(m.device.status)}}/>
                <span className="text-xs font-body font-medium flex-1 truncate" style={{color:'var(--text-primary)'}}>{m.device.name}</span>
                <div className="text-right shrink-0 w-24">
                  <p className="text-[11px] font-mono font-bold" style={{color:c}}>{m.ramPct}%</p>
                  <p className="text-[9px] font-mono" style={{color:'var(--text-faint)'}}>
                    {fmtBytes(m.ram.used*1024*1024)} / {fmtBytes(m.ram.total*1024*1024)}
                  </p>
                </div>
                <div className="w-20 shrink-0">
                  <div className="w-full h-1.5 rounded-full overflow-hidden" style={{background:'rgba(255,255,255,0.06)'}}>
                    <div className="h-full rounded-full transition-all" style={{width:`${m.ramPct}%`,background:c}}/>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Row 5: Offline devices + recent alerts + audit ───────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Offline devices */}
        <div className="glass rounded-2xl overflow-hidden">
          <div className="px-5 py-3" style={{borderBottom:'1px solid var(--border-subtle)'}}>
            <SectionLabel>Offline Devices {offlineDevices.length>0&&<span className="ml-1 px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold bg-accent-red/15 text-accent-red">{offlineDevices.length}</span>}</SectionLabel>
          </div>
          {offlineDevices.length===0 ? (
            <div className="py-8 flex flex-col items-center gap-2 opacity-50">
              <CheckCircle size={20} style={{color:'#22c55e'}}/>
              <p className="text-xs font-body" style={{color:'var(--text-muted)'}}>All devices online</p>
            </div>
          ) : offlineDevices.map((d,i)=>(
            <div key={d.id} className="flex items-center gap-3 px-5 py-2.5 group transition-colors"
              style={{borderBottom:i<offlineDevices.length-1?'1px solid var(--border-subtle)':'none'}}
              onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-accent-red"/>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-body font-medium truncate" style={{color:'var(--text-primary)'}}>{d.name}</p>
                <p className="text-[10px] font-mono truncate" style={{color:'var(--text-faint)'}}>{d.ip_address}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[9px] font-mono" style={{color:'var(--text-faint)'}}>last seen</p>
                <p className="text-[10px] font-mono" style={{color:'var(--text-muted)'}}>{fmtTime(d.last_seen)}</p>
              </div>
              <button
                onClick={()=>setActionModal({type:'wake',target:d,label:`Wake ${d.name}`,danger:false})}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg shrink-0"
                style={{background:'rgba(34,197,94,0.12)',border:'1px solid rgba(34,197,94,0.25)',color:'#22c55e'}}>
                <Zap size={10}/>
              </button>
            </div>
          ))}
        </div>

        {/* Recent alerts */}
        <div className="glass rounded-2xl overflow-hidden">
          <div className="px-5 py-3" style={{borderBottom:'1px solid var(--border-subtle)'}}>
            <SectionLabel action={{label:'All',fn:()=>navigate('/alerts')}}>Recent Alerts</SectionLabel>
          </div>
          {alerts.length===0 ? (
            <div className="py-8 flex flex-col items-center gap-2 opacity-50">
              <Shield size={20} style={{color:'#22c55e'}}/>
              <p className="text-xs font-body" style={{color:'var(--text-muted)'}}>No alerts</p>
            </div>
          ) : alerts.slice(0,6).map((a,i)=>{
            const Ic = a.severity==='critical'?XCircle:a.severity==='warning'?AlertCircle:AlertTriangle
            return (
              <div key={a.id||i} className="flex items-start gap-3 px-5 py-2.5 transition-colors"
                style={{borderBottom:i<Math.min(alerts.length-1,5)?'1px solid var(--border-subtle)':'none'}}
                onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <Ic size={12} className="mt-0.5 shrink-0" style={{color:sevColor(a.severity)}}/>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-body font-semibold truncate" style={{color:'var(--text-primary)'}}>{a.rule_name||a.metric}</p>
                  <p className="text-[10px] font-mono truncate" style={{color:'var(--text-muted)'}}>{a.device_name||'—'}</p>
                </div>
                <span className="text-[9px] font-mono shrink-0" style={{color:'var(--text-faint)'}}>{fmtTime(a.triggered_at)}</span>
              </div>
            )
          })}
        </div>

        {/* Recent audit */}
        <div className="glass rounded-2xl overflow-hidden">
          <div className="px-5 py-3" style={{borderBottom:'1px solid var(--border-subtle)'}}>
            <SectionLabel action={{label:'All',fn:()=>navigate('/audit')}}>Recent Activity</SectionLabel>
          </div>
          {auditLog.length===0 ? (
            <div className="py-8 flex flex-col items-center gap-2 opacity-50">
              <ScrollText size={18} style={{color:'var(--text-muted)'}}/>
              <p className="text-xs font-body" style={{color:'var(--text-muted)'}}>No activity</p>
            </div>
          ) : auditLog.slice(0,6).map((a,i)=>(
            <div key={a.id||i} className="flex items-center gap-2.5 px-5 py-2.5 transition-colors"
              style={{borderBottom:i<Math.min(auditLog.length-1,5)?'1px solid var(--border-subtle)':'none'}}
              onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.result==='success'?'bg-accent-green':'bg-accent-red'}`}/>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-body truncate" style={{color:'var(--text-secondary)'}}>
                  <span className="font-semibold" style={{color:'var(--text-primary)'}}>{a.username}</span>
                  {' '}<span className="capitalize">{a.action?.replace(/_/g,' ')}</span>
                  {a.target_name&&<span style={{color:'var(--text-muted)'}}> — {a.target_name}</span>}
                </p>
              </div>
              <span className="text-[9px] font-mono shrink-0" style={{color:'var(--text-faint)'}}>{fmtTime(a.timestamp)}</span>
            </div>
          ))}
        </div>
      </div>

      <ActionConfirmModal
        open={!!actionModal} onClose={()=>setActionModal(null)}
        onConfirm={executeAction} title={actionModal?.label||''}
        description="This action will be logged in the audit trail."
        danger={actionModal?.danger}/>
    </div>
  )
}

