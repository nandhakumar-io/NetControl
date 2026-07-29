// components/ui/EmptyState.jsx — one consistent "nothing here yet" moment.
//
// Before this, an empty table/list was handled differently on every page:
// some just rendered nothing, some had a plain gray sentence, a few had an
// icon. None of them told the person what to DO about it. An empty screen
// is a moment to point at the next action (add a device, clear a filter,
// wait for the first check-in) — not a dead end.
import React from 'react'
import { useThemeStore } from '../../store/themeStore'

export default function EmptyState({ icon: Icon, title, description, action }) {
  const { theme } = useThemeStore()
  const isLight = theme === 'light'

  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      {Icon && (
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
          style={{
            background: isLight ? 'rgba(108,92,231,0.08)' : 'rgba(167,139,250,0.12)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <Icon size={22} style={{ color: 'var(--accent)' }} />
        </div>
      )}
      <p className="font-display text-base" style={{ color: 'var(--text-primary)' }}>
        {title}
      </p>
      {description && (
        <p className="font-body text-sm mt-1.5 max-w-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}