import React from 'react'
export default function StatCard({ icon: Icon, label, value, sub, iconColor, iconBg, accent }) {
  return (
    <div className="card flex items-center gap-4">
      <div className={`w-11 h-11 rounded-xl ${iconBg} border flex items-center justify-center shrink-0`}>
        <Icon size={20} className={iconColor} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-body text-slate-500 uppercase tracking-wide">{label}</p>
        <p className={`text-2xl font-display ${accent || 'text-white'} leading-none mt-0.5`}>{value}</p>
        {sub && <p className="text-xs text-slate-500 font-body mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}
