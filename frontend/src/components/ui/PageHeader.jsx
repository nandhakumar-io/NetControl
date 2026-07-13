import React from 'react'
import { useThemeStore } from '../../store/themeStore'

export default function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
  iconColor,
  iconBg,
}) {
  const { theme } = useThemeStore()
  const isLight = theme === 'light'

  const defaultIconBg = isLight
    ? 'bg-[#6c5ce7]'
    : 'bg-brand-500/15 border border-brand-500/25'

  const defaultIconColor = isLight ? 'text-white' : 'text-brand-400'

  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6">
      <div className="flex items-center gap-4 min-w-0">
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0
            ${iconBg ?? defaultIconBg}
          `}
          style={isLight ? {} : {}}
        >
          <Icon size={20} className={iconColor ?? defaultIconColor} />
        </div>
        <div className="min-w-0">
          <h1
            className="font-display text-lg sm:text-xl truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {title}
          </h1>
          {description && (
            <p
              className="text-sm font-body mt-0.5"
              style={{ color: 'var(--text-muted)' }}
            >
              {description}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  )
}