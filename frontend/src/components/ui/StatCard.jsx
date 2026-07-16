import React from 'react'
import { useThemeStore } from '../../store/themeStore'

// Fixed text-2xl regardless of content length is what caused the
// Organizations-page overlap/over-truncation bugs — any card showing a
// variable-length string (org/device/group names, usernames) was one long
// name away from the same problem. Stepping the font size down by
// character count means a long value shrinks to fit instead of relying on
// CSS ellipsis truncation as the only defense (truncate stays on as a
// safety net for the pathological case, but shouldn't be doing the heavy
// lifting for ordinary long-but-real names).
function valueSizeClass(value) {
  const len = typeof value === 'string' ? value.length : 0
  if (len > 28) return 'text-base'
  if (len > 20) return 'text-lg'
  if (len > 13) return 'text-xl'
  return 'text-2xl'
}

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
        <p className="text-xs font-body uppercase tracking-wide truncate" style={{ color: 'var(--text-muted)' }}>
          {label}
        </p>
        <p
          className={`${valueSizeClass(value)} font-display leading-tight mt-0.5 truncate ${accent || ''}`}
          style={!accent ? { color: 'var(--text-primary)' } : {}}
          title={typeof value === 'string' ? value : undefined}
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