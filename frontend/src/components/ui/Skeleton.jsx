// components/ui/Skeleton.jsx — shaped loading placeholders.
//
// Most pages currently gate their whole render behind `if (loading) return
// <Loader2 className="animate-spin" />` centered in an otherwise blank
// page. That's a flash of empty white/black before anything appears, and
// it gives no sense of what's about to load. A skeleton that traces the
// actual shape of the content (a row of stat cards, a table's rows) makes
// the wait feel shorter and the layout feel stable — nothing jumps around
// once real data replaces the placeholder, because it's already sized the
// same as the real thing.
import React from 'react'

function Shimmer({ className = '', style = {} }) {
  return (
    <div
      className={`skeleton-shimmer rounded-md ${className}`}
      style={{ background: 'var(--bg-surface-3)', ...style }}
    />
  )
}

// A row of stat cards (dashboards, DevicesPage's summary strip, etc).
export function StatCardSkeleton({ count = 4 }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card flex items-center gap-4">
          <Shimmer className="w-11 h-11 shrink-0" />
          <div className="min-w-0 flex-1">
            <Shimmer className="h-3 w-16 mb-2" />
            <Shimmer className="h-6 w-12" />
          </div>
        </div>
      ))}
    </div>
  )
}

// A table/list body — rows of device/user/alert-shaped bars.
export function RowsSkeleton({ rows = 6 }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card flex items-center gap-4 py-3">
          <Shimmer className="w-8 h-8 shrink-0" />
          <Shimmer className="h-3.5 flex-1 max-w-[220px]" />
          <Shimmer className="h-3.5 w-20 hidden sm:block" />
          <Shimmer className="h-3.5 w-16 hidden md:block" />
        </div>
      ))}
    </div>
  )
}

export default Shimmer