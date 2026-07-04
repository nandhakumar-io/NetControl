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

// ── GET /api/compliance — list every device with its current compliance
// status, joined against its latest snapshot + baseline presence. This is
// what CompliancePage.jsx's initial load() call hits.
router.get('/', requirePermission(MANAGE_COMPLIANCE), async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        d.id                        AS device_id,
        d.name                      AS device_name,
        d.ip_address                AS ip_address,
        d.os_type                   AS os_type,
        COALESCE(cc.enabled, 0)     AS enabled,
        COALESCE(cc.check_interval_hours, 24) AS check_interval_hours,
        cc.last_checked_at          AS last_checked_at,
        cb.created_at               AS baseline_created_at,
        ls.status                   AS latest_status,
        ls.diff                     AS latest_diff,
        ls.unreachable              AS latest_unreachable
      FROM devices d
      LEFT JOIN compliance_config cc ON cc.device_id = d.id
      LEFT JOIN compliance_baselines cb ON cb.device_id = d.id
      LEFT JOIN (
        SELECT s1.device_id, s1.status, s1.diff, s1.unreachable
        FROM compliance_snapshots s1
        INNER JOIN (
          SELECT device_id, MAX(taken_at) AS max_taken
          FROM compliance_snapshots GROUP BY device_id
        ) s2 ON s2.device_id = s1.device_id AND s2.max_taken = s1.taken_at
      ) ls ON ls.device_id = d.id
      ORDER BY d.name ASC
    `);
    res.json(rows.map(r => ({ ...r, latest_diff: safeJson(r.latest_diff, null) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
      `SELECT id, device_id, raw_hash, status, diff, error, unreachable, taken_at
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

// ── GET /api/compliance/:deviceId/files — list watched file paths ────────────
router.get('/:deviceId/files', requirePermission(MANAGE_COMPLIANCE), param('deviceId').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  if (!(await assertDevice(req.params.deviceId, res))) return;
  try {
    const rows = await query(
      'SELECT id, file_path, label, created_at FROM compliance_watched_files WHERE device_id = ? ORDER BY file_path ASC',
      [req.params.deviceId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/compliance/:deviceId/files — watch a new file path ─────────────
router.post('/:deviceId/files',
  requirePermission(MANAGE_COMPLIANCE), param('deviceId').isUUID(),
  body('file_path').isString().trim().isLength({ min: 1, max: 500 }),
  body('label').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const device = await assertDevice(req.params.deviceId, res);
    if (!device) return;
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    try {
      await execute(
        `INSERT INTO compliance_watched_files (id, device_id, file_path, label, created_at) VALUES (?,?,?,?,?)`,
        [id, req.params.deviceId, req.body.file_path, req.body.label || null, now]
      );
      await audit.log({
        userId: req.user.id, username: req.user.username, ipSource: req.realIp,
        action: 'compliance_file_watched', targetType: 'device', targetId: req.params.deviceId,
        targetName: device.name, result: 'success', details: req.body.file_path,
      });
      res.json({ id, device_id: req.params.deviceId, file_path: req.body.file_path, label: req.body.label || null, created_at: now });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That file path is already being watched for this device' });
      res.status(500).json({ error: e.message });
    }
  }
);

// ── DELETE /api/compliance/:deviceId/files/:id — stop watching a file ────────
router.delete('/:deviceId/files/:id',
  requirePermission(MANAGE_COMPLIANCE), param('deviceId').isUUID(), param('id').isUUID(),
  async (req, res) => {
    if (validate(req, res)) return;
    const device = await assertDevice(req.params.deviceId, res);
    if (!device) return;
    try {
      const row = await queryOne('SELECT file_path FROM compliance_watched_files WHERE id = ? AND device_id = ?', [req.params.id, req.params.deviceId]);
      if (!row) return res.status(404).json({ error: 'Watched file not found' });
      await execute('DELETE FROM compliance_watched_files WHERE id = ? AND device_id = ?', [req.params.id, req.params.deviceId]);
      await audit.log({
        userId: req.user.id, username: req.user.username, ipSource: req.realIp,
        action: 'compliance_file_unwatched', targetType: 'device', targetId: req.params.deviceId,
        targetName: device.name, result: 'success', details: row.file_path,
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

module.exports = router;