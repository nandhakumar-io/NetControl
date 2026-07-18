// services/notificationPrefs.js — Per-user in-app + push notification
// preferences (severity threshold per channel, on/off, temporary mute).
//
// Consumed by routes/alerts.js's notifyAdmins() and
// services/capacityForecast.js's fan-out, right before they'd otherwise
// insert an alert_notifications row / call webPush.sendToUsers for every
// admin unconditionally. Deliberately NOT applied to services/webhook.js —
// see db/migrate-notification-prefs.js for why webhooks stay org-level.
//
// Same in-memory cache pattern as webhook.js's getEnabledHooks(): short TTL,
// invalidated on write, falls back to defaults on any DB error rather than
// ever blocking/dropping a notification because this table had a hiccup.
'use strict';
const { query, queryOne, execute } = require('../db');

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };
const DEFAULTS = {
  in_app_enabled: 1, in_app_min_severity: 'info',
  push_enabled: 1, push_min_severity: 'warning',
  muted_until: null,
};

let _cache = null;      // userId -> row
let _cacheTime = 0;
const CACHE_TTL = 60_000;

async function loadAll() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) return _cache;
  try {
    const rows = await query('SELECT * FROM user_notification_prefs');
    _cache = new Map(rows.map(r => [r.user_id, r]));
    _cacheTime = now;
  } catch {
    // Table missing (migration not yet run) or DB hiccup — fail open with
    // an empty cache so every user just gets DEFAULTS, never silence.
    _cache = new Map();
    _cacheTime = now;
  }
  return _cache;
}

function invalidate() { _cache = null; }
module.exports.invalidate = invalidate;

function effective(row) {
  return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
}

async function getPrefs(userId) {
  const all = await loadAll();
  return effective(all.get(userId));
}
module.exports.getPrefs = getPrefs;

async function updatePrefs(userId, patch) {
  const allowed = ['in_app_enabled', 'in_app_min_severity', 'push_enabled', 'push_min_severity', 'muted_until'];
  const current = await getPrefs(userId);
  const merged = { ...current };
  for (const k of allowed) {
    if (patch[k] !== undefined) merged[k] = patch[k];
  }
  const now = Math.floor(Date.now() / 1000);
  await execute(
    `INSERT INTO user_notification_prefs
       (user_id, in_app_enabled, in_app_min_severity, push_enabled, push_min_severity, muted_until, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       in_app_enabled = VALUES(in_app_enabled), in_app_min_severity = VALUES(in_app_min_severity),
       push_enabled = VALUES(push_enabled), push_min_severity = VALUES(push_min_severity),
       muted_until = VALUES(muted_until), updated_at = VALUES(updated_at)`,
    [userId, merged.in_app_enabled ? 1 : 0, merged.in_app_min_severity,
     merged.push_enabled ? 1 : 0, merged.push_min_severity, merged.muted_until || null, now]
  );
  invalidate();
  return merged;
}
module.exports.updatePrefs = updatePrefs;

function meetsSeverity(severity, minSeverity) {
  const rank = SEVERITY_RANK[severity] ?? SEVERITY_RANK.info;
  const min  = SEVERITY_RANK[minSeverity] ?? SEVERITY_RANK.info;
  return rank >= min;
}

/**
 * Given a list of userIds who would normally get a notification for
 * `severity` on `channel` ('in_app' | 'push'), returns the subset that
 * actually want it right now: channel enabled, severity meets their
 * threshold, and not currently muted. Fails open per-user (a bad/missing
 * row never removes someone who should be notified).
 */
async function filterRecipients(userIds, channel, severity) {
  if (!userIds || !userIds.length) return [];
  const all = await loadAll();
  const now = Math.floor(Date.now() / 1000);
  const enabledKey = channel === 'push' ? 'push_enabled' : 'in_app_enabled';
  const severityKey = channel === 'push' ? 'push_min_severity' : 'in_app_min_severity';

  return [...new Set(userIds)].filter(uid => {
    const prefs = effective(all.get(uid));
    if (prefs.muted_until && Number(prefs.muted_until) > now) return false;
    if (!prefs[enabledKey]) return false;
    return meetsSeverity(severity, prefs[severityKey]);
  });
}
module.exports.filterRecipients = filterRecipients;