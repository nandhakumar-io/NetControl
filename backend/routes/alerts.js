// routes/alerts.js — graceful fallback when tables don't exist yet
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../services/audit');
const webhook = require('../services/webhook');
const { runRunbookById } = require('../services/runbookRunner');
const { requireOrgContext } = require('../middleware/tenant');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

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
  const results = [];

  if (toRun.length) {
    const { loadDevice, performAction } = require('./actions');
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
  }

  // ── Runbook actions (custom auto-remediation) ─────────────────────────
  // Distinct from the fixed wake/restart/shutdown list above — these are
  // admin-authored scripts (routes/runbooks.js), e.g. "restart nginx",
  // "clear ARP cache". Skipped entirely for 'offline' incidents for the
  // same reachability reason as restart/shutdown above.
  const runbookIds = rule.runbook_action_ids ? JSON.parse(rule.runbook_action_ids) : [];
  if (runbookIds.length && rule.metric !== 'offline') {
    const { loadDevice } = require('./actions');
    const device = await loadDevice(deviceId).catch(() => null);
    if (device) {
      for (const runbookId of runbookIds) {
        const outcome = await runRunbookById(runbookId, device, {
          triggeredBy: `alert rule: ${rule.name}`, ruleId: rule.id,
        }).catch(e => ({ result: 'failure', output: e.message, runbookName: runbookId }));
        results.push({ action: `runbook:${outcome.runbookName || runbookId}`, result: outcome.result, detail: outcome.output });
        await audit.log({
          username: 'system (alert rule)', action: 'run_runbook', targetType: 'device', targetId: deviceId,
          targetName: deviceName, result: outcome.result,
          details: `Runbook "${outcome.runbookName || runbookId}" auto-triggered by alert rule "${rule.name}": ${outcome.output}`,
        }).catch(() => {});
      }
    }
  }

  return results;
}


const pendingNotifications = new Map();
const sseClients = new Map();

function pushNotification(userIds, notification) {
  for (const uid of userIds) {
    // Build the enriched copy once and use it for BOTH the pending queue
    // (picked up on next /stream reconnect) and the live SSE write — this
    // used to build an enriched object with id/ts for the queue but write
    // the bare, id-less `notification` to already-open SSE clients, so a
    // live-pushed item had no `id`/`read_at` and couldn't be matched with
    // what GET /alerts/notifications later returns after a reload.
    const enriched = { ...notification, id: uuidv4(), ts: Date.now() };
    if (!pendingNotifications.has(uid)) pendingNotifications.set(uid, []);
    pendingNotifications.get(uid).push(enriched);
    if (sseClients.has(uid)) {
      for (const res of sseClients.get(uid)) {
        try { res.write(`data: ${JSON.stringify(enriched)}\n\n`); } catch {}
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

  // NOTE: this used to be a raw SSE comment (`: ping\n\n`). Comments never
  // reach EventSource's onmessage/onerror handlers at all, so the bell's
  // 45s-since-last-message watchdog (Layout.jsx's NotificationBell) had no
  // way to know the connection was still alive during a quiet stretch with
  // no real alerts — it just declared the stream "stalled" every ~45s and
  // showed "Live updates stopped" / Reconnect even though nothing was
  // actually wrong. A named `ping` event fixes that: the frontend listens
  // for it and treats it exactly like a real message. Same fix already
  // applied to routes/bulkCommand.js's stream.
  const ping = setInterval(() => { try { res.write('event: ping\ndata: {}\n\n'); } catch {} }, 20000);
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

// ── PATCH /api/alerts/notifications/:id/read ───────────────────────────────────
// Marks a single notification read (scoped to req.user.id so one user can't
// mark another admin's notification read). Used by the bell dropdown when a
// notification row is clicked, as an alternative to the all-or-nothing
// "Clear all" button.
router.patch('/notifications/:id/read', async (req, res) => {
  try {
    if (!await tableExists('alert_notifications')) return res.json({ ok: true });
    await execute(
      'UPDATE alert_notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
      [Date.now(), req.params.id, req.user.id]
    );
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
// ── Rule templates ────────────────────────────────────────────────────────────
// A small library of common alert rules an admin can enable in one click,
// instead of building every rule from scratch by hand. Deliberately not
// stored in the DB — this is static, versioned-with-the-code content, same
// spirit as the default runbooks seed. Enabling a template just creates a
// normal alert_rules row scoped to whatever the admin picked (a single
// device, a whole group, or every device in the org) — after that it's a
// completely ordinary rule, editable/deletable the same as any other.
const RULE_TEMPLATES = [
  {
    key: 'disk-90',
    name: 'Disk usage > 90%',
    description: 'Warns when any disk/partition on a device crosses 90% used — the classic "ran out of space" early warning.',
    metric: 'disk', operator: 'gt', threshold: 90, severity: 'warning',
    cooldown_sec: 3600, min_duration_sec: 0,
  },
  {
    key: 'disk-critical-97',
    name: 'Disk usage > 97% (critical)',
    description: 'Pages immediately once a disk is nearly completely full — little runway left before writes start failing.',
    metric: 'disk', operator: 'gt', threshold: 97, severity: 'critical',
    cooldown_sec: 1800, min_duration_sec: 0,
  },
  {
    key: 'cpu-sustained-90',
    name: 'CPU sustained high (>90% for 10 min)',
    description: 'Ignores brief spikes — only notifies once CPU has stayed above 90% continuously for 10 minutes.',
    metric: 'cpu', operator: 'gt', threshold: 90, severity: 'warning',
    cooldown_sec: 1800, min_duration_sec: 600,
  },
  {
    key: 'ram-90',
    name: 'RAM usage > 90%',
    description: 'Warns when memory usage crosses 90% — useful for catching a slow leak before it OOMs the box.',
    metric: 'ram', operator: 'gt', threshold: 90, severity: 'warning',
    cooldown_sec: 1800, min_duration_sec: 0,
  },
  {
    key: 'offline-5min',
    name: 'Offline for more than 5 minutes',
    description: 'Suppresses the flicker of a quick reboot or a single missed poll — only notifies once a device has stayed unreachable for 5+ minutes.',
    metric: 'offline', operator: 'gt', threshold: 0, severity: 'critical',
    cooldown_sec: 1800, min_duration_sec: 300,
  },
  {
    key: 'process-count-high',
    name: 'Process count spike (>400 processes)',
    description: 'Flags a runaway fork bomb or a stuck cron loop before it exhausts PIDs/memory.',
    metric: 'process_count', operator: 'gt', threshold: 400, severity: 'warning',
    cooldown_sec: 1800, min_duration_sec: 0,
  },
];

// ── GET /api/alerts/rule-templates ─────────────────────────────────────────────
router.get('/rule-templates', (req, res) => res.json(RULE_TEMPLATES));

// ── POST /api/alerts/rule-templates/:key/enable ────────────────────────────────
// Body: { group_id? , device_id?, tag? } — omit all three for an org-wide rule.
router.post('/rule-templates/:key/enable', requireRole('admin', 'operator'), async (req, res) => {
  try {
    const tpl = RULE_TEMPLATES.find(t => t.key === req.params.key);
    if (!tpl) return res.status(404).json({ error: 'Unknown template' });

    const { group_id = null, device_id = null, tag = null } = req.body || {};
    const scopeCount = [device_id, group_id, tag].filter(Boolean).length;
    if (scopeCount > 1) return res.status(400).json({ error: 'set only one of device_id, group_id, or tag' });

    if (group_id) {
      const group = await queryOne('SELECT id FROM `groups` WHERE id = ? AND org_id = ?', [group_id, req.orgId]);
      if (!group) return res.status(404).json({ error: 'Group not found' });
    }
    if (device_id) {
      const device = await queryOne('SELECT id FROM devices WHERE id = ? AND org_id = ?', [device_id, req.orgId]);
      if (!device) return res.status(404).json({ error: 'Device not found' });
    }

    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    await execute(
      `INSERT INTO alert_rules
         (id, org_id, name, metric, operator, threshold, severity, device_id, group_id, tag,
          actions, notify_admins, cooldown_sec, enabled, min_duration_sec, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)`,
      [id, req.orgId, tpl.name, tpl.metric, tpl.operator, tpl.threshold, tpl.severity,
       device_id || null, group_id || null, tag || null, JSON.stringify(['notify']),
       tpl.cooldown_sec, tpl.min_duration_sec || 0, req.user.id, now]
    );

    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'create_alert_rule', targetType: 'alert_rule', targetId: id,
      targetName: `${tpl.name} (from template)`, ipSource: req.realIp || req.ip, result: 'success' });

    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/rules', async (req, res) => {
  try {
    if (!await tableExists('alert_rules')) return res.json([]);
    const rows = await query(
      `SELECT ar.*, d.name AS device_name, g.name AS group_name FROM alert_rules ar
       LEFT JOIN devices d ON ar.device_id = d.id
       LEFT JOIN \`groups\` g ON ar.group_id = g.id
       WHERE ar.org_id = ? ORDER BY ar.created_at DESC`,
      [req.orgId]
    );
    res.json(rows.map(r => ({
      ...r,
      actions: JSON.parse(r.actions || '[]'),
      runbook_action_ids: JSON.parse(r.runbook_action_ids || '[]'),
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
      severity = 'warning', device_id = null, group_id = null, tag = null,
      actions = ['notify'], notify_admins = true,
      cooldown_sec = 300, enabled = true,
      escalate_after_sec = null, escalate_severity = 'critical', escalate_webhook_ids = null,
      runbook_action_ids = [], min_duration_sec = 0,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!['cpu','ram','disk','offline','process_count'].includes(metric))
      return res.status(400).json({ error: 'invalid metric' });
    const scopeCount = [device_id, group_id, tag].filter(Boolean).length;
    if (scopeCount > 1) return res.status(400).json({ error: 'set only one of device_id, group_id, or tag' });

    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    await execute(
      `INSERT INTO alert_rules
         (id, org_id, name, metric, operator, threshold, severity, device_id, group_id, tag,
          actions, notify_admins, cooldown_sec, enabled,
          escalate_after_sec, escalate_severity, escalate_webhook_ids,
          runbook_action_ids, min_duration_sec, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.orgId, name.trim(), metric, operator, threshold, severity,
       device_id || null, group_id || null, tag || null, JSON.stringify(actions),
       notify_admins ? 1 : 0, cooldown_sec, enabled ? 1 : 0,
       escalate_after_sec || null, escalate_severity || 'critical',
       escalate_webhook_ids ? JSON.stringify(escalate_webhook_ids) : null,
       JSON.stringify(runbook_action_ids || []), min_duration_sec || 0,
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
    const existing = await queryOne('SELECT * FROM alert_rules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    const {
      name = existing.name, metric = existing.metric, operator = existing.operator,
      threshold = existing.threshold, severity = existing.severity,
      device_id = existing.device_id, group_id = existing.group_id, tag = existing.tag,
      actions = JSON.parse(existing.actions || '[]'),
      notify_admins = existing.notify_admins,
      cooldown_sec = existing.cooldown_sec, enabled = existing.enabled,
      escalate_after_sec = existing.escalate_after_sec,
      escalate_severity = existing.escalate_severity || 'critical',
      escalate_webhook_ids = existing.escalate_webhook_ids ? JSON.parse(existing.escalate_webhook_ids) : null,
      runbook_action_ids = existing.runbook_action_ids ? JSON.parse(existing.runbook_action_ids) : [],
      min_duration_sec = existing.min_duration_sec || 0,
    } = req.body;

    const scopeCount = [device_id, group_id, tag].filter(Boolean).length;
    if (scopeCount > 1) return res.status(400).json({ error: 'set only one of device_id, group_id, or tag' });

    await execute(
      `UPDATE alert_rules SET name=?, metric=?, operator=?, threshold=?, severity=?,
         device_id=?, group_id=?, tag=?, actions=?, notify_admins=?, cooldown_sec=?, enabled=?,
         escalate_after_sec=?, escalate_severity=?, escalate_webhook_ids=?, runbook_action_ids=?,
         min_duration_sec=? WHERE id=?`,
      [name, metric, operator, threshold, severity,
       device_id || null, group_id || null, tag || null, JSON.stringify(actions),
       notify_admins ? 1 : 0, cooldown_sec, enabled ? 1 : 0,
       escalate_after_sec || null, escalate_severity || 'critical',
       escalate_webhook_ids ? JSON.stringify(escalate_webhook_ids) : null,
       JSON.stringify(runbook_action_ids || []), min_duration_sec || 0,
       req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/alerts/rules/:id ──────────────────────────────────────────────
router.delete('/rules/:id', requireRole('admin'), async (req, res) => {
  try {
    await execute('DELETE FROM alert_rules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
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

// ── POST /api/alerts/triggered/:id/snooze ──────────────────────────────────────
// The other half of the one-tap mobile triage flow (see push notification
// actions wired up below in evaluateAlerts / services/webPush.js): "I saw
// this, don't page me again for a while, but I haven't necessarily fixed it
// yet" — distinct from ack, which is meant to be permanent for that incident.
// snoozed_until is checked alongside `acknowledged` in the escalation guard
// further down so a snoozed breach doesn't escalate or re-notify until the
// snooze expires, at which point it behaves as if never snoozed.
// Body: { minutes?: number } — defaults to 60, capped to a sane range so a
// fat-fingered value from the push action (or a scripted call) can't
// silently snooze something for a year.
router.post('/triggered/:id/snooze', requireRole('admin', 'operator'), async (req, res) => {
  try {
    if (!await tableExists('alert_triggered_log')) return res.status(404).json({ error: 'Not found' });
    const row = await queryOne('SELECT id FROM alert_triggered_log WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Triggered alert not found' });

    const minutes = Math.min(Math.max(parseInt(req.body?.minutes) || 60, 5), 7 * 24 * 60);
    const now = Math.floor(Date.now() / 1000);
    const until = now + minutes * 60;
    await execute(
      'UPDATE alert_triggered_log SET snoozed_until = ?, snoozed_by = ? WHERE id = ?',
      [until, req.user.id, req.params.id]
    );
    res.json({ ok: true, snoozed_until: until });
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

async function notifyAdmins(rule, deviceId, deviceName, severity, message, now, logId = null) {
  const notificationPrefs = require('../services/notificationPrefs');
  const admins = await query('SELECT id FROM users WHERE role = ? AND enabled = 1', ['admin']);
  const allAdminIds = admins.map(a => a.id);

  // Per-user gating (severity threshold, channel on/off, temporary mute —
  // see services/notificationPrefs.js). Applied independently per channel:
  // someone might want everything in the bell but only critical pages to
  // their phone, or vice versa.
  const inAppRecipients = await notificationPrefs.filterRecipients(allAdminIds, 'in_app', severity);
  const pushRecipients  = await notificationPrefs.filterRecipients(allAdminIds, 'push', severity);

  for (const userId of inAppRecipients) {
    await execute(
      `INSERT INTO alert_notifications (id, user_id, rule_id, device_id, severity, message, triggered_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [uuidv4(), userId, rule.id, deviceId, severity, message, now]
    );
  }
  if (inAppRecipients.length) {
    pushNotification(inAppRecipients, {
      type: 'alert', severity, rule_name: rule.name, device_id: deviceId,
      device_name: deviceName, metric: rule.metric, message, triggered_at: now,
    });
  }

  // Real mobile/browser push (see services/webPush.js) — separate from the
  // in-app SSE notification above, which only reaches an open tab. Skipped
  // for 'info' severity (resolved messages) so a device coming back online
  // doesn't buzz someone's phone the same way an actual breach does; the
  // one-tap Acknowledge/Snooze actions only make sense for an open incident
  // anyway, which is exactly when logId is passed in.
  if (severity !== 'info' && pushRecipients.length) {
    const webPush = require('../services/webPush');
    const actions = logId
      ? [
          { action: 'ack',    title: 'Acknowledge' },
          { action: 'snooze', title: 'Snooze 1h' },
        ]
      : [];
    webPush.sendToUsers(pushRecipients, {
      title: `${severity === 'critical' ? '🔴' : '🟡'} ${rule.name}`,
      body: message,
      tag: logId ? `nc-alert-${logId}` : `nc-alert-${rule.id}-${deviceId}`,
      requireInteraction: severity === 'critical',
      data: { type: 'alert', logId, ruleId: rule.id, deviceId, severity, url: '/alerts' },
      actions,
    }).catch(() => {});
  }
}

async function evaluateAlerts(deviceId, snapshot) {
  try {
    if (!await tableExists('alert_rules')) return;

    const device = await queryOne('SELECT id, name, org_id, group_id, maintenance_mode FROM devices WHERE id = ?', [deviceId]);
    if (!device) return;
    // Device is under maintenance — suppress alerts (no log entry, no admin
    // notification, no webhook) until it's marked ok again.
    if (device.maintenance_mode) return;

    // Scoped to the device's own org — a "global" rule (device_id IS NULL
    // AND group_id IS NULL AND tag IS NULL) still only fires for devices
    // belonging to the same tenant, so one client's blanket "CPU > 90%" rule
    // never evaluates against another client's devices. A group-scoped rule
    // (group_id set) fires for every device currently in that group, and a
    // tag-scoped rule (tag set) fires for every device currently carrying
    // that tag — both dynamic, so a device added to the group/tag later is
    // automatically covered without needing the rule re-enabled.
    const rules = await query(
      `SELECT * FROM alert_rules
        WHERE enabled = 1 AND org_id = ?
          AND (device_id IS NULL OR device_id = ?)
          AND (group_id IS NULL OR group_id = ?)
          AND (tag IS NULL OR tag IN (SELECT tag FROM device_tags WHERE device_id = ?))`,
      [device.org_id, deviceId, device.group_id, deviceId]
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
          await notifyAdmins(rule, deviceId, device.name, rule.severity, `${rule.name}: ${details} on ${device.name}`, now, logId);
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

        // A duration-gated incident that cleared before ever reaching
        // min_duration_sec was never announced as breached in the first
        // place (notify_count stayed 0) — so there's nothing to resolve
        // from the admin's perspective. Sending a "back to normal" message
        // for a condition they were never told about is just confusing noise.
        if (state.notify_count === 0 && rule.min_duration_sec) continue;

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
        const minDuration = rule.min_duration_sec || 0;

        // Duration-gated rules (e.g. the "offline > 5 min" / "CPU sustained
        // high" templates) shouldn't notify on the very first breached poll
        // — that's the whole point of "sustained". Record the incident as
        // active (so BREACHED->BREACHED below can tell it's still ongoing
        // and check the elapsed time) but skip the log entry, notification,
        // and auto-actions until it's actually been breached that long.
        // notify_count stays 0 as the "hasn't graduated yet" marker.
        if (minDuration > 0) {
          await execute(
            `INSERT INTO alert_state (rule_id, device_id, is_active, first_breached_at, last_notified_at, notify_count,
                                       last_log_id, flap_count, flap_window_start, flapping, last_transition_at)
             VALUES (?, ?, 1, ?, NULL, 0, NULL, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE is_active=1, first_breached_at=VALUES(first_breached_at),
               last_notified_at=NULL, notify_count=0, last_log_id=NULL,
               flap_count=VALUES(flap_count), flap_window_start=VALUES(flap_window_start),
               flapping=VALUES(flapping), last_transition_at=VALUES(last_transition_at)`,
            [rule.id, deviceId, now, flap.flap_count, flap.flap_window_start, flap.flapping ? 1 : 0, now]
          );
          console.log(`[Alert] PENDING (duration-gated) — ${rule.name} on ${device.name}: waiting for ${minDuration}s before first notification`);
          continue;
        }

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
            if (rule.notify_admins) await notifyAdmins(rule, deviceId, device.name, 'warning', flapMsg, now, null);
            webhook.fire('alert.flapping', {
              device_id: deviceId, device_name: device.name, rule_name: rule.name,
              metric: rule.metric, severity: 'warning', message: flapMsg,
            }).catch(() => {});
          }
          console.log(`[Alert] FLAPPING — ${rule.name} on ${device.name} (suppressing individual notifications)`);
          continue;
        }

        if (rule.notify_admins) {
          await notifyAdmins(rule, deviceId, device.name, rule.severity, `${rule.name}: ${details} on ${device.name}`, now, logId);
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

      // Graduate a duration-gated incident (see the pending-state comment
      // above) into an actual first notification once it's persisted past
      // min_duration_sec. notify_count === 0 is exactly that "still
      // pending" marker — an already-notified incident never re-enters
      // this branch.
      if (rule.min_duration_sec && state.notify_count === 0 && openSec >= rule.min_duration_sec) {
        const logId = uuidv4();
        await execute(
          `INSERT INTO alert_triggered_log (id, rule_id, device_id, triggered_at, severity, details, actions_taken)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [logId, rule.id, deviceId, now, rule.severity, details, JSON.stringify(actions)]
        );
        await execute(
          'UPDATE alert_state SET notify_count = 1, last_notified_at = ?, last_log_id = ? WHERE rule_id = ? AND device_id = ?',
          [now, logId, rule.id, deviceId]
        );
        if (rule.notify_admins) {
          await notifyAdmins(rule, deviceId, device.name, rule.severity, `${rule.name}: ${details} on ${device.name} (sustained for ${formatDuration(openSec)})`, now, logId);
        }
        const autoActions = await performAlertActions(rule, deviceId, device.name, actions).catch(() => []);
        const actionSummary = autoActions.length
          ? ' — ' + autoActions.map(a => `${a.action}: ${a.result === 'success' ? (a.detail || 'ok') : `failed (${a.detail})`}`).join(', ')
          : '';
        const webhookEvent = rule.severity === 'critical' ? 'alert.critical' : 'alert.triggered';
        webhook.fire(webhookEvent, {
          device_id: deviceId, device_name: device.name, rule_name: rule.name,
          metric: rule.metric, severity: rule.severity, details: details + actionSummary,
          message: `${rule.name}: ${details} on ${device.name} (sustained for ${formatDuration(openSec)})${actionSummary}`,
        }).catch(() => {});
        console.log(`[Alert] ${rule.severity.toUpperCase()} — ${rule.name} on ${device.name} graduated after ${formatDuration(openSec)}: ${details}`);
        continue;
      }
      // Still pending (hasn't reached min_duration_sec yet) — stay quiet,
      // same as the initial OK->BREACHED gate above.
      if (rule.min_duration_sec && state.notify_count === 0) continue;

      const logRow = state.last_log_id
        ? await queryOne('SELECT acknowledged_at, snoozed_until FROM alert_triggered_log WHERE id = ?', [state.last_log_id])
        : null;
      const acknowledged = !!logRow?.acknowledged_at;
      const snoozed = !!(logRow?.snoozed_until && logRow.snoozed_until > now);

      // Snoozed (one-tap "Snooze 1h" from a push notification, see
      // routes/alerts.js POST /triggered/:id/snooze): stay completely quiet
      // — no escalation, no repeat reminder — until the snooze window
      // expires, then fall through to normal behavior again automatically.
      if (snoozed) continue;

      // One-shot escalation: fires once per incident, the first time it's
      // been open past escalate_after_sec, skipped entirely if a human
      // already acknowledged it (they know — no need to page harder).
      if (rule.escalate_after_sec && !acknowledged && state.notify_count < 2 && openSec >= rule.escalate_after_sec) {
        const escalateWebhookIds = rule.escalate_webhook_ids ? JSON.parse(rule.escalate_webhook_ids) : null;
        const escSeverity = rule.escalate_severity || 'critical';
        const escMsg = `ESCALATION: ${rule.name} on ${device.name} has been unresolved for ${formatDuration(openSec)} — ${details}`;

        if (rule.notify_admins) await notifyAdmins(rule, deviceId, device.name, escSeverity, escMsg, now, state.last_log_id);
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
          await notifyAdmins(rule, deviceId, device.name, rule.severity, `${rule.name}: ${details} on ${device.name} (still ongoing, open ${formatDuration(openSec)})`, now, state.last_log_id);
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