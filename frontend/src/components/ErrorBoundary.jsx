// components/ErrorBoundary.jsx — catches render-time exceptions in whatever
// it wraps and shows a recoverable fallback instead of an unhandled error
// unmounting the whole React tree (which is what a blank page actually is:
// nothing caught the throw, so React tore everything down).
//
// `resetKey` lets the parent clear the crashed state automatically — Layout
// passes the current route path, so navigating to a different page (forward
// or back) always gets a fresh mount instead of re-showing (or silently
// still being stuck behind) the same crash.
import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Keep a breadcrumb in the console for debugging — no telemetry here,
    // just enough to diagnose locally without the page going silently dark.
    console.error('UI crashed, caught by ErrorBoundary:', error, info)
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-[60vh] w-full flex flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(239,68,68,0.12)' }}>
            <AlertTriangle size={22} color="#ef4444" />
          </div>
          <p className="font-display text-base" style={{ color: 'var(--text-primary)' }}>
            Something went wrong on this page
          </p>
          <p className="font-body text-sm max-w-md" style={{ color: 'var(--text-muted)' }}>
            An unexpected error stopped this view from rendering. You can try again, or reload
            the app if the problem keeps happening.
          </p>
          <div className="flex items-center gap-2 mt-1">
            <button className="btn-ghost" onClick={() => this.setState({ error: null })}>
              <RefreshCw size={14} /> Try again
            </button>
            <button className="btn-ghost" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}