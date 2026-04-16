import React from 'react'
export default function PageHeader({ icon: Icon, title, description, actions, iconColor = 'text-brand-400', iconBg = 'bg-brand-500/15 border-brand-500/25' }) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div className="flex items-center gap-4">
        <div className={`w-10 h-10 rounded-xl ${iconBg} border flex items-center justify-center shrink-0`}>
          <Icon size={20} className={iconColor} />
        </div>
        <div>
          <h1 className="font-display text-xl text-white">{title}</h1>
          {description && <p className="text-sm text-slate-400 font-body mt-0.5">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
