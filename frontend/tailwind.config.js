/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Archivo Black"', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'monospace'],
        body:    ['"DM Sans"', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#f0f9ff',
          100: '#e0f2fe',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          900: '#0c4a6e',
        },
        // Purple brand scale — used in light mode via CSS overrides
        purple: {
          50:  '#f5f3ff',
          100: '#ede9fe',
          400: '#a78bfa',
          500: '#6c5ce7',
          600: '#5a4bd1',
          900: '#2e1a87',
        },
        surface: {
          0: '#09090f',
          1: '#0f0f1a',
          2: '#141420',
          3: '#1a1a2e',
          4: '#1f1f38',
          5: '#252542',
        },
        // Light mode surfaces
        light: {
          bg:      '#eef0f5',
          surface: '#ffffff',
          muted:   '#f5f5fa',
          border:  'rgba(0,0,0,0.07)',
        },
        accent: {
          green:  '#22c55e',
          yellow: '#eab308',
          red:    '#ef4444',
          orange: '#f97316',
          purple: '#a855f7',
          cyan:   '#06b6d4',
        },
      },
      animation: {
        'fade-in':  'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16,1,0.3,1)',
        'glow':     'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        fadeIn:  { from: { opacity: 0 }, to: { opacity: 1 } },
        slideUp: { from: { opacity: 0, transform: 'translateY(16px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        glow:    { from: { boxShadow: '0 0 5px #0ea5e940' }, to: { boxShadow: '0 0 20px #0ea5e980, 0 0 40px #0ea5e940' } },
      },
      boxShadow: {
        'card-light': '0 1px 3px rgba(0,0,0,0.07), 0 4px 16px rgba(0,0,0,0.04)',
        'card-hover-light': '0 4px 16px rgba(108,92,231,0.12), 0 2px 8px rgba(0,0,0,0.05)',
        'purple-glow': '0 4px 16px rgba(108,92,231,0.35)',
      },
    },
  },
  plugins: [],
}

