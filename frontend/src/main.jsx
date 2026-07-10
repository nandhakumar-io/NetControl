import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import '@xterm/xterm/css/xterm.css'
import { registerServiceWorker } from './lib/push'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { registerServiceWorker() })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
)