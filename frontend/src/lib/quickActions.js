// lib/quickActions.js — parsing + candidate-resolution for the command
// palette's quick actions ("restart web-01", "run reboot-nginx on web-01",
// "ack disk-90 web-01"). Deliberately a small, fixed verb grammar rather
// than open text parsing: each verb maps to exactly one already-permission-
// checked mutation endpoint, so there's no ambiguity about what typing a
// sentence into search will actually do.
import api from './api'

// Order matters: 'run …on…' must be checked before the single-target verbs
// since it also starts with a word, and each pattern is anchored so a plain
// search like "restarting the vpn" (no target) or "wake on lan notes" won't
// misfire — the verb must be immediately followed by a target.
const VERBS = [
  { kind: 'runbook-run',   re: /^run\s+(.+?)\s+on\s+(.+)$/i },
  { kind: 'device-action', action: 'restart', re: /^restart\s+(.+)$/i },
  { kind: 'device-action', action: 'wake',    re: /^wake\s+(.+)$/i },
  { kind: 'alert-ack',     re: /^ack\s+(.+)$/i },
]

// Returns a parsed intent for the raw palette query, or null if it doesn't
// match a quick-action verb (in which case the palette falls back to its
// normal entity search).
export function parseQuickAction(raw) {
  const q = raw.trim()
  if (!q) return null
  for (const v of VERBS) {
    const m = q.match(v.re)
    if (!m) continue
    if (v.kind === 'runbook-run') {
      return { kind: v.kind, runbookQuery: m[1].trim(), deviceQuery: m[2].trim() }
    }
    if (v.kind === 'device-action') {
      return { kind: v.kind, action: v.action, deviceQuery: m[1].trim() }
    }
    if (v.kind === 'alert-ack') {
      return { kind: v.kind, alertQuery: m[1].trim() }
    }
  }
  return null
}

// Best-effort "top match" resolution — quick actions are meant to be fast,
// so this always returns a single best candidate (or null) rather than a
// list to disambiguate from. Reuses the same /search endpoint (and
// therefore the same RBAC scoping) the rest of the palette already calls.
async function topSearchMatch(query, category) {
  if (!query) return null
  const { data } = await api.get('/search', { params: { q: query } })
  const rows = data?.categories?.[category] || []
  if (!rows.length) return null
  const needle = query.toLowerCase()
  rows.sort((a, b) => {
    const aExact = (a.label || '').toLowerCase() === needle
    const bExact = (b.label || '').toLowerCase() === needle
    if (aExact !== bExact) return aExact ? -1 : 1
    return 0
  })
  return rows[0]
}

export function resolveDevice(query)  { return topSearchMatch(query, 'devices') }
export function resolveRunbook(query) { return topSearchMatch(query, 'runbooks') }

// Open (unresolved, unacknowledged) triggered alerts aren't a /search
// category — they're incidents, not a named entity — so this pulls the
// same list AlertsPage's history tab uses and matches client-side against
// rule name / device name. Capped list (matches the endpoint's own default)
// keeps this a "recent incidents" match, not a full history search.
export async function resolveOpenAlert(query) {
  if (!query) return null
  const { data } = await api.get('/alerts/triggered', { params: { limit: 200 } })
  const rows = (Array.isArray(data) ? data : []).filter(t => !t.acknowledged_at && !t.resolved_at)
  if (!rows.length) return null
  const needle = query.toLowerCase()
  const scored = rows
    .map(r => ({ row: r, text: `${r.rule_name || ''} ${r.device_name || ''}`.toLowerCase() }))
    .filter(x => x.text.includes(needle))
  if (!scored.length) return null
  scored.sort((a, b) => a.row.triggered_at < b.row.triggered_at ? 1 : -1)
  return scored[0].row
}