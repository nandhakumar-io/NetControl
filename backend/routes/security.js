// routes/security.js — IP Allowlist + Webhook management API
// All routes: admin only
'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../middleware/auth');
const ipSvc = require('../services/ipAllowlist');
const whSvc = require('../services/webhook');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// ── Validation helpers ────────────────────────────────────────────────────────
function validate(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return true; }
  return false;
}

// ════════════════════════════════════════════════════════════════
// IP ALLOWLIST
// ════════════════════════════════════════════════════════════════

// GET /api/security/ip-allowlist
router.get('/ip-allowlist', async (req, res) => {
  try { res.json(await ipSvc.listRules()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/security/ip-allowlist
router.post('/ip-allowlist',
  body('cidr').notEmpty().isString().isLength({ max: 50 }),
  body('label').optional().isString().isLength({ max: 100 }),
  body('user_id').optional({ nullable: true }).isUUID(),
  body('role').optional({ nullable: true }).isIn(['admin', 'operator', 'viewer', 'custom']),
  body('enabled').optional().isBoolean(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { cidr, label, user_id, role, enabled = true } = req.body;
      // Basic CIDR format check
      const cidrPattern = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
      if (!cidrPattern.test(cidr)) {
        return res.status(400).json({ error: 'Invalid CIDR format. Use x.x.x.x or x.x.x.x/prefix' });
      }
      const id = await ipSvc.createRule({ userId: user_id || null, role: role || null, cidr, label, enabled, createdBy: req.user.id });
      await audit.log({ userId: req.user.id, username: req.user.username, action: 'create_ip_rule', targetType: 'ip_allowlist', targetId: id, targetName: cidr, ipSource: req.realIp, result: 'success' });
      res.status(201).json({ id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// PUT /api/security/ip-allowlist/:id
router.put('/ip-allowlist/:id', param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    await ipSvc.updateRule(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/security/ip-allowlist/:id
router.delete('/ip-allowlist/:id', param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    await ipSvc.deleteRule(req.params.id);
    await audit.log({ userId: req.user.id, username: req.user.username, action: 'delete_ip_rule', targetType: 'ip_allowlist', targetId: req.params.id, ipSource: req.realIp, result: 'success' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/security/ip-allowlist/test — test if an IP would be allowed
router.post('/ip-allowlist/test',
  body('ip').notEmpty(),
  body('role').optional().isString(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { ip, role = 'operator', user_id = null } = req.body;
      const result = await ipSvc.isIPAllowed(ip, user_id, role);
      res.json({ ip, role, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// GET /api/security/ip-allowlist/blocked — recent blocked attempts
router.get('/ip-allowlist/blocked', async (req, res) => {
  try {
    const { query } = require('../db');
    const rows = await query('SELECT * FROM ip_block_log ORDER BY blocked_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
// WEBHOOKS
// ════════════════════════════════════════════════════════════════

// GET /api/security/webhooks
router.get('/webhooks', async (req, res) => {
  try { res.json(await whSvc.listHooks()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/security/webhooks
router.post('/webhooks',
  body('name').notEmpty().isString().isLength({ max: 100 }),
  body('url').isURL({ protocols: ['http', 'https'], require_tld: false }),
  body('provider').optional().isIn(['slack', 'teams', 'generic']),
  body('secret').optional({ nullable: true }).isString().isLength({ max: 200 }),
  body('events').isArray({ min: 1 }),
  body('enabled').optional().isBoolean(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { name, url, provider = 'generic', secret, events, enabled = true } = req.body;
      const id = await whSvc.createHook({ name, url, provider, secret: secret || null, events, enabled, createdBy: req.user.id });
      await audit.log({ userId: req.user.id, username: req.user.username, action: 'create_webhook', targetType: 'webhook', targetId: id, targetName: name, ipSource: req.realIp, result: 'success' });
      res.status(201).json({ id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// PUT /api/security/webhooks/:id
router.put('/webhooks/:id', param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    await whSvc.updateHook(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/security/webhooks/:id
router.delete('/webhooks/:id', param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    await whSvc.deleteHook(req.params.id);
    await audit.log({ userId: req.user.id, username: req.user.username, action: 'delete_webhook', targetType: 'webhook', targetId: req.params.id, ipSource: req.realIp, result: 'success' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/security/webhooks/:id/test — send a test event
router.post('/webhooks/:id/test', param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const hook = await whSvc.getHook(req.params.id);
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });
    const events = JSON.parse(hook.events || '[]');
    const testEvent = events[0] || 'device.offline';
    const results = await whSvc.fire(testEvent, {
      message: `Test delivery from NetControl — webhook "${hook.name}"`,
      device: 'Test Device', ip: '192.168.1.100',
      severity: 'info', triggered_by: req.user.username,
    });
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/security/webhooks/:id/log — delivery history
router.get('/webhooks/:id/log', param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(await whSvc.getDeliveryLog(req.params.id, limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/security/events — list all supported event names
router.get('/events', (req, res) => {
  res.json(whSvc.EVENTS);
});

// ADD THESE ROUTES to the bottom of backend/routes/security.js
// (before module.exports = router)
//
// They add brute-force ban management endpoints to the existing Security page.

const bf = require('../services/bruteForce');

// ── GET /api/security/bans — list active IP bans ───────────────────────────────
router.get('/bans', async (req, res) => {
  try {
    const includeExpired = req.query.all === '1';
    const bans = await bf.listBans(includeExpired);
    // Also include in-progress attempt counts (not yet banned)
    const watching = bf.getAttemptCounts();
    res.json({ bans, watching });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/security/bans/:id — lift a ban ─────────────────────────────────
router.delete('/bans/:id', async (req, res) => {
  try {
    await bf.liftBan(req.params.id, req.user.id);
    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'lift_ip_ban', targetType: 'ip_ban', targetId: req.params.id,
      ipSource: req.realIp, result: 'success',
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/security/bans/check?ip=x.x.x.x — check if an IP is banned ────────
router.get('/bans/check', async (req, res) => {
  try {
    const ip = req.query.ip;
    if (!ip) return res.status(400).json({ error: 'ip query param required' });
    const result = await bf.isBanned(ip);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;
