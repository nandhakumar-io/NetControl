// lib/paletteHistory.js — a small client-side "recently used" list for the
// command palette, so the empty-query state (the highest-traffic moment —
// every Cmd+K session passes through it before a keystroke) is useful
// instead of a static placeholder. Deliberately localStorage, not a backend
// table: this is per-browser convenience state, not something that needs to
// sync across devices or survive a password reset.
const STORAGE_KEY = 'nc_palette_recent'
const MAX_ITEMS = 8

function readRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// Returns entries newest-first, each shaped like a normal palette result
// item (id/type/label/sublabel/path/status) so it can be rendered and
// navigated with the exact same row component as a live search result.
export function getRecent() {
  return readRaw()
}

// Records a navigation or executed quick action. `entry` should carry at
// least {type, id, label, path}; anything extra (sublabel/status) is kept
// for rendering. De-duplicates on type+id and moves the existing entry to
// the front rather than creating a second row, so repeatedly jumping to the
// same device doesn't clutter the list with copies.
export function recordRecent(entry) {
  if (!entry?.type || entry?.id === undefined || entry?.id === null) return
  try {
    const existing = readRaw().filter(e => !(e.type === entry.type && e.id === entry.id))
    const next = [{ ...entry, _ts: Date.now() }, ...existing].slice(0, MAX_ITEMS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch { /* localStorage unavailable (private mode, quota) — recent list is a nicety, fail silently */ }
}

export function clearRecent() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
}1