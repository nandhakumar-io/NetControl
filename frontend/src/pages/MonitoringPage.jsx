// pages/MonitoringPage.jsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Activity, Cpu, HardDrive, Wifi, Clock, RefreshCw, AlertTriangle,
  CheckCircle2, Monitor, Search, Server, ArrowDown, ArrowUp,
  ChevronDown, ChevronUp, MemoryStick, Filter, TrendingUp,
  TrendingDown, Thermometer, Radio, Eye, Zap, Network,
} from 'lucide-react'
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar as RBar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import api from '../lib/api'
import { useThemeStore } from '../store/themeStore'

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtUptime  = s => { if (!s) return '—'; const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60); return d>0?`${d}d ${h}h`:h>0?`${h}h ${m}m`:`${m}m` }
const fmtBps     = b => { if (!b||b<0) return '0 B/s'; if(b<1024) return `${b.toFixed(0)} B/s`; if(b<1048576) return `${(b/1024).toFixed(1)} KB/s`; return `${(b/1048576).toFixed(1)} MB/s` }
const fmtMB      = mb => !mb?'—':mb<1024?`${mb.toFixed(0)} MB`:`${(mb/1024).toFixed(1)} GB`
const fmtGB      = gb => gb==null?'—':gb<1?`${(gb*1024).toFixed(0)} MB`:`${gb.toFixed(1)} GB`
const fmtMs      = ms => ms==null?'—':ms<1000?`${ms}ms`:`${(ms/1000).toFixed(1)}s`
const secAgo     = ts => ts ? Math.floor(Date.now()/1000)-ts : null
const isStale    = (ts,s=45) => { const a=secAgo(ts); return a===null||a>s }
const pct        = (u,t) => t?Math.round(u/t*100):0
const clamp      = (v,lo,hi) => Math.min(hi,Math.max(lo,v))

const cpuColor   = v => !v&&v!==0?'#475569':v>=90?'#ef4444':v>=70?'#f97316':v>=50?'#eab308':'#22c55e'
const ramColor   = p => p>=90?'#ef4444':p>=75?'#f97316':p>=60?'#eab308':'#a78bfa'
const diskColor  = p => p>=90?'#ef4444':p>=80?'#f97316':p>=70?'#eab308':'#22c55e'
const latColor   = ms => ms==null?'#475569':ms<50?'#22c55e':ms<150?'#eab308':'#ef4444'
const statusColor= s => ({online:'#22c55e',offline:'#ef4444',unknown:'#475569'}[s]||'#475569')

const TT = { background:'rgba(6,6,18,0.98)', border:'1px solid rgba(255,255,255,0.09)', borderRadius:8, fontSize:11, fontFamily:'monospace', padding:'8px 12px' }

// ─── Primitives ───────────────────────────────────────────────────────────────
function Bar({ value, color, h=4 }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{height:h,background:'rgba(255,255,255,0.07)'}}>
      <div className="h-full rounded-full transition-all duration-700"
        style={{width:`${clamp(value||0,0,100)}%`,background:color}}/>
    </div>
  )
}

function MiniGauge({ value, color, size=44, label }) {
  const r=size/2-5, circ=2*Math.PI*r, dash=(clamp(value||0,0,100)/100)*circ
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="relative" style={{width:size,height:size}}>
        <svg width={size} height={size} style={{transform:'rotate(-90deg)'}}>
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="4"/>
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="4"
            strokeDasharray={`${dash} ${circ-dash}`} strokeLinecap="round"
            style={{transition:'stroke-dasharray 0.8s ease'}}/>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono font-bold" style={{color,fontSize:10}}>
            {value==null?'—':`${Math.round(value)}%`}
          </span>
        </div>
      </div>
      {label&&<span className="text-[9px] font-mono uppercase" style={{color:'var(--text-faint)'}}>{label}</span>}
    </div>
  )
}

function Spark({ data, color, height=28 }) {
  if (!data||data.length<2) return <div style={{height}}/>
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{top:1,right:0,left:0,bottom:1}}>
        <defs>
          <linearGradient id={`sg${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35}/>
            <stop offset="100%" stopColor={color} stopOpacity={0}/>
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
          fill={`url(#sg${color.replace('#','')})`} dot={false} isAnimationActive={false}/>
      </AreaChart>
    </ResponsiveContainer>
  )
}

function ChartTT({ active, payload }) {
  if (!active||!payload?.length) return null
  return (
    <div style={TT}>
      {payload.map((p,i)=>(
        <div key={i} style={{color:p.color}}>
          {p.name}: <strong>{typeof p.value==='number'?p.value.toFixed(1):p.value}{p.unit||'%'}</strong>
        </div>
      ))}
    </div>
  )
}

// ─── Fleet Overview ───────────────────────────────────────────────────────────
function FleetOverview({ devices, metrics, groups }) {
  const reporting = useMemo(()=>Object.values(metrics).filter(m=>m.latest&&!isStale(m.latest.ts)).length,[metrics])

  // Build fleet time series from history — use real timestamps from agent history
  const series = useMemo(() => {
    const LEN = 30
    // Collect all history arrays
    const allHists = Object.values(metrics).map(e=>e.history||[]).filter(h=>h.length>0)
    if(!allHists.length) return []
    // Use the longest history as the time spine
    const spine = allHists.reduce((a,b)=>a.length>=b.length?a:b,[])
    const startIdx = Math.max(0, spine.length - LEN)
    return spine.slice(startIdx).map((src, i) => {
      // Collect values from all agents for this time index
      let cpuSum=0, ramSum=0, net=0, cnt=0
      for(const h of allHists){
        const hi = Math.floor((i / LEN) * h.length)
        const s  = h[Math.min(hi, h.length-1)]
        if(!s) continue
        if(s.cpu!=null){cpuSum+=s.cpu; cnt++}
        if(s.ram) ramSum+=pct(s.ram.used,s.ram.total)
        if(s.network?.rxSec) net+=s.network.rxSec/1024
      }
      // Real timestamp from the snapshot
      const label = src.ts
        ? new Date(src.ts*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
        : `t-${LEN - i}`
      return {
        t:   label,
        cpu: cnt ? +(cpuSum/cnt).toFixed(1) : null,
        ram: cnt ? Math.round(ramSum/cnt)    : null,
        net: +net.toFixed(1),
      }
    })
  },[metrics])

  // Process-level aggregates: top 5 processes by CPU across all agents
  const topProcs = useMemo(()=>{
    const map={}
    for(const [,e] of Object.entries(metrics)){
      for(const p of (e.latest?.processes||[])){
        if(!map[p.name]) map[p.name]={name:p.name,cpu:0,mem:0,cnt:0}
        map[p.name].cpu+=p.cpu||0
        map[p.name].mem+=p.mem||0
        map[p.name].cnt++
      }
    }
    return Object.values(map).sort((a,b)=>b.cpu-a.cpu).slice(0,8)
  },[metrics])

  // Network totals
  const netTotals = useMemo(()=>{
    let rx=0,tx=0
    for(const [,e] of Object.entries(metrics)){
      if(!e.latest?.network||isStale(e.latest.ts)) continue
      rx+=e.latest.network.rxSec||0
      tx+=e.latest.network.txSec||0
    }
    return {rx,tx}
  },[metrics])

  const online  = devices.filter(d=>d.status==='online').length
  const offline = devices.filter(d=>d.status==='offline').length

  const avgCpu = useMemo(()=>{const v=Object.values(metrics).filter(m=>m.latest?.cpu!=null&&!isStale(m.latest.ts)).map(m=>m.latest.cpu);return v.length?+(v.reduce((a,b)=>a+b,0)/v.length).toFixed(1):null},[metrics])
  const avgRam = useMemo(()=>{const v=Object.values(metrics).filter(m=>m.latest?.ram&&!isStale(m.latest.ts)).map(m=>pct(m.latest.ram.used,m.latest.ram.total));return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):null},[metrics])

  return (
    <div className="space-y-4">
      {/* Row A: KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        {[
          {label:'Devices',   v:devices.length, c:'#a78bfa', icon:Server},
          {label:'Online',    v:online,          c:'#22c55e', icon:CheckCircle2},
          {label:'Offline',   v:offline,         c:offline>0?'#ef4444':'#475569', icon:AlertTriangle},
          {label:'Reporting', v:reporting,       c:'#06b6d4', icon:Radio, sub:`of ${devices.length}`},
          {label:'Avg CPU',   v:avgCpu!=null?`${avgCpu}%`:'—', c:cpuColor(avgCpu), icon:Cpu},
          {label:'Avg RAM',   v:avgRam!=null?`${avgRam}%`:'—', c:ramColor(avgRam), icon:MemoryStick},
          {label:'Fleet RX',  v:fmtBps(netTotals.rx), c:'#22c55e', icon:ArrowDown},
          {label:'Fleet TX',  v:fmtBps(netTotals.tx), c:'#f97316', icon:ArrowUp},
        ].map(({label,v,c,icon:Icon,sub})=>(
          <div key={label} className="glass rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <Icon size={12} style={{color:c}}/>
              <span className="text-[9px] font-mono uppercase tracking-wider" style={{color:'var(--text-faint)'}}>{label}</span>
            </div>
            <p className="text-lg font-display font-bold leading-none" style={{color:c}}>{v}</p>
            {sub&&<p className="text-[9px] font-mono mt-0.5" style={{color:'var(--text-faint)'}}>{sub}</p>}
          </div>
        ))}
      </div>

      {/* Row B: Fleet trend + CPU dist + top processes */}
      <div className="grid grid-cols-1 gap-4">

        {/* Fleet CPU + RAM trend */}
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-body font-semibold" style={{color:'var(--text-primary)'}}>Fleet CPU & RAM trend</span>
            <div className="flex items-center gap-3">
              {[['#a78bfa','CPU'],['#06b6d4','RAM'],['#22c55e','Net KB/s']].map(([c,l])=>(
                <span key={l} className="flex items-center gap-1 text-[9px] font-mono" style={{color:c}}>
                  <span className="inline-block w-3 h-px" style={{background:c}}/>{l}
                </span>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={130}>
            <AreaChart data={series} margin={{top:4,right:4,left:-22,bottom:0}}>
              <defs>
                {[['fcpu','#a78bfa'],['fram','#06b6d4'],['fnet','#22c55e']].map(([id,c])=>(
                  <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={c} stopOpacity={0.25}/>
                    <stop offset="100%" stopColor={c} stopOpacity={0}/>
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false}/>
              <XAxis dataKey="t" tick={{fontSize:9,fill:'#475569'}} tickLine={false} axisLine={false} interval="preserveStartEnd"/>
              <YAxis tick={{fontSize:9,fill:'#475569'}} tickLine={false} axisLine={false}/>
              <ReferenceLine y={80} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.35}/>
              <Tooltip content={<ChartTT/>}/>
              <Area type="monotone" dataKey="cpu" name="CPU"   stroke="#a78bfa" strokeWidth={2} fill="url(#fcpu)" dot={false} isAnimationActive={false}/>
              <Area type="monotone" dataKey="ram" name="RAM"   stroke="#06b6d4" strokeWidth={2} fill="url(#fram)" dot={false} isAnimationActive={false}/>
              <Area type="monotone" dataKey="net" name="RX"    stroke="#22c55e" unit=" KB/s" strokeWidth={1.5} fill="url(#fnet)" dot={false} isAnimationActive={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>

      </div>

      {/* Row C: Top processes fleet-wide */}
      {topProcs.length>0 && (
        <div className="glass rounded-2xl overflow-hidden">
          <div className="px-5 py-3 flex items-center gap-2" style={{borderBottom:'1px solid var(--border-subtle)'}}>
            <Zap size={13} style={{color:'#f97316'}}/>
            <span className="text-xs font-body font-semibold" style={{color:'var(--text-primary)'}}>Top Processes — Fleet-wide CPU</span>
            <span className="ml-auto text-[10px] font-mono" style={{color:'var(--text-faint)'}}>aggregated across {reporting} agents</span>
          </div>
          <div className="grid" style={{gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))'}}>
            {topProcs.map((p,i)=>(
              <div key={p.name} className="flex items-center gap-3 px-5 py-2.5 transition-colors"
                style={{borderRight:i%2===0?'1px solid var(--border-subtle)':'none', borderBottom:'1px solid var(--border-subtle)'}}
                onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <span className="text-[10px] font-mono w-4 shrink-0" style={{color:'var(--text-faint)'}}>{i+1}</span>
                <span className="text-xs font-mono flex-1 truncate" style={{color:'var(--text-primary)'}}>{p.name}</span>
                <div className="text-right shrink-0">
                  <p className="text-[11px] font-mono font-bold" style={{color:cpuColor(p.cpu/Math.max(p.cnt,1))}}>{(p.cpu).toFixed(1)}%</p>
                  <p className="text-[9px] font-mono" style={{color:'var(--text-faint)'}}>{p.cnt} inst</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Expanded device detail ───────────────────────────────────────────────────
function DeviceDetail({ device, m, hist }) {
  const cpuVal  = m?.cpu ?? null
  const ramPct  = m?.ram ? pct(m.ram.used,m.ram.total) : null
  const cc = cpuColor(cpuVal), rc = ramColor(ramPct)

  const cpuHist = useMemo(()=>hist.map((h,i)=>({i,v:h.cpu})).filter(h=>h.v!=null).slice(-80),[hist])
  const ramHist = useMemo(()=>hist.map((h,i)=>({i,v:h.ram?pct(h.ram.used,h.ram.total):null})).filter(h=>h.v!=null).slice(-80),[hist])
  const netHist = useMemo(()=>hist.map((h,i)=>({i,rx:(h.network?.rxSec||0)/1024,tx:(h.network?.txSec||0)/1024})).slice(-80),[hist])

  if (!m || isStale(m.ts)) return (
    <div className="py-10 flex flex-col items-center gap-2 opacity-40">
      <Activity size={20} style={{color:'var(--text-muted)'}}/>
      <p className="text-sm font-body" style={{color:'var(--text-muted)'}}>
        {device.status!=='online'?'Device is offline — no metrics available':'Agent not reporting — waiting for heartbeat'}
      </p>
    </div>
  )

  return (
    <div className="p-4 space-y-4" style={{borderTop:'1px solid var(--border-subtle)'}}>

      {/* System info strip */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 px-1">
        {[
          m.hostname && ['Host',     m.hostname],
          m.os       && ['OS',       m.os],
          m.uptime   && ['Uptime',   fmtUptime(m.uptime)],
          m.network  && ['RX',       fmtBps(m.network.rxSec)],
          m.network  && ['TX',       fmtBps(m.network.txSec)],
        ].filter(Boolean).map(([k,v])=>(
          <div key={k} className="flex items-center gap-1.5">
            <span className="text-[9px] font-mono uppercase tracking-wider" style={{color:'var(--text-faint)'}}>{k}</span>
            <span className="text-[11px] font-mono" style={{color:'var(--text-secondary)'}}>{v}</span>
          </div>
        ))}
      </div>

      {/* CPU + RAM + Disk + Network */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">

        {/* CPU */}
        <div className="rounded-xl p-3 space-y-2" style={{background:'var(--bg-input)',border:'1px solid var(--border-subtle)'}}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Cpu size={11} style={{color:cc}}/>
              <span className="text-[9px] font-bold uppercase tracking-wider" style={{color:'var(--text-muted)'}}>CPU</span>
            </div>
            <MiniGauge value={cpuVal} color={cc} size={40}/>
          </div>
          <Bar value={cpuVal} color={cc} h={4}/>
          <div style={{height:52}}>
            {cpuHist.length>3&&(
              <ResponsiveContainer width="100%" height={52}>
                <AreaChart data={cpuHist} margin={{top:2,right:0,left:0,bottom:0}}>
                  <defs><linearGradient id={`cg${device.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={cc} stopOpacity={0.35}/><stop offset="100%" stopColor={cc} stopOpacity={0}/></linearGradient></defs>
                  <ReferenceLine y={80} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5}/>
                  <Area type="monotone" dataKey="v" stroke={cc} strokeWidth={1.5} fill={`url(#cg${device.id})`} dot={false} isAnimationActive={false}/>
                  <Tooltip content={<ChartTT/>}/>
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* RAM */}
        <div className="rounded-xl p-3 space-y-2" style={{background:'var(--bg-input)',border:'1px solid var(--border-subtle)'}}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <MemoryStick size={11} style={{color:rc}}/>
              <span className="text-[9px] font-bold uppercase tracking-wider" style={{color:'var(--text-muted)'}}>RAM</span>
            </div>
            <MiniGauge value={ramPct} color={rc} size={40}/>
          </div>
          <Bar value={ramPct} color={rc} h={4}/>
          <div className="flex justify-between">
            <span className="text-[9px] font-mono" style={{color:'var(--text-muted)'}}>{fmtMB(m.ram?.used)}</span>
            <span className="text-[9px] font-mono" style={{color:'var(--text-faint)'}}>/{fmtMB(m.ram?.total)}</span>
          </div>
          <div style={{height:40}}>
            {ramHist.length>3&&(
              <ResponsiveContainer width="100%" height={40}>
                <AreaChart data={ramHist} margin={{top:2,right:0,left:0,bottom:0}}>
                  <defs><linearGradient id={`rg${device.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={rc} stopOpacity={0.35}/><stop offset="100%" stopColor={rc} stopOpacity={0}/></linearGradient></defs>
                  <Area type="monotone" dataKey="v" stroke={rc} strokeWidth={1.5} fill={`url(#rg${device.id})`} dot={false} isAnimationActive={false}/>
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Disk volumes */}
        <div className="rounded-xl p-3 space-y-2.5" style={{background:'var(--bg-input)',border:'1px solid var(--border-subtle)'}}>
          <div className="flex items-center gap-1.5 mb-1">
            <HardDrive size={11} style={{color:'#a855f7'}}/>
            <span className="text-[9px] font-bold uppercase tracking-wider" style={{color:'var(--text-muted)'}}>Disk Volumes</span>
          </div>
          {(m.disk||[]).slice(0,4).map((d,i)=>(
            <div key={i}>
              <div className="flex justify-between mb-1">
                <span className="text-[9px] font-mono truncate max-w-[70px]" style={{color:'var(--text-secondary)'}}>{d.mount}</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-mono" style={{color:'var(--text-faint)'}}>{fmtGB(d.used)}/{fmtGB(d.total)}</span>
                  <span className="text-[10px] font-mono font-bold" style={{color:diskColor(d.use)}}>{d.use?.toFixed(0)}%</span>
                </div>
              </div>
              <Bar value={d.use} color={diskColor(d.use)} h={3}/>
            </div>
          ))}
          {(!m.disk||m.disk.length===0)&&<p className="text-[10px] font-mono opacity-30" style={{color:'var(--text-muted)'}}>No disk data</p>}
        </div>

        {/* Network */}
        <div className="rounded-xl p-3" style={{background:'var(--bg-input)',border:'1px solid var(--border-subtle)'}}>
          <div className="flex items-center gap-1.5 mb-3">
            <Network size={11} style={{color:'#06b6d4'}}/>
            <span className="text-[9px] font-bold uppercase tracking-wider" style={{color:'var(--text-muted)'}}>Network I/O</span>
          </div>
          <div className="flex justify-between mb-3">
            <div>
              <div className="flex items-center gap-1 mb-0.5"><ArrowDown size={9} style={{color:'#22c55e'}}/><span className="text-[9px] font-mono" style={{color:'var(--text-faint)'}}>RX</span></div>
              <span className="text-[12px] font-mono font-bold" style={{color:'#22c55e'}}>{fmtBps(m.network?.rxSec)}</span>
            </div>
            <div className="text-right">
              <div className="flex items-center gap-1 mb-0.5 justify-end"><ArrowUp size={9} style={{color:'#f97316'}}/><span className="text-[9px] font-mono" style={{color:'var(--text-faint)'}}>TX</span></div>
              <span className="text-[12px] font-mono font-bold" style={{color:'#f97316'}}>{fmtBps(m.network?.txSec)}</span>
            </div>
          </div>
          <div style={{height:52}}>
            {netHist.length>3&&(
              <ResponsiveContainer width="100%" height={52}>
                <LineChart data={netHist} margin={{top:2,right:0,left:0,bottom:0}}>
                  <Line type="monotone" dataKey="rx" name="RX" stroke="#22c55e" strokeWidth={1.5} dot={false} isAnimationActive={false}/>
                  <Line type="monotone" dataKey="tx" name="TX" stroke="#f97316" strokeWidth={1.5} dot={false} isAnimationActive={false}/>
                  <Tooltip content={<ChartTT/>}/>
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Top processes */}
      {m.processes?.length>0 && (
        <div className="rounded-xl overflow-hidden" style={{border:'1px solid var(--border-subtle)'}}>
          <div className="grid px-4 py-2 text-[9px] font-bold uppercase tracking-wider"
            style={{gridTemplateColumns:'52px 1fr 64px 64px 80px', background:'var(--bg-input)', borderBottom:'1px solid var(--border-subtle)', color:'var(--text-faint)'}}>
            <span>PID</span><span>Process</span><span className="text-right">CPU</span><span className="text-right">MEM</span><span className="text-right">CPU Bar</span>
          </div>
          {m.processes.slice(0,8).map((p,i)=>(
            <div key={i} className="grid px-4 py-2 items-center transition-colors"
              style={{gridTemplateColumns:'52px 1fr 64px 64px 80px', borderBottom:i<m.processes.length-1?'1px solid var(--border-subtle)':'none'}}
              onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <span className="text-[9px] font-mono" style={{color:'var(--text-faint)'}}>{p.pid}</span>
              <span className="text-[11px] font-mono truncate" style={{color:'var(--text-primary)'}}>{p.name}</span>
              <span className="text-[10px] font-mono text-right font-bold" style={{color:cpuColor(p.cpu)}}>{(p.cpu||0).toFixed(1)}%</span>
              <span className="text-[10px] font-mono text-right" style={{color:'var(--text-muted)'}}>{(p.mem||0).toFixed(1)}%</span>
              <div className="pl-2"><Bar value={p.cpu||0} color={cpuColor(p.cpu)} h={4}/></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Device row ───────────────────────────────────────────────────────────────
const DeviceRow = React.memo(function DeviceRow({ device, metrics, expanded, onToggle }) {
  const m    = metrics?.latest
  const hist = metrics?.history || []
  const stale = !m || isStale(m.ts)
  const live  = device.status==='online' && !stale

  const cpuVal  = m?.cpu ?? null
  const ramPct  = m?.ram ? pct(m.ram.used,m.ram.total) : null
  const diskPct = m?.disk?.[0]?.use ?? null
  const ago     = m ? secAgo(m.ts) : null
  const cc=cpuColor(cpuVal), rc=ramColor(ramPct), dc=diskColor(diskPct)

  const cpuHist = useMemo(()=>hist.map((h,i)=>({i,v:h.cpu})).filter(h=>h.v!=null).slice(-40),[hist])

  return (
    <div className="rounded-xl overflow-hidden mb-1.5 transition-all"
      style={{border:`1px solid ${live?'rgba(34,197,94,0.15)':'var(--border-subtle)'}`, background:'var(--bg-card)'}}>

      {/* Collapsed row */}
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none group" onClick={onToggle}>

        {/* Status dot */}
        <div className="w-2 h-2 rounded-full shrink-0"
          style={{background:statusColor(device.status), boxShadow:live?`0 0 5px ${statusColor(device.status)}55`:'none'}}/>

        {/* OS badge */}
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono shrink-0 font-bold
          ${device.os_type==='windows'?'bg-sky-400/10 text-sky-400':'bg-violet-400/10 text-violet-400'}`}>
          {device.os_type==='windows'?'WIN':'LNX'}
        </span>

        {/* Name + IP + group */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-body font-semibold truncate" style={{color:'var(--text-primary)'}}>{device.name}</p>
          <p className="text-[10px] font-mono" style={{color:'var(--text-faint)'}}>{device.ip_address}</p>
        </div>

        {/* Live metrics inline */}
        {live ? (
          <div className="hidden md:flex items-center gap-4 shrink-0">

            {/* CPU with spark */}
            <div className="flex items-center gap-2 w-[120px]">
              <div className="flex-1">
                <div className="flex justify-between mb-1">
                  <span className="text-[9px] font-mono uppercase" style={{color:'var(--text-faint)'}}>CPU</span>
                  <span className="text-[10px] font-mono font-bold" style={{color:cc}}>{cpuVal?.toFixed(1)}%</span>
                </div>
                <Bar value={cpuVal} color={cc} h={3}/>
              </div>
              <div style={{width:36}}>
                <Spark data={cpuHist.map(h=>({v:h.v}))} color={cc} height={18}/>
              </div>
            </div>

            {/* RAM */}
            <div className="w-[80px]">
              <div className="flex justify-between mb-1">
                <span className="text-[9px] font-mono uppercase" style={{color:'var(--text-faint)'}}>RAM</span>
                <span className="text-[10px] font-mono font-bold" style={{color:rc}}>{ramPct}%</span>
              </div>
              <Bar value={ramPct} color={rc} h={3}/>
            </div>

            {/* Disk */}
            <div className="hidden lg:block w-[72px]">
              <div className="flex justify-between mb-1">
                <span className="text-[9px] font-mono uppercase" style={{color:'var(--text-faint)'}}>DSK</span>
                <span className="text-[10px] font-mono font-bold" style={{color:dc}}>{diskPct?.toFixed(0)}%</span>
              </div>
              <Bar value={diskPct} color={dc} h={3}/>
            </div>

            {/* Network RX/TX */}
            <div className="hidden xl:block w-[90px]">
              <div className="flex items-center gap-1 mb-0.5">
                <ArrowDown size={8} style={{color:'#22c55e'}}/>
                <span className="text-[9px] font-mono font-bold" style={{color:'#22c55e'}}>{fmtBps(m?.network?.rxSec)}</span>
              </div>
              <div className="flex items-center gap-1">
                <ArrowUp size={8} style={{color:'#f97316'}}/>
                <span className="text-[9px] font-mono font-bold" style={{color:'#f97316'}}>{fmtBps(m?.network?.txSec)}</span>
              </div>
            </div>

            {/* Uptime */}
            <div className="hidden xl:block w-[56px] text-right">
              <span className="text-[9px] font-mono uppercase block" style={{color:'var(--text-faint)'}}>uptime</span>
              <span className="text-[10px] font-mono" style={{color:'var(--text-secondary)'}}>{fmtUptime(m?.uptime)}</span>
            </div>
          </div>
        ) : (
          <span className="text-[11px] font-body px-2 py-0.5 rounded-full shrink-0"
            style={{
              background: device.status==='online'?'rgba(234,179,8,0.10)':'rgba(239,68,68,0.10)',
              color:       device.status==='online'?'#eab308':'#ef4444',
              border:`1px solid ${device.status==='online'?'rgba(234,179,8,0.25)':'rgba(239,68,68,0.25)'}`,
            }}>
            {device.status==='online'?'Agent silent':device.status||'Unknown'}
          </span>
        )}

        {/* Freshness */}
        {ago!=null && (
          <span className="text-[9px] font-mono w-8 text-right shrink-0 hidden lg:block"
            style={{color:ago<10?'#22c55e':ago<30?'#eab308':'#ef4444'}}>
            {ago<5?'live':`${ago}s`}
          </span>
        )}

        <div className="ml-1 p-1 rounded-lg shrink-0 group-hover:bg-white/5 transition-colors" style={{color:'var(--text-muted)'}}>
          {expanded?<ChevronUp size={12}/>:<ChevronDown size={12}/>}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && <DeviceDetail device={device} m={m} hist={hist}/>}
    </div>
  )
})

// ─── Virtual list ─────────────────────────────────────────────────────────────
const ROW_H = 60
function VirtualList({ items, metrics, expanded, onToggle }) {
  const ref = useRef(null)
  const [top, setTop] = useState(0)
  const [height, setHeight] = useState(700)
  useEffect(()=>{
    const el=ref.current; if(!el) return
    const ro=new ResizeObserver(()=>setHeight(el.clientHeight)); ro.observe(el); return()=>ro.disconnect()
  },[])
  if(expanded.size>0) return <div>{items.map(d=><DeviceRow key={d.id} device={d} metrics={metrics[d.id]} expanded={expanded.has(d.id)} onToggle={()=>onToggle(d.id)}/>)}</div>
  const total=items.length*ROW_H, BUF=5
  const si=Math.max(0,Math.floor(top/ROW_H)-BUF)
  const ei=Math.min(items.length,Math.ceil((top+height)/ROW_H)+BUF)
  return (
    <div ref={ref} onScroll={e=>setTop(e.currentTarget.scrollTop)} style={{height:Math.min(total,680),overflowY:'auto',position:'relative'}}>
      <div style={{height:total,position:'relative'}}>
        <div style={{position:'absolute',top:si*ROW_H,left:0,right:0}}>
          {items.slice(si,ei).map(d=><DeviceRow key={d.id} device={d} metrics={metrics[d.id]} expanded={false} onToggle={()=>onToggle(d.id)}/>)}
        </div>
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function MonitoringPage() {
  const [devices,      setDevices]      = useState([])
  const [groups,       setGroups]       = useState([])
  const [metrics,      setMetrics]      = useState({})
  const [expanded,     setExpanded]     = useState(new Set())
  const [search,       setSearch]       = useState('')
  const [filterGroup,  setFilterGroup]  = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [sortBy,       setSortBy]       = useState('name')
  const [loading,      setLoading]      = useState(true)
  const [refreshing,   setRefreshing]   = useState(false)
  const [lastRefresh,  setLastRefresh]  = useState(null)
  const [showOverview, setShowOverview] = useState(true)

  const metricsRef = useRef({})

  // Accept incoming metrics — always replace history (fixes "empty on remount" bug)
  const mergeMetrics = useCallback((incoming, isSnapshot=false) => {
    const prev = metricsRef.current
    const merged = isSnapshot ? {} : { ...prev }
    let changed = false
    for (const [id, entry] of Object.entries(incoming)) {
      // Always accept if ts changed OR it's a full snapshot replacement
      if (isSnapshot || entry?.latest?.ts !== prev[id]?.latest?.ts) {
        merged[id] = entry
        changed = true
      }
    }
    if (changed) { metricsRef.current = merged; setMetrics(merged) }
  }, [])

  // Full load: devices + groups + metrics snapshot
  const load = useCallback(async (quiet=false) => {
    if (!quiet) setLoading(true); else setRefreshing(true)
    try {
      const [d, g, m] = await Promise.all([api.get('/devices'), api.get('/groups'), api.get('/metrics')])
      setDevices(d.data || [])
      setGroups(g.data || [])
      metricsRef.current = {} // clear before snapshot so history is always fresh
      mergeMetrics(m.data || {}, true)
      setLastRefresh(Date.now())
    } catch (e) {
      if (!quiet) console.error('[Monitoring] load error:', e.message)
    } finally { setLoading(false); setRefreshing(false) }
  }, [mergeMetrics])

  useEffect(() => { load() }, [load])

  // SSE stream — receives pushed updates the instant agents send data
  // Falls back to 10s polling if SSE connection drops
  const failCount = useRef(0)
  useEffect(() => {
    const token = localStorage.getItem('nc_token') || ''
    const es = new EventSource(
      `${api.defaults.baseURL}/metrics/stream?token=${encodeURIComponent(token)}`
    )

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        failCount.current = 0

        if (msg.type === 'snapshot') {
          // Full snapshot on connect — replaces everything
          metricsRef.current = {}
          mergeMetrics(msg.data || {}, true)
        } else if (msg.deviceId && msg.latest) {
          // Single-device push — merge into existing
          const prev = metricsRef.current
          const entry = prev[msg.deviceId] || { latest: null, history: [] }
          // Append to local history (backend sends latest only in push events)
          const hist = [...(entry.history || []), msg.latest]
          if (hist.length > 300) hist.shift()
          mergeMetrics({ [msg.deviceId]: { latest: msg.latest, history: hist } })
        }
        setLastRefresh(Date.now())
      } catch {}
    }

    es.onerror = () => {
      // SSE dropped — fall back to polling until it reconnects
      failCount.current++
      if (failCount.current >= 3) {
        metricsRef.current = {}
        setMetrics({})
      }
    }

    // Fallback poll every 10s in case SSE is blocked by a proxy
    const fallback = setInterval(async () => {
      if (es.readyState === EventSource.OPEN) return // SSE is working, skip poll
      try {
        const { data } = await api.get('/metrics')
        failCount.current = 0
        mergeMetrics(data || {})
        setLastRefresh(Date.now())
      } catch {
        failCount.current++
        if (failCount.current >= 3) { metricsRef.current = {}; setMetrics({}) }
      }
    }, 10000)

    return () => { es.close(); clearInterval(fallback) }
  }, [mergeMetrics])

  const toggle = useCallback(id=>{ setExpanded(s=>{ const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n }) },[])

  const reporting = useMemo(()=>Object.values(metrics).filter(m=>m.latest&&!isStale(m.latest.ts)).length,[metrics])

  const filtered = useMemo(()=>{
    let list=devices.filter(d=>{
      if(search&&!d.name.toLowerCase().includes(search.toLowerCase())&&!d.ip_address.includes(search)) return false
      if(filterGroup!=='all'&&String(d.group_id)!==filterGroup) return false
      if(filterStatus==='online'    &&d.status!=='online') return false
      if(filterStatus==='offline'   &&d.status!=='offline') return false
      if(filterStatus==='reporting' &&(!metrics[d.id]?.latest||isStale(metrics[d.id].latest.ts))) return false
      if(filterStatus==='silent'    &&(metrics[d.id]?.latest&&!isStale(metrics[d.id].latest.ts))) return false
      if(filterStatus==='critical'){
        const m=metrics[d.id]?.latest
        const cpu=m?.cpu, rp=m?.ram?pct(m.ram.used,m.ram.total):null
        if(!((cpu!=null&&cpu>=90)||(rp!=null&&rp>=90))) return false
      }
      return true
    })
    return [...list].sort((a,b)=>{
      if(sortBy==='cpu'){const ca=metrics[a.id]?.latest?.cpu??-1,cb=metrics[b.id]?.latest?.cpu??-1;return cb-ca}
      if(sortBy==='ram'){const ra=metrics[a.id]?.latest?.ram?pct(metrics[a.id].latest.ram.used,metrics[a.id].latest.ram.total):-1,rb=metrics[b.id]?.latest?.ram?pct(metrics[b.id].latest.ram.used,metrics[b.id].latest.ram.total):-1;return rb-ra}
      if(sortBy==='disk'){const da=metrics[a.id]?.latest?.disk?.[0]?.use??-1,db=metrics[b.id]?.latest?.disk?.[0]?.use??-1;return db-da}
      if(sortBy==='status'){const sv=s=>s==='online'?0:s==='offline'?2:1;return sv(a.status)-sv(b.status)}
      return a.name.localeCompare(b.name)
    })
  },[devices,search,filterGroup,filterStatus,sortBy,metrics])

  if(loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="flex flex-col items-center gap-3">
        <Activity size={24} className="animate-pulse" style={{color:'#a78bfa'}}/>
        <p className="text-xs font-mono" style={{color:'var(--text-muted)'}}>Loading monitoring data…</p>
      </div>
    </div>
  )

  return (
    <div className="p-5 space-y-5 animate-fade-in max-w-[1600px] mx-auto pb-10">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-display font-bold" style={{color:'var(--text-primary)'}}>Live Monitoring</h1>
          <p className="text-[11px] font-mono mt-0.5" style={{color:'var(--text-muted)'}}>
            {reporting}/{devices.length} agents reporting · 5s refresh
            {lastRefresh&&<span className="ml-3 opacity-50">· {new Date(lastRefresh).toLocaleTimeString()}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={()=>setShowOverview(v=>!v)}
            className={`text-xs px-3 py-1.5 rounded-lg font-body transition-all ${showOverview?'bg-brand-500/15 text-brand-400 border border-brand-500/25':'btn-ghost'}`}>
            Fleet Overview
          </button>
          <button onClick={()=>load(true)} disabled={refreshing} className="icon-btn">
            <RefreshCw size={13} className={refreshing?'animate-spin':''}/>
          </button>
        </div>
      </div>

      {/* Fleet overview toggle section */}
      {showOverview && devices.length>0 && (
        <FleetOverview devices={devices} metrics={metrics} groups={groups}/>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search size={11} className="absolute left-3 top-1/2 -translate-y-1/2" style={{color:'var(--text-muted)'}}/>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search name or IP…" className="input-field pl-8 py-1.5 text-xs h-8"/>
        </div>
        <select value={filterGroup} onChange={e=>setFilterGroup(e.target.value)}
          className="input-field text-xs h-8 py-0" style={{minWidth:130}}>
          <option value="all">All groups</option>
          {groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <div className="flex gap-1 flex-wrap">
          {['all','online','offline','reporting','silent','critical'].map(s=>(
            <button key={s} onClick={()=>setFilterStatus(s)}
              className={`chip h-8 px-2.5 text-xs capitalize ${filterStatus===s?'chip-selected':''}`}>
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[10px] font-mono" style={{color:'var(--text-faint)'}}>Sort:</span>
          {[['name','Name'],['cpu','CPU'],['ram','RAM'],['disk','Disk'],['status','Status']].map(([k,l])=>(
            <button key={k} onClick={()=>setSortBy(k)}
              className={`text-[10px] px-2 py-1 rounded-lg font-body font-medium transition-all
                ${sortBy===k?'bg-brand-500/15 text-brand-400 border border-brand-500/25':'text-slate-500 hover:text-slate-300'}`}>
              {l}
            </button>
          ))}
        </div>
        <button onClick={()=>setExpanded(expanded.size>0?new Set():new Set(filtered.map(d=>d.id)))}
          className="btn-ghost text-xs py-1 px-2.5 h-8 flex items-center gap-1.5">
          <Eye size={11}/>{expanded.size>0?'Collapse all':'Expand all'}
        </button>
      </div>

      {/* Column headers */}
      {filtered.length>0 && (
        <div className="hidden md:grid px-4 py-1.5 text-[9px] font-bold uppercase tracking-widest rounded-lg"
          style={{gridTemplateColumns:'auto auto 1fr 120px 90px 80px 90px 80px auto auto',gap:'0 12px',color:'var(--text-faint)',background:'var(--bg-input)',border:'1px solid var(--border-subtle)'}}>
          <span/><span/><span>Device</span><span>CPU</span><span>RAM</span>
          <span className="hidden lg:block">Disk</span>
          <span className="hidden xl:block">Network</span>
          <span className="hidden xl:block">Uptime</span>
          <span className="hidden lg:block">Age</span><span/>
        </div>
      )}

      {/* Device list */}
      {filtered.length===0 ? (
        <div className="glass rounded-2xl p-12 flex flex-col items-center gap-2 opacity-50">
          <Monitor size={22} style={{color:'var(--text-muted)'}}/>
          <p className="text-sm font-body" style={{color:'var(--text-muted)'}}>No devices match your filters</p>
        </div>
      ) : (
        <>
          <VirtualList items={filtered} metrics={metrics} expanded={expanded} onToggle={toggle}/>
          <p className="text-center text-[10px] font-mono" style={{color:'var(--text-faint)'}}>
            {filtered.length} of {devices.length} devices · {reporting} reporting · auto-updates every 5s
          </p>
        </>
      )}
    </div>
  )
}