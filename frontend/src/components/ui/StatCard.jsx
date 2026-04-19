import React from 'react'
import { useThemeStore } from '../../store/themeStore'

export default function StatCard({ icon: Icon, label, value, sub, iconColor, iconBg, accent }) {
  const { theme } = useThemeStore()
  const isLight = theme === 'light'

  return (
    <div className="card flex items-center gap-4">
      <div
        className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 ${iconBg}`}
        style={isLight ? { borderColor: 'var(--border-subtle)' } : {}}
      >
        <Icon size={20} className={iconColor} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-body uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {label}
        </p>
        <p
          className={`text-2xl font-display leading-none mt-0.5 ${accent || ''}`}
          style={!accent ? { color: 'var(--text-primary)' } : {}}
        >
          {value}
        </p>
        {sub && (
          <p className="text-xs font-body mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {sub}
          </p>
        )}
      </div>
    </div>
  )
}