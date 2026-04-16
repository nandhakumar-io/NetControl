import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // REST API
      '/api': {
        target:      'http://localhost:4000',
        changeOrigin: true,
      },
      // WebSocket SSH proxy
      '/ws': {
        target:      'http://localhost:4000',
        changeOrigin: true,
        ws:           true,   // ← tells Vite to proxy WS upgrades too
      },
    }
  }
})
