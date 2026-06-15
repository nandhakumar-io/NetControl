import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // REST API
      '/api': {
        target:       'http://localhost:4000',
        changeOrigin: true,
        // Suppress noisy ECONNREFUSED logs when backend is temporarily down
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            if (err.code === 'ECONNREFUSED') {
              // Return a clean 503 instead of crashing the proxy stream
              if (res && !res.headersSent) {
                res.writeHead(503, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Backend unavailable' }))
              }
            }
          })
        },
      },
      // WebSocket SSH proxy
      '/ws': {
        target:       'http://localhost:4000',
        changeOrigin: true,
        ws:           true,
        configure: (proxy) => {
          proxy.on('error', () => {}) // suppress WS connection errors silently
        },
      },
    }
  }
})
