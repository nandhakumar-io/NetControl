// services/webhook.js — Webhook delivery engine
// Supports Slack, MS Teams, generic JSON, with HMAC signing + retry
'use strict';

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const { query, execute, queryOne } = require('../db');
const { v4: uuidv4 } = require('uuid');

// ── All supported event names ─────────────────────────────────────────────────
const EVENTS = {
  // Device events
  'device.offline':          'Device went offline',
  'device.online':           'Device came online',
  'device.wake':             'Wake-on-LAN sent',
  'device.shutdown':         'Shutdown command sent',
  'device.restart':          'Restart command sent',
  // Auth events
  'auth.login':              'User logged in',
  'auth.login_failed':       'Login attempt failed',
  'auth.ip_blocked':         'Login blocked by IP allowlist',
  // Alert events
  'alert.triggered':         'Alert rule triggered',
  'alert.critical':          'Critical alert triggered',
  // File push
  'file.push':               'File pushed to device(s)',
  // SSH / terminal
  'ssh.failure':             'SSH connection failed',
  // Process restriction policies
  'process.violation':       'Restricted process detected/blocked',
  // System
  'system.agent_registered': 'New agent registered',
};

module.exports.EVENTS = EVENTS;

// ── Build provider-specific payloads ──────────────────────────────────────────
function buildPayload(provider, event, data) {
  const ts    = new Date().toISOString();
  const emoji = {
    'device.offline': '🔴', 'device.online': '🟢', 'auth.ip_blocked': '🚫',
    'alert.critical': '🚨', 'alert.triggered': '⚠️', 'ssh.failure': '🔐',
    'auth.login_failed': '⛔', 'file.push': '📤', 'device.wake': '⚡',
    'device.shutdown': '🔴', 'device.restart': '🔄', 'system.agent_registered': '🤖',
    'process.violation': '🚫',
  }[event] || 'ℹ️';

  const text  = `${emoji} *${EVENTS[event] || event}*\n${data.message || JSON.stringify(data)}`;
  const title = EVENTS[event] || event;

  switch (provider) {
    case 'slack':
      return {
        text,
        attachments: [{
          color:  data.severity === 'critical' ? '#f87171' : data.severity === 'warning' ? '#facc15' : '#34d399',
          fields: Object.entries(data)
            .filter(([k]) => !['message','severity'].includes(k))
            .slice(0, 6)
            .map(([k, v]) => ({ title: k.replace(/_/g,' '), value: String(v), short: true })),
          footer: `NetControl · ${ts}`,
        }],
      };

    case 'teams':
      return {
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        summary:   title,
        themeColor: data.severity === 'critical' ? 'f87171' : data.severity === 'warning' ? 'facc15' : '34d399',
        title,
        text:       data.message || '',
        sections: [{
          facts: Object.entries(data)
            .filter(([k]) => !['message','severity'].includes(k))
            .slice(0, 6)
            .map(([k, v]) => ({ name: k.replace(/_/g,' '), value: String(v) })),
        }],
      };

    default: // generic JSON
      return { event, title, timestamp: ts, data };
  }
}

// ── Ensure delivery-log table exists ──────────────────────────────────────────
// webhook_log previously only got created inside db/migrate-security.js, in the
// same try block as `webhooks` + `ip_allowlist`, guarded by a FOREIGN KEY.
// If that one CREATE TABLE throws (FK name collision from a prior partial
// migration run, missing privileges, etc.) the whole function's catch just
// logs a warning and moves on — so `webhooks` can exist and work fine while
// `webhook_log` silently never gets created. That breaks both delivery
// logging (insert fails, swallowed by .catch(() => {})) and reading the log
// (select throws "table doesn't exist" -> 500 -> "Failed to load log").
//
// This makes table creation self-healing and independent of the FK, so it
// can never be blocked by an unrelated constraint failure.
let _logTableReady = false;
async function ensureLogTable() {
  if (_logTableReady) return;
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS webhook_log (
        id            CHAR(36)     NOT NULL PRIMARY KEY,
        webhook_id    CHAR(36)     NOT NULL,
        event         VARCHAR(100) NOT NULL,
        status        SMALLINT     NOT NULL DEFAULT 0,
        duration_ms   INT          DEFAULT NULL,
        error         TEXT         DEFAULT NULL,
        response_body TEXT         DEFAULT NULL,
        fired_at      INT UNSIGNED NOT NULL,
        INDEX idx_whl_webhook(webhook_id),
        INDEX idx_whl_time  (fired_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Add response_body to older installs that already have the table but
    // predate this column.
    await execute(`
      ALTER TABLE webhook_log
      ADD COLUMN IF NOT EXISTS response_body TEXT DEFAULT NULL
    `).catch(() => {});
    _logTableReady = true;
  } catch (e) {
    console.error('[Webhook] Failed to ensure webhook_log table:', e.message);
  }
}
module.exports.ensureLogTable = ensureLogTable;
ensureLogTable().catch(() => {}); // proactive — don't wait for first delivery/read

// ── HTTP POST helper with timeout ─────────────────────────────────────────────
function doPost(urlStr, body, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const lib    = url.protocol === 'https:' ? https : http;
    const data   = JSON.stringify(body);
    const start  = Date.now();

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      timeout:  timeoutMs,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent':     'NetControl-Webhook/1.0',
        ...headers,
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw, ms: Date.now() - start }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Webhook timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Deliver to one webhook ────────────────────────────────────────────────────
async function deliverOne(webhook, event, data) {
  const payload = buildPayload(webhook.provider, event, data);

  // HMAC-SHA256 signature (optional, for verification on receiver side)
  const extraHeaders = {};
  if (webhook.secret) {
    const sig = crypto.createHmac('sha256', webhook.secret)
      .update(JSON.stringify(payload))
      .digest('hex');
    extraHeaders['X-NetControl-Signature'] = `sha256=${sig}`;
  }

  let status = 0, durationMs = 0, error = null, responseBody = null;

  try {
    const res = await doPost(webhook.url, payload, extraHeaders);
    status       = res.status;
    durationMs   = res.ms;
    responseBody = (res.body || '').slice(0, 2000); // truncate — some receivers echo huge bodies

    // 2xx = success; anything else = failure
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}${responseBody ? `: ${responseBody.slice(0, 200)}` : ''}`);
    }
  } catch (e) {
    error  = e.message;
    status = status || 0;
  }

  // Log delivery attempt
  const now = Math.floor(Date.now() / 1000);
  await ensureLogTable();
  await execute(
    `INSERT INTO webhook_log (id, webhook_id, event, status, duration_ms, error, response_body, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), webhook.id, event, status, durationMs, error, responseBody, now]
  ).catch(e => console.error(`[Webhook] Failed to write delivery log for "${webhook.name}":`, e.message));

  // Update last_status, last_fired, fail_count
  const failed = error || (status < 200 || status >= 300);
  await execute(
    `UPDATE webhooks SET last_status=?, last_fired=?, fail_count=IF(?,fail_count+1,0) WHERE id=?`,
    [status, now, failed ? 1 : 0, webhook.id]
  ).catch(() => {});

  return { status, durationMs, error };
}

// ── In-memory webhook cache (60s TTL) ─────────────────────────────────────────
let _hooks     = null;
let _hooksTime = 0;
const HOOKS_TTL = 60_000;

async function getEnabledHooks() {
  const now = Date.now();
  if (_hooks && (now - _hooksTime) < HOOKS_TTL) return _hooks;
  try {
    _hooks     = await query('SELECT * FROM webhooks WHERE enabled = 1');
    _hooksTime = now;
  } catch { _hooks = []; }
  return _hooks;
}

function invalidateHookCache() { _hooks = null; }
module.exports.invalidateHookCache = invalidateHookCache;

// ── Maintenance-mode gate ──────────────────────────────────────────────────────
// Devices flagged maintenance_mode=1 have all their device-scoped webhook
// events suppressed (device.offline/online, alert.*, ssh.failure, etc.) until
// maintenance is cleared. Short TTL cache since fire() can be called very
// frequently (every metrics tick / poll cycle).
const _maintenanceCache = new Map(); // deviceId -> { value, ts }
const MAINTENANCE_TTL_MS = 10_000;

async function isDeviceUnderMaintenance(deviceId) {
  if (!deviceId) return false;
  const now = Date.now();
  const cached = _maintenanceCache.get(deviceId);
  if (cached && (now - cached.ts) < MAINTENANCE_TTL_MS) return cached.value;

  let value = false;
  try {
    const row = await queryOne('SELECT maintenance_mode FROM devices WHERE id = ?', [deviceId]);
    value = !!(row && row.maintenance_mode);
  } catch { value = false; }

  _maintenanceCache.set(deviceId, { value, ts: now });
  return value;
}

function invalidateMaintenanceCache(deviceId) {
  if (deviceId) _maintenanceCache.delete(deviceId);
  else _maintenanceCache.clear();
}
module.exports.invalidateMaintenanceCache = invalidateMaintenanceCache;

/**
 * Fire webhooks for a given event.
 * Runs concurrently; errors are caught per-webhook so one failure doesn't block others.
 * Device-scoped events (data.device_id set) are suppressed while that device
 * is flagged as under maintenance.
 */
async function fire(event, data = {}) {
  if (data.device_id && await isDeviceUnderMaintenance(data.device_id)) {
    return []; // suppressed — device under maintenance
  }

  let hooks;
  try {
    hooks = await getEnabledHooks();
  } catch { return []; }

  const applicable = hooks.filter(h => {
    try {
      const events = JSON.parse(h.events || '[]');
      return events.includes(event) || events.includes('*');
    } catch { return false; }
  });

  if (!applicable.length) return [];

  const results = await Promise.allSettled(
    applicable.map(h => deliverOne(h, event, data))
  );

  return results.map((r, i) => ({
    webhookId:   applicable[i].id,
    webhookName: applicable[i].name,
    ...(r.status === 'fulfilled' ? r.value : { error: r.reason?.message }),
  }));
}

module.exports.fire = fire;

// ── CRUD ──────────────────────────────────────────────────────────────────────
async function listHooks() {
  return query('SELECT id, name, url, provider, events, enabled, last_status, last_fired, fail_count, created_at FROM webhooks ORDER BY created_at DESC');
}
async function getHook(id) {
  return query('SELECT * FROM webhooks WHERE id = ?', [id]).then(r => r[0] || null);
}
async function createHook({ name, url, provider = 'generic', secret = null, events = [], enabled = true, createdBy = null }) {
  const id  = uuidv4();
  const now = Math.floor(Date.now() / 1000);
  await execute(
    `INSERT INTO webhooks (id, name, url, provider, secret, events, enabled, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, url, provider, secret || null, JSON.stringify(events), enabled ? 1 : 0, createdBy || null, now]
  );
  invalidateHookCache();
  return id;
}
async function updateHook(id, patch) {
  const allowed = ['name', 'url', 'provider', 'secret', 'events', 'enabled'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(k === 'events' ? JSON.stringify(v) : v); }
  }
  if (!sets.length) return;
  vals.push(id);
  await execute(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`, vals);
  invalidateHookCache();
}
async function deleteHook(id) {
  await execute('DELETE FROM webhooks WHERE id = ?', [id]);
  invalidateHookCache();
}
async function getDeliveryLog(webhookId, limit = 50) {
  await ensureLogTable();
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  try {
    return await query(
      `SELECT * FROM webhook_log WHERE webhook_id = ? ORDER BY fired_at DESC LIMIT ${safeLimit}`,
      [webhookId]
    );
  } catch (e) {
    console.error('[Webhook] getDeliveryLog failed:', e.message);
    return [];
  }
}

module.exports.listHooks     = listHooks;
module.exports.getHook       = getHook;
module.exports.createHook    = createHook;
module.exports.updateHook    = updateHook;
module.exports.deleteHook    = deleteHook;
module.exports.getDeliveryLog= getDeliveryLog;