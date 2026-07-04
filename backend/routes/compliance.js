// routes/compliance.js — Config drift / compliance snapshot API
// Gated behind its own permission bit (2048, MANAGE_COMPLIANCE) — admin-only
// by default, same reasoning as discovery.js: this touches every device's
// package/service/firewall state, which is more sensitive than routine
// device management.
'use strict';

const express = require('express');
const { param, body, validationResult } = require('express-validator');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const compliance = require('../services/complianceService');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

const MANAGE_COMPLIANCE = 2048;

function validate(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return true; }
  return false;
}

function safeJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

async function assertDevice(id, res) {
  const device = await queryOne('SELECT id, name, os_type FROM devices WHERE id = ?', [id]);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return null; }
  return device;
}

// ── GET /api/compliance/:deviceId/config ──────────────────────────────────────
router.get('/:deviceId/config', requirePermission(MANAGE_COMPLIANCE), param('deviceId').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  if (!(await assertDevice(req.params.deviceId, res))) return;
  try {
    const cfg = await queryOne('SELECT * FROM compliance_config WHERE device_id = ?', [req.params.deviceId]);
    res.json(cfg || { device_id: req.params.deviceId, enabled: false, check_interval_hours: 24, last_checked_at: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/compliance/:deviceId/config ──────────────────────────────────────
router.put('/:deviceId/config',
  requirePermission(MANAGE_COMPLIANCE),
  param('deviceId').isUUID(),
  body('enabled').isBoolean(),
  body('check_interval_hours').isInt({ min: 1, max: 720 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const device = await assertDevice(req.params.deviceId, res);
    if (!device) return;
    const { enabled, check_interval_hours } = req.body;
    const now = Math.floor(Date.now() / 1000);
    try {
      await execute(
        `INSERT INTO compliance_config (device_id, enabled, check_interval_hours, last_checked_at, updated_at)
         VALUES (?, ?, ?, NULL, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled),
           check_interval_hours = VALUES(check_interval_hours), updated_at = VALUES(updated_at)`,
        [req.params.deviceId, enabled ? 1 : 0, check_interval_hours, now]
      );
      await audit.log({
        userId: req.user.id, username: req.user.username, ipSource: req.realIp,
        action: 'compliance_config_updated', targetType: 'device', targetId: req.params.deviceId,
        targetName: device.name, result: 'success',
        details: `enabled=${enabled}, interval=${check_interval_hours}h`,
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ── POST /api/compliance/:deviceId/snapshot — run a check right now ──────────
router.post('/:deviceId/snapshot', requirePermission(MANAGE_COMPLIANCE), param('deviceId').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  if (!(await assertDevice(req.params.deviceId, res))) return;
  try {
    const result = await compliance.runCheck(req.params.deviceId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/compliance/:deviceId/snapshots — history ─────────────────────────
router.get('/:deviceId/snapshots', requirePermission(MANAGE_COMPLIANCE), param('deviceId').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  if (!(await assertDevice(req.params.deviceId, res))) return;
  try {
    const rows = await query(
      `SELECT id, device_id, raw_hash, status, diff, error, taken_at
         FROM compliance_snapshots WHERE device_id = ? ORDER BY taken_at DESC LIMIT 50`,
      [req.params.deviceId]
    );
    res.json(rows.map(r => ({ ...r, diff: safeJson(r.diff, null) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/compliance/:deviceId/snapshots/:id — full snapshot (raw lists) ──
router.get('/:deviceId/snapshots/:id',
  requirePermission(MANAGE_COMPLIANCE), param('deviceId').isUUID(), param('id').isUUID(),
  async (req, res) => {
    if (validate(req, res)) return;
    if (!(await assertDevice(req.params.deviceId, res))) return;
    try {
      const row = await queryOne(
        'SELECT * FROM compliance_snapshots WHERE id = ? AND device_id = ?',
        [req.params.id, req.params.deviceId]
      );
      if (!row) return res.status(404).json({ error: 'Snapshot not found' });
      res.json({ ...row, diff: safeJson(row.diff, null) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ── GET /api/compliance/:deviceId/baseline ────────────────────────────────────
router.get('/:deviceId/baseline', requirePermission(MANAGE_COMPLIANCE), param('deviceId').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  if (!(await assertDevice(req.params.deviceId, res))) return;
  try {
    const row = await queryOne('SELECT * FROM compliance_baselines WHERE device_id = ?', [req.params.deviceId]);
    res.json(row || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/compliance/:deviceId/baseline — set/reset the baseline ─────────
// Body: { snapshotId? }  — promote an existing snapshot, or omit to collect
// a fresh one right now and use that. This is the "accept current state /
// clear the drift warning" action.
router.post('/:deviceId/baseline',
  requirePermission(MANAGE_COMPLIANCE), param('deviceId').isUUID(),
  body('snapshotId').optional().isUUID(),
  async (req, res) => {
    if (validate(req, res)) return;
    const device = await assertDevice(req.params.deviceId, res);
    if (!device) return;
    try {
      const result = await compliance.setBaseline(req.params.deviceId, {
        snapshotId: req.body.snapshotId, userId: req.user.id,
      });
      await audit.log({
        userId: req.user.id, username: req.user.username, ipSource: req.realIp,
        action: 'compliance_baseline_set', targetType: 'device', targetId: req.params.deviceId,
        targetName: device.name, result: 'success',
        details: req.body.snapshotId ? `From snapshot ${req.body.snapshotId}` : 'From fresh collection',
      });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

module.exports = router;
