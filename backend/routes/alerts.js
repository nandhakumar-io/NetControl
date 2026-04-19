// routes/alerts.js — graceful fallback when tables don't exist yet
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

// ── SSE notification bus ───────────────────────────────────────────────────────
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
    const rows = await query(
      `SELECT tl.*, ar.metric, ar.severity, ar.threshold, ar.operator,
              ar.name AS rule_name, d.name AS device_name
         FROM alert_triggered_log tl
         JOIN alert_rules ar ON tl.rule_id = ar.id
    LEFT JOIN devices d ON tl.device_id = d.id
        ORDER BY tl.triggered_at DESC LIMIT ?`,
      [limit]
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
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!['cpu','ram','disk','offline','process_count'].includes(metric))
      return res.status(400).json({ error: 'invalid metric' });

    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    await execute(
      `INSERT INTO alert_rules
         (id, name, metric, operator, threshold, severity, device_id,
          actions, notify_admins, cooldown_sec, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name.trim(), metric, operator, threshold, severity,
       device_id || null, JSON.stringify(actions),
       notify_admins ? 1 : 0, cooldown_sec, enabled ? 1 : 0,
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
    } = req.body;

    await execute(
      `UPDATE alert_rules SET name=?, metric=?, operator=?, threshold=?, severity=?,
         device_id=?, actions=?, notify_admins=?, cooldown_sec=?, enabled=? WHERE id=?`,
      [name, metric, operator, threshold, severity,
       device_id || null, JSON.stringify(actions),
       notify_admins ? 1 : 0, cooldown_sec, enabled ? 1 : 0, req.params.id]
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

// ── Alert evaluator ────────────────────────────────────────────────────────────
const cooldowns = new Map();

async function evaluateAlerts(deviceId, snapshot) {
  try {
    if (!await tableExists('alert_rules')) return;
    const rules = await query(
      `SELECT * FROM alert_rules WHERE enabled = 1 AND (device_id IS NULL OR device_id = ?)`,
      [deviceId]
    );
    if (!rules.length) return;

    const now = Math.floor(Date.now() / 1000);
    const device = await queryOne('SELECT id, name FROM devices WHERE id = ?', [deviceId]);
    if (!device) return;

    for (const rule of rules) {
      const actions = JSON.parse(rule.actions || '[]');
      const ck = `${rule.id}:${deviceId}`;
      if ((now - (cooldowns.get(ck) || 0)) < (rule.cooldown_sec || 300)) continue;

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
      if (rule.metric === 'disk' && snapshot.disk?.length) {
        for (const d of snapshot.disk) {
          if (rule.operator === 'gt' ? d.use > rule.threshold : d.use < rule.threshold) {
            breached = true; details = `Disk ${d.mount}: ${d.use.toFixed(1)}% used`; break;
          }
        }
      }
      if (!breached) continue;

      cooldowns.set(ck, now);
      const logId = uuidv4();
      await execute(
        `INSERT INTO alert_triggered_log (id, rule_id, device_id, triggered_at, severity, details, actions_taken)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [logId, rule.id, deviceId, now, rule.severity, details, JSON.stringify(actions)]
      );

      if (rule.notify_admins) {
        const admins = await query('SELECT id FROM users WHERE role = ? AND enabled = 1', ['admin']);
        const notif = { type:'alert', severity:rule.severity, rule_name:rule.name,
          device_id:deviceId, device_name:device.name, metric:rule.metric, details, actions, triggered_at:now };
        for (const admin of admins) {
          await execute(
            `INSERT INTO alert_notifications (id, user_id, rule_id, device_id, severity, message, triggered_at, read_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
            [uuidv4(), admin.id, rule.id, deviceId, rule.severity,
             `${rule.name}: ${details} on ${device.name}`, now]
          );
        }
        pushNotification(admins.map(a => a.id), notif);
      }
      console.log(`[Alert] ${rule.severity.toUpperCase()} — ${rule.name} on ${device.name}: ${details}`);
    }
  } catch (e) { console.error('[Alert evaluator]', e.message); }
}

module.exports = { router, evaluateAlerts, pushNotification };
