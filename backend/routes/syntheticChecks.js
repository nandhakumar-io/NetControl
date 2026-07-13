// routes/syntheticChecks.js — HTTP/TCP/SSH health-check CRUD + manual run +
// results history for SyntheticChecksPage.jsx.
'use strict';
const express = require('express');
const { body, param, query: queryValidator, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const runner = require('../services/syntheticCheckRunner');
const audit = require('../services/audit');

const MANAGE_SYNTHETIC_CHECKS = 65536;

const router = express.Router();
router.use(requireAuth, requireOrgContext);

function buildConfig(checkType, body) {
  const cfg = body.config || {};
  if (checkType === 'http') {
    const out = {};
    if (cfg.url) out.url = String(cfg.url);
    out.expect_status = cfg.expect_status ? Number(cfg.expect_status) : 200;
    if (cfg.expect_body_contains) out.expect_body_contains = String(cfg.expect_body_contains);
    return out;
  }
  if (checkType === 'tcp') {
    if (!cfg.port) throw new Error('port is required for a tcp check');
    return { port: Number(cfg.port) };
  }
  if (checkType === 'ssh_command') {
    if (!cfg.command) throw new Error('command is required for an ssh_command check');
    const out = { command: String(cfg.command) };
    if (cfg.expect_output_contains) out.expect_output_contains = String(cfg.expect_output_contains);
    return out;
  }
  throw new Error(`Unknown check_type: ${checkType}`);
}

// GET /api/synthetic-checks — list all checks in the current org, with the
// device name/ip joined in so the list doesn't need N follow-up requests.
router.get('/', requirePermission(MANAGE_SYNTHETIC_CHECKS), async (req, res) => {
  try {
    const rows = await query(
      `SELECT sc.*, d.name AS device_name, d.ip_address AS device_ip
       FROM synthetic_checks sc
       JOIN devices d ON d.id = sc.device_id
       WHERE sc.org_id = ? OR sc.org_id IS NULL
       ORDER BY sc.name ASC`,
      [req.orgId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/synthetic-checks — create a check.
router.post('/',
  requirePermission(MANAGE_SYNTHETIC_CHECKS),
  [
    body('device_id').isUUID(),
    body('name').trim().isLength({ min: 1, max: 150 }),
    body('check_type').isIn(['http', 'tcp', 'ssh_command']),
    body('interval_seconds').optional().isInt({ min: 10 }),
    body('timeout_ms').optional().isInt({ min: 500 }),
    body('failure_threshold').optional().isInt({ min: 1 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const device = await queryOne('SELECT id, org_id FROM devices WHERE id = ?', [req.body.device_id]);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      if (device.org_id && device.org_id !== req.orgId) {
        return res.status(403).json({ error: 'That device belongs to a different organization.' });
      }

      let config;
      try { config = buildConfig(req.body.check_type, req.body); }
      catch (e) { return res.status(400).json({ error: e.message }); }

      const id = uuidv4();
      await execute(
        `INSERT INTO synthetic_checks
           (id, org_id, device_id, name, check_type, config, interval_seconds, timeout_ms, failure_threshold)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.orgId, req.body.device_id, req.body.name.trim(), req.body.check_type,
         JSON.stringify(config), req.body.interval_seconds || 60, req.body.timeout_ms || 5000,
         req.body.failure_threshold || 2]
      );

      await audit.log({
        userId: req.user.id, username: req.user.username, orgId: req.orgId,
        action: 'synthetic_check_created', targetType: 'synthetic_check', targetId: id,
        targetName: req.body.name.trim(), result: 'success',
      });

      const created = await queryOne(
        `SELECT sc.*, d.name AS device_name, d.ip_address AS device_ip
         FROM synthetic_checks sc JOIN devices d ON d.id = sc.device_id WHERE sc.id = ?`,
        [id]
      );
      res.status(201).json(created);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// PUT /api/synthetic-checks/:id — partial update (name/config/interval/enabled/etc).
router.put('/:id',
  requirePermission(MANAGE_SYNTHETIC_CHECKS),
  param('id').isUUID(),
  async (req, res) => {
    try {
      const existing = await queryOne('SELECT * FROM synthetic_checks WHERE id = ? AND (org_id = ? OR org_id IS NULL)', [req.params.id, req.orgId]);
      if (!existing) return res.status(404).json({ error: 'Check not found' });

      const name             = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
      const enabled           = req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled;
      const intervalSeconds   = req.body.interval_seconds !== undefined ? Number(req.body.interval_seconds) : existing.interval_seconds;
      const timeoutMs         = req.body.timeout_ms !== undefined ? Number(req.body.timeout_ms) : existing.timeout_ms;
      const failureThreshold  = req.body.failure_threshold !== undefined ? Number(req.body.failure_threshold) : existing.failure_threshold;

      let config = existing.config;
      if (req.body.config !== undefined) {
        try { config = JSON.stringify(buildConfig(existing.check_type, req.body)); }
        catch (e) { return res.status(400).json({ error: e.message }); }
      }

      await execute(
        `UPDATE synthetic_checks
         SET name = ?, enabled = ?, interval_seconds = ?, timeout_ms = ?, failure_threshold = ?, config = ?
         WHERE id = ?`,
        [name, enabled, intervalSeconds, timeoutMs, failureThreshold, config, req.params.id]
      );

      const updated = await queryOne(
        `SELECT sc.*, d.name AS device_name, d.ip_address AS device_ip
         FROM synthetic_checks sc JOIN devices d ON d.id = sc.device_id WHERE sc.id = ?`,
        [req.params.id]
      );
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// DELETE /api/synthetic-checks/:id
router.delete('/:id', requirePermission(MANAGE_SYNTHETIC_CHECKS), param('id').isUUID(), async (req, res) => {
  try {
    const existing = await queryOne('SELECT id, name FROM synthetic_checks WHERE id = ? AND (org_id = ? OR org_id IS NULL)', [req.params.id, req.orgId]);
    if (!existing) return res.status(404).json({ error: 'Check not found' });

    await execute('DELETE FROM synthetic_checks WHERE id = ?', [req.params.id]); // cascades to results
    await audit.log({
      userId: req.user.id, username: req.user.username, orgId: req.orgId,
      action: 'synthetic_check_deleted', targetType: 'synthetic_check', targetId: req.params.id,
      targetName: existing.name, result: 'success',
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/synthetic-checks/:id/run — run immediately, outside its normal
// interval, and return the result right away (used by the "Run Now" button).
router.post('/:id/run', requirePermission(MANAGE_SYNTHETIC_CHECKS), param('id').isUUID(), async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT sc.*, d.ip_address, d.os_type, d.ssh_port, d.ssh_username, d.ssh_password, d.ssh_key
       FROM synthetic_checks sc JOIN devices d ON d.id = sc.device_id
       WHERE sc.id = ? AND (sc.org_id = ? OR sc.org_id IS NULL)`,
      [req.params.id, req.orgId]
    );
    if (!row) return res.status(404).json({ error: 'Check not found' });

    const check = {
      id: row.id, check_type: row.check_type, config: row.config,
      timeout_ms: row.timeout_ms, failure_threshold: row.failure_threshold,
      consecutive_failures: row.consecutive_failures, status: row.status,
    };
    const device = {
      ip_address: row.ip_address, os_type: row.os_type, ssh_port: row.ssh_port,
      ssh_username: row.ssh_username, ssh_password: row.ssh_password, ssh_key: row.ssh_key,
    };
    const result = await runner.executeAndRecord(check, device);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/synthetic-checks/:id/results?limit=50 — oldest→newest, capped at
// `limit` most recent runs (matches ResultsStrip's left-to-right sparkline).
router.get('/:id/results',
  requirePermission(MANAGE_SYNTHETIC_CHECKS),
  [param('id').isUUID(), queryValidator('limit').optional().isInt({ min: 1, max: 500 })],
  async (req, res) => {
    try {
      const owned = await queryOne('SELECT id FROM synthetic_checks WHERE id = ? AND (org_id = ? OR org_id IS NULL)', [req.params.id, req.orgId]);
      if (!owned) return res.status(404).json({ error: 'Check not found' });

      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
      const rows = await query(
        `SELECT ts, success, latency_ms, message FROM synthetic_check_results
         WHERE check_id = ? ORDER BY ts DESC LIMIT ${limit}`,
        [req.params.id]
      );
      res.json(rows.reverse().map(r => ({ ...r, success: !!r.success })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;