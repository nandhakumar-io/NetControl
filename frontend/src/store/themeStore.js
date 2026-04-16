import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useThemeStore = create(
  persist(
    (set) => ({
      theme: 'dark', // 'dark' | 'light'
      toggleTheme: () =>
        set((state) => {
          const next = state.theme === 'dark' ? 'light' : 'dark'
          document.documentElement.classList.toggle('light', next === 'light')
          return { theme: next }
        }),
      applyTheme: (theme) => {
        document.documentElement.classList.toggle('light', theme === 'light')
      },
    }),
    { name: 'nc-theme' }
  )
)
