// routes/alerts.js — graceful fallback when tables don't exist yet
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../services/audit');
const webhook = require('../services/webhook');

const router = express.Router();
router.use(requireAuth);

// ── Auto-actions: alert rules can list actions like ['notify','wake'] — until
// now 'actions' was only ever stored/logged, never actually executed, so a
// rule configured to "wake the device when it's offline" silently did
// nothing but notify. This actually runs the meaningful action types and
// folds the outcome into the webhook message, so a Telegram critical alert
// says both "device X is down" AND "wake packet sent" / "wake failed: ..."
// in the same message instead of just paging you with no next step.
const AUTO_ACTIONS = ['wake', 'restart', 'shutdown'];
async function performAlertActions(rule, deviceId, deviceName, actions) {
  const toRun = (actions || []).filter(a => AUTO_ACTIONS.includes(a));
  if (!toRun.length) return [];

  const { loadDevice, performAction } = require('./actions');
  const results = [];
  for (const action of toRun) {
    // 'restart'/'shutdown' only make sense against a device that's actually
    // reachable — running them for an offline-triggered rule would just
    // fail (or hang on a dead SSH/WinRM connection), so only 'wake' runs
    // automatically for offline incidents.
    if (action !== 'wake' && rule.metric === 'offline') continue;
    let result = 'success', detail;
    try {
      const device = await loadDevice(deviceId);
      if (!device) throw new Error('Device not found');
      detail = await performAction(action, device);
    } catch (e) {
      result = 'failure'; detail = e.message;
    }
    results.push({ action, result, detail });
    await audit.log({
      username: 'system (alert rule)', action, targetType: 'device', targetId: deviceId,
      targetName: deviceName, result, details: `Auto-triggered by alert rule "${rule.name}": ${detail}`,
    }).catch(() => {});
  }
  return results;
}


const pendingNotifications = new Map();
const sseClients = new Map();

function pushNotification(userIds, notification) {
  for (const uid of userIds) {
    if (!pendingNotifications.has(uid)) pendingNotifications.set(uid, []);
    pendingNotifications.get(uid).push({ ...notification, id: uuidv4(), ts: Date.now() });
    if (sseClients.has(uid)) {
      for (const res of sseClients.get(uid)) {
        try { res.write(`data: ${JSON.stringify(notification)}\n\n`); } catch {}
      }
    }
  }
}

// Helper — returns true if a table exists
async function tableExists(name) {
  try {
    const rows = await query(
      `SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
      [name]
    );
    return rows.length > 0;
  } catch { return false; }
}

// ── GET /api/alerts/stream (SSE) ───────────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const uid = req.user.id;
  if (!sseClients.has(uid)) sseClients.set(uid, new Set());
  sseClients.get(uid).add(res);

  const pending = pendingNotifications.get(uid) || [];
  pending.forEach(n => res.write(`data: ${JSON.stringify(n)}\n\n`));
  pendingNotifications.set(uid, []);

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(ping); sseClients.get(uid)?.delete(res); });
});

// ── GET /api/alerts/notifications ─────────────────────────────────────────────
router.get('/notifications', async (req, res) => {
  try {
    if (!await tableExists('alert_notifications')) return res.json([]);
    const rows = await query(
      `SELECT * FROM alert_notifications WHERE user_id = ? ORDER BY triggered_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch { res.json([]); }
});

// ── DELETE /api/alerts/notifications ──────────────────────────────────────────
router.delete('/notifications', async (req, res) => {
  try {
    if (!await tableExists('alert_notifications')) return res.json({ ok: true });
    await execute('DELETE FROM alert_notifications WHERE user_id = ?', [req.user.id]);
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// ── GET /api/alerts/triggered ─────────────────────────────────────────────────
router.get('/triggered', async (req, res) => {
  try {
    if (!await tableExists('alert_triggered_log')) return res.json([]);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    // limit is inlined (not bound as `LIMIT ?`) — see routes/processPolicies.js
    // for why: mysql2's execute()-based query() doesn't reliably support a
    // bound parameter inside LIMIT. Safe here since limit is already coerced
    // to a bounded integer above. This route's catch previously masked the
    // failure by returning [] instead of a 500, so it silently showed no
    // triggered alerts on every request rather than erroring visibly.
    const rows = await query(
      `SELECT tl.*, ar.metric, ar.severity, ar.threshold, ar.operator,
              ar.name AS rule_name, d.name AS device_name
         FROM alert_triggered_log tl
         JOIN alert_rules ar ON tl.rule_id = ar.id
    LEFT JOIN devices d ON tl.device_id = d.id
        ORDER BY tl.triggered_at DESC LIMIT ${limit}`
    );
    res.json(rows);
  } catch (e) { res.json([]); }
});

// ── GET /api/alerts/rules ──────────────────────────────────────────────────────
router.get('/rules', async (req, res) => {
  try {
    if (!await tableExists('alert_rules')) return res.json([]);
    const rows = await query(
      `SELECT ar.*, d.name AS device_name FROM alert_rules ar
       LEFT JOIN devices d ON ar.device_id = d.id ORDER BY ar.created_at DESC`
    );
    res.json(rows.map(r => ({
      ...r,
      actions: JSON.parse(r.actions || '[]'),
      enabled: !!r.enabled,
      notify_admins: !!r.notify_admins,
    })));
  } catch { res.json([]); }
});

// ── POST /api/alerts/rules ─────────────────────────────────────────────────────
router.post('/rules', requireRole('admin', 'operator'), async (req, res) => {
  try {
    const {
      name, metric, operator = 'gt', threshold = 90,
      severity = 'warning', device_id = null,
      actions = ['notify'], notify_admins = true,
      cooldown_sec = 300, enabled = true,
      escalate_after_sec = null, escalate_severity = 'critical', escalate_webhook_ids = null,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!['cpu','ram','disk','offline','process_count'].includes(metric))
      return res.status(400).json({ error: 'invalid metric' });

    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    await execute(
      `INSERT INTO alert_rules
         (id, name, metric, operator, threshold, severity, device_id,
          actions, notify_admins, cooldown_sec, enabled,
          escalate_after_sec, escalate_severity, escalate_webhook_ids,
          created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name.trim(), metric, operator, threshold, severity,
       device_id || null, JSON.stringify(actions),
       notify_admins ? 1 : 0, cooldown_sec, enabled ? 1 : 0,
       escalate_after_sec || null, escalate_severity || 'critical',
       escalate_webhook_ids ? JSON.stringify(escalate_webhook_ids) : null,
       req.user.id, now]
    );

    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'create_alert_rule', targetType: 'alert_rule', targetId: id,
      targetName: name, ipSource: req.realIp || req.ip, result: 'success' });

    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/alerts/rules/:id ──────────────────────────────────────────────────
router.put('/rules/:id', requireRole('admin', 'operator'), async (req, res) => {
  try {
    const existing = await queryOne('SELECT * FROM alert_rules WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    const {
      name = existing.name, metric = existing.metric, operator = existing.operator,
      threshold = existing.threshold, severity = existing.severity,
      device_id = existing.device_id,
      actions = JSON.parse(existing.actions || '[]'),
      notify_admins = existing.notify_admins,
      cooldown_sec = existing.cooldown_sec, enabled = existing.enabled,
      escalate_after_sec = existing.escalate_after_sec,
      escalate_severity = existing.escalate_severity || 'critical',
      escalate_webhook_ids = existing.escalate_webhook_ids ? JSON.parse(existing.escalate_webhook_ids) : null,
    } = req.body;

    await execute(
      `UPDATE alert_rules SET name=?, metric=?, operator=?, threshold=?, severity=?,
         device_id=?, actions=?, notify_admins=?, cooldown_sec=?, enabled=?,
         escalate_after_sec=?, escalate_severity=?, escalate_webhook_ids=? WHERE id=?`,
      [name, metric, operator, threshold, severity,
       device_id || null, JSON.stringify(actions),
       notify_admins ? 1 : 0, cooldown_sec, enabled ? 1 : 0,
       escalate_after_sec || null, escalate_severity || 'critical',
       escalate_webhook_ids ? JSON.stringify(escalate_webhook_ids) : null,
       req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/alerts/rules/:id ──────────────────────────────────────────────
router.delete('/rules/:id', requireRole('admin'), async (req, res) => {
  try {
    await execute('DELETE FROM alert_rules WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/alerts/triggered/:id/ack ────────────────────────────────────────
// Acknowledging an open incident stops it from escalating further (see
// evaluateAlerts' `acknowledged` check) without needing the underlying
// condition to actually clear first — useful for "yes I saw it, I'm on it"
// without waiting for a fix to land.
router.post('/triggered/:id/ack', requireRole('admin', 'operator'), async (req, res) => {
  try {
    if (!await tableExists('alert_triggered_log')) return res.status(404).json({ error: 'Not found' });
    const row = await queryOne('SELECT id FROM alert_triggered_log WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Triggered alert not found' });
    const now = Math.floor(Date.now() / 1000);
    await execute(
      'UPDATE alert_triggered_log SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?',
      [now, req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Alert evaluator ────────────────────────────────────────────────────────────
// Noise-control model (all state lives in the `alert_state` table, not
// process memory — see db/migrate.js migration 012 for why that matters:
// routes/metrics.js runs inside the clustered web tier, so an in-memory Map
// here would be a different Map per worker):
//
//   OK -> BREACHED           : new incident. Logged, notified, unless the
//                              rule/device pair is currently flapping.
//   BREACHED -> BREACHED     : ongoing. Suppressed until either
//                              escalate_after_sec elapses (one-time
//                              escalation, skipped if already acknowledged)
//                              or cooldown_sec elapses (a plain repeat
//                              reminder, same as the old behavior).
//   BREACHED -> OK           : resolved. One "back to normal" notice,
//                              clears the active state.
//   rapid OK<->BREACHED flips: flap suppression — once a rule/device flips
//                              FLAP_THRESHOLD times inside FLAP_WINDOW_SEC,
//                              a single "flapping" notice replaces the
//                              normal per-flip notifications until it
//                              settles down for a full window.
const FLAP_WINDOW_SEC = 600; // 10 minutes
const FLAP_THRESHOLD  = 4;   // transitions within the window before calling it a flap

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

// Advances flap tracking for a transition (either direction) happening now.
// Resets the count if the previous window has expired, otherwise increments it.
function advanceFlapTracking(prevState, now) {
  const windowStart = prevState.flap_window_start;
  let flapCount = prevState.flap_count || 0;
  let flapping  = !!prevState.flapping;
  if (!windowStart || (now - windowStart) > FLAP_WINDOW_SEC) {
    flapCount = 1;
    return { flap_count: flapCount, flap_window_start: now, flapping: false };
  }
  flapCount += 1;
  if (flapCount >= FLAP_THRESHOLD) flapping = true;
  return { flap_count: flapCount, flap_window_start: windowStart, flapping };
}

async function notifyAdmins(rule, deviceId, deviceName, severity, message, now) {
  const admins = await query('SELECT id FROM users WHERE role = ? AND enabled = 1', ['admin']);
  for (const admin of admins) {
    await execute(
      `INSERT INTO alert_notifications (id, user_id, rule_id, device_id, severity, message, triggered_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [uuidv4(), admin.id, rule.id, deviceId, severity, message, now]
    );
  }
  pushNotification(admins.map(a => a.id), {
    type: 'alert', severity, rule_name: rule.name, device_id: deviceId,
    device_name: deviceName, metric: rule.metric, message, triggered_at: now,
  });
}

async function evaluateAlerts(deviceId, snapshot) {
  try {
    if (!await tableExists('alert_rules')) return;

    const device = await queryOne('SELECT id, name, maintenance_mode FROM devices WHERE id = ?', [deviceId]);
    if (!device) return;
    // Device is under maintenance — suppress alerts (no log entry, no admin
    // notification, no webhook) until it's marked ok again.
    if (device.maintenance_mode) return;

    const rules = await query(
      `SELECT * FROM alert_rules WHERE enabled = 1 AND (device_id IS NULL OR device_id = ?)`,
      [deviceId]
    );
    if (!rules.length) return;

    const now = Math.floor(Date.now() / 1000);
    const hasStateTable = await tableExists('alert_state');

    for (const rule of rules) {
      const actions = JSON.parse(rule.actions || '[]');

      let breached = false, details = '';

      if (rule.metric === 'cpu' && snapshot.cpu != null) {
        breached = rule.operator === 'gt' ? snapshot.cpu > rule.threshold : snapshot.cpu < rule.threshold;
        details = `CPU ${snapshot.cpu.toFixed(1)}% (threshold ${rule.operator==='gt'?'>':'<'}${rule.threshold}%)`;
      }
      if (rule.metric === 'ram' && snapshot.ram) {
        const pct = (snapshot.ram.used / snapshot.ram.total) * 100;
        breached = rule.operator === 'gt' ? pct > rule.threshold : pct < rule.threshold;
        details = `RAM ${pct.toFixed(1)}% used`;
      }
      // Offline event — fired by statusPoller when a device goes offline
      if (rule.metric === 'offline' && snapshot._offline === true) {
        breached = true;
        details  = `Device went offline`;
      }

      if (rule.metric === 'disk' && snapshot.disk?.length) {
        for (const d of snapshot.disk) {
          if (rule.operator === 'gt' ? d.use > rule.threshold : d.use < rule.threshold) {
            breached = true; details = `Disk ${d.mount}: ${d.use.toFixed(1)}% used`; break;
          }
        }
      }

      // Fallback if the alert_state migration hasn't been applied yet (very
      // old install mid-upgrade): behave like the previous plain-cooldown
      // logic rather than crashing every evaluation.
      if (!hasStateTable) {
        if (!breached) continue;
        const logId = uuidv4();
        await execute(
          `INSERT INTO alert_triggered_log (id, rule_id, device_id, triggered_at, severity, details, actions_taken)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [logId, rule.id, deviceId, now, rule.severity, details, JSON.stringify(actions)]
        );
        if (rule.notify_admins) {
          await notifyAdmins(rule, deviceId, device.name, rule.severity, `${rule.name}: ${details} on ${device.name}`, now);
        }
        webhook.fire(rule.severity === 'critical' ? 'alert.critical' : 'alert.triggered', {
          device_id: deviceId, device_name: device.name, rule_name: rule.name,
          metric: rule.metric, severity: rule.severity, details,
          message: `${rule.name}: ${details} on ${device.name}`,
        }).catch(() => {});
        continue;
      }

      const state = await queryOne(
        'SELECT * FROM alert_state WHERE rule_id = ? AND device_id = ?', [rule.id, deviceId]
      ) || {
        is_active: 0, first_breached_at: null, last_notified_at: null, notify_count: 0,
        last_log_id: null, flap_count: 0, flap_window_start: null, flapping: 0, last_transition_at: null,
      };

      // ── BREACHED -> OK ────────────────────────────────────────────────────
      if (!breached) {
        if (!state.is_active) continue; // already OK — nothing to do

        const flap = advanceFlapTracking(state, now);
        await execute(
          `INSERT INTO alert_state (rule_id, device_id, is_active, first_breached_at, last_notified_at, notify_count,
                                     last_log_id, flap_count, flap_window_start, flapping, last_transition_at)
           VALUES (?, ?, 0, NULL, NULL, 0, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE is_active=0, first_breached_at=NULL, last_notified_at=NULL, notify_count=0,
             flap_count=VALUES(flap_count), flap_window_start=VALUES(flap_window_start),
             flapping=VALUES(flapping), last_transition_at=VALUES(last_transition_at)`,
          [rule.id, deviceId, state.last_log_id, flap.flap_count, flap.flap_window_start, flap.flapping ? 1 : 0, now]
        );

        if (state.last_log_id) {
          await execute('UPDATE alert_triggered_log SET resolved_at = ? WHERE id = ?', [now, state.last_log_id]);
        }

        const openedFor = state.first_breached_at ? formatDuration(now - state.first_breached_at) : null;
        const resolvedMsg = `${rule.name} on ${device.name} is back to normal${openedFor ? ` (was breached for ${openedFor})` : ''}`;

        if (rule.notify_admins) await notifyAdmins(rule, deviceId, device.name, 'info', resolvedMsg, now);
        webhook.fire('alert.resolved', {
          device_id: deviceId, device_name: device.name, rule_name: rule.name,
          metric: rule.metric, severity: 'info', message: resolvedMsg,
        }).catch(() => {});

        console.log(`[Alert] RESOLVED — ${rule.name} on ${device.name}`);
        continue;
      }

      // ── OK -> BREACHED (new incident) ────────────────────────────────────
      if (!state.is_active) {
        const flap = advanceFlapTracking(state, now);
        const logId = uuidv4();

        await execute(
          `INSERT INTO alert_triggered_log (id, rule_id, device_id, triggered_at, severity, details, actions_taken)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [logId, rule.id, deviceId, now, rule.severity, details, JSON.stringify(actions)]
        );

        await execute(
          `INSERT INTO alert_state (rule_id, device_id, is_active, first_breached_at, last_notified_at, notify_count,
                                     last_log_id, flap_count, flap_window_start, flapping, last_transition_at)
           VALUES (?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE is_active=1, first_breached_at=VALUES(first_breached_at),
             last_notified_at=VALUES(last_notified_at), notify_count=1, last_log_id=VALUES(last_log_id),
             flap_count=VALUES(flap_count), flap_window_start=VALUES(flap_window_start),
             flapping=VALUES(flapping), last_transition_at=VALUES(last_transition_at)`,
          [rule.id, deviceId, now, now, logId, flap.flap_count, flap.flap_window_start, flap.flapping ? 1 : 0, now]
        );

        if (flap.flapping) {
          // Only announce "this is flapping" once per time it newly crosses
          // the threshold — not on every single flip after that, or the
          // "noise control" notice becomes its own noise.
          if (!state.flapping) {
            const flapMsg = `${rule.name} on ${device.name} is flapping — triggered/cleared ${flap.flap_count} times in the last ${Math.round(FLAP_WINDOW_SEC / 60)} min. Notifications for this condition are suppressed until it settles down.`;
            if (rule.notify_admins) await notifyAdmins(rule, deviceId, device.name, 'warning', flapMsg, now);
            webhook.fire('alert.flapping', {
              device_id: deviceId, device_name: device.name, rule_name: rule.name,
              metric: rule.metric, severity: 'warning', message: flapMsg,
            }).catch(() => {});
          }
          console.log(`[Alert] FLAPPING — ${rule.name} on ${device.name} (suppressing individual notifications)`);
          continue;
        }

        if (rule.notify_admins) {
          await notifyAdmins(rule, deviceId, device.name, rule.severity, `${rule.name}: ${details} on ${device.name}`, now);
        }
        const autoActions = await performAlertActions(rule, deviceId, device.name, actions).catch(() => []);
        const actionSummary = autoActions.length
          ? ' — ' + autoActions.map(a => `${a.action}: ${a.result === 'success' ? (a.detail || 'ok') : `failed (${a.detail})`}`).join(', ')
          : '';
        const webhookEvent = rule.severity === 'critical' ? 'alert.critical' : 'alert.triggered';
        webhook.fire(webhookEvent, {
          device_id: deviceId, device_name: device.name, rule_name: rule.name,
          metric: rule.metric, severity: rule.severity, details: details + actionSummary,
          message: `${rule.name}: ${details} on ${device.name}${actionSummary}`,
        }).catch(() => {});

        console.log(`[Alert] ${rule.severity.toUpperCase()} — ${rule.name} on ${device.name}: ${details}`);
        continue;
      }

      // ── BREACHED -> BREACHED (ongoing) ───────────────────────────────────
      // Skip entirely while flapping — flap state only clears on a fresh
      // transition once a full window passes without one, handled above.
      if (state.flapping) continue;

      const openSec = now - (state.first_breached_at || now);
      const logRow = state.last_log_id
        ? await queryOne('SELECT acknowledged_at FROM alert_triggered_log WHERE id = ?', [state.last_log_id])
        : null;
      const acknowledged = !!logRow?.acknowledged_at;

      // One-shot escalation: fires once per incident, the first time it's
      // been open past escalate_after_sec, skipped entirely if a human
      // already acknowledged it (they know — no need to page harder).
      if (rule.escalate_after_sec && !acknowledged && state.notify_count < 2 && openSec >= rule.escalate_after_sec) {
        const escalateWebhookIds = rule.escalate_webhook_ids ? JSON.parse(rule.escalate_webhook_ids) : null;
        const escSeverity = rule.escalate_severity || 'critical';
        const escMsg = `ESCALATION: ${rule.name} on ${device.name} has been unresolved for ${formatDuration(openSec)} — ${details}`;

        if (rule.notify_admins) await notifyAdmins(rule, deviceId, device.name, escSeverity, escMsg, now);
        webhook.fire('alert.escalated', {
          device_id: deviceId, device_name: device.name, rule_name: rule.name,
          metric: rule.metric, severity: escSeverity, details, message: escMsg,
        }, { webhookIds: escalateWebhookIds || undefined }).catch(() => {});

        await execute(
          'UPDATE alert_state SET notify_count = 2, last_notified_at = ? WHERE rule_id = ? AND device_id = ?',
          [now, rule.id, deviceId]
        );
        console.log(`[Alert] ESCALATED — ${rule.name} on ${device.name} (open ${formatDuration(openSec)})`);
        continue;
      }

      // Plain repeat reminder while still breached, same cadence the old
      // cooldown_sec provided — just correctly shared across every worker
      // now instead of living in one process's memory.
      if ((now - (state.last_notified_at || 0)) >= (rule.cooldown_sec || 300)) {
        if (rule.notify_admins) {
          await notifyAdmins(rule, deviceId, device.name, rule.severity, `${rule.name}: ${details} on ${device.name} (still ongoing, open ${formatDuration(openSec)})`, now);
        }
        const webhookEvent = rule.severity === 'critical' ? 'alert.critical' : 'alert.triggered';
        webhook.fire(webhookEvent, {
          device_id: deviceId, device_name: device.name, rule_name: rule.name,
          metric: rule.metric, severity: rule.severity, details,
          message: `${rule.name}: ${details} on ${device.name} (still ongoing, open ${formatDuration(openSec)})`,
        }).catch(() => {});
        await execute(
          'UPDATE alert_state SET last_notified_at = ?, notify_count = notify_count + 1 WHERE rule_id = ? AND device_id = ?',
          [now, rule.id, deviceId]
        );
      }
      // else: fully suppressed until cooldown/escalation next applies —
      // this silence is the noise control working as intended.
    }
  } catch (e) { console.error('[Alert evaluator]', e.message); }
}

/**
 * evaluateOffline — called by statusPoller when a device transitions online → offline.
 * Fires any alert rules with metric='offline' for this device.
 */
async function evaluateOffline(deviceId, deviceName) {
  return evaluateAlerts(deviceId, { _offline: true, hostname: deviceName });
}

module.exports = { router, evaluateAlerts, evaluateOffline, pushNotification };