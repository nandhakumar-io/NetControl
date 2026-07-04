/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      // Bumped up ~1-2px across the board — a lot of secondary/meta text
      // (sidebar subtitles, badges, table cells) was rendering at the
      // Tailwind default 12px and was hard to read.
      fontSize: {
        xs:   ['0.8125rem', { lineHeight: '1.25rem' }],   // 13px (was 12px)
        sm:   ['0.9375rem', { lineHeight: '1.4rem'  }],   // 15px (was 14px)
        base: ['1.0625rem', { lineHeight: '1.6rem'  }],   // 17px (was 16px)
        lg:   ['1.1875rem', { lineHeight: '1.75rem' }],   // 19px (was 18px)
        xl:   ['1.3125rem', { lineHeight: '1.75rem' }],   // 21px (was 20px)
        '2xl':['1.5625rem', { lineHeight: '2rem'    }],   // 25px (was 24px)
      },
      fontFamily: {
        display: ['"Archivo Black"', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'monospace'],
        body:    ['"DM Sans"', 'sans-serif'],
      },
      colors: {
        // Violet-blue brand scale — the single accent hue used across both
        // the light and dark themes (previously dark mode used a separate
        // sky-blue scale here, which read as a different color family from
        // the light theme's violet buttons).
        brand: {
          50:  '#f5f3ff',
          100: '#ede9fe',
          400: '#a78bfa',
          500: '#7c5cf5',
          600: '#6c5ce7',
          900: '#2e1a87',
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
        glow:    { from: { boxShadow: '0 0 5px #7c5cf540' }, to: { boxShadow: '0 0 20px #7c5cf580, 0 0 40px #7c5cf540' } },
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