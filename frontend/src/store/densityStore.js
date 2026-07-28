import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Table row density — 'comfortable' (default, py-3) or 'compact' (py-1.5).
// Applied as a class on <html> so any table row using the .table-row
// utility (see index.css) picks up the right padding without every page
// having to read this store directly.
export const useDensityStore = create(
  persist(
    (set) => ({
      density: 'comfortable', // 'comfortable' | 'compact'
      toggleDensity: () =>
        set((state) => {
          const next = state.density === 'comfortable' ? 'compact' : 'comfortable'
          document.documentElement.classList.toggle('density-compact', next === 'compact')
          return { density: next }
        }),
      applyDensity: (density) => {
        document.documentElement.classList.toggle('density-compact', density === 'compact')
      },
    }),
    { name: 'nc-density' }
  )
)