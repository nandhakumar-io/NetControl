// routes/bulkCommandSchedules.js — CRUD for cron-scheduled saved bulk
// commands (bulk_command_schedules table). Same trust bar as
// routes/bulkCommand.js's interactive /run: admin/operator only, org +
// group scoped. Unlike /run, creating/editing a schedule does NOT require
// an action PIN — consistent with routes/schedules.js (device power-action
// cron) and the backup/log-export/SLA-report schedule routes, none of
// which gate schedule *creation* behind a PIN since there's no interactive
// moment for the PIN modal to attach to once cron takes over.
'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');
const cron = require('node-cron');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const scheduler = require('../services/bulkCommandScheduler');

const router = express.Router();
router.use(requireAuth, requireOrgContext, requireRole('admin', 'operator'));

// Confirms every requested device actually belongs to this org before a
// schedule can be saved against it — same defense-in-depth principle as
// routes/bulkCommand.js's per-device loadDevice() check, just done as one
// batch query since there's no live execution happening at save time.
async function verifyDeviceAccess(deviceIds, orgId) {
  if (!deviceIds.length) return { valid: [], invalid: [] };
  const placeholders = deviceIds.map(() => '?').join(',');
  const rows = await query(`SELECT id FROM devices WHERE id IN (${placeholders}) AND org_id = ?`, [...deviceIds, orgId]);
  const validSet = new Set(rows.map(r => r.id));
  return {
    valid: deviceIds.filter(id => validSet.has(id)),
    invalid: deviceIds.filter(id => !validSet.has(id)),
  };
}

const scheduleValidation = [
  body('name').isString().trim().isLength({ min: 1, max: 100 }),
  body('command').isString().notEmpty().isLength({ max: 1000 }),
  body('deviceIds').isArray({ min: 1, max: 200 }),
  body('deviceIds.*').isUUID(),
  body('cronExpr').isString().custom(v => {
    if (!cron.validate(v)) throw new Error('Invalid cron expression');
    return true;
  }),
  body('timeoutSec').optional().isInt({ min: 5, max: 3600 }),
  body('enabled').optional().isBoolean(),
];

function rowToDto(r) {
  return {
    id: r.id, name: r.name, command: r.command,
    deviceIds: JSON.parse(r.device_ids || '[]'),
    cronExpr: r.cron_expr, timeoutSec: r.timeout_sec, enabled: !!r.enabled,
    createdBy: r.created_by, createdByUsername: r.created_by_username, createdAt: r.created_at,
    lastRun: r.last_run, lastStatus: r.last_status, lastError: r.last_error, lastRunId: r.last_run_id,
    consecutiveFailures: r.consecutive_failures,
  };
}

// GET /api/bulk-command-schedules
router.get('/', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM bulk_command_schedules WHERE org_id = ? ORDER BY created_at DESC', [req.orgId]);
    res.json(rows.map(rowToDto));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bulk-command-schedules
router.post('/', scheduleValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, command, deviceIds, cronExpr, timeoutSec, enabled } = req.body;
  const { valid, invalid } = await verifyDeviceAccess([...new Set(deviceIds)], req.orgId);
  if (!valid.length) return res.status(400).json({ error: 'None of the selected devices belong to this org', invalid });

  const id = uuidv4();
  await execute(
    `INSERT INTO bulk_command_schedules
       (id, org_id, name, command, device_ids, cron_expr, timeout_sec, enabled, created_by, created_by_username, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, req.orgId, name, command, JSON.stringify(valid), cronExpr, timeoutSec || 30,
     enabled === false ? 0 : 1, req.user.id, req.user.username, Math.floor(Date.now() / 1000)]
  );

  const row = await queryOne('SELECT * FROM bulk_command_schedules WHERE id = ?', [id]);
  scheduler.registerSchedule(row);
  res.status(201).json({ ...rowToDto(row), skippedDevices: invalid });
});

// PUT /api/bulk-command-schedules/:id
router.put('/:id', param('id').isUUID(), scheduleValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const existing = await queryOne('SELECT * FROM bulk_command_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  const { name, command, deviceIds, cronExpr, timeoutSec, enabled } = req.body;
  const { valid, invalid } = await verifyDeviceAccess([...new Set(deviceIds)], req.orgId);
  if (!valid.length) return res.status(400).json({ error: 'None of the selected devices belong to this org', invalid });

  await execute(
    `UPDATE bulk_command_schedules
        SET name = ?, command = ?, device_ids = ?, cron_expr = ?, timeout_sec = ?, enabled = ?
      WHERE id = ?`,
    [name, command, JSON.stringify(valid), cronExpr, timeoutSec || 30, enabled === false ? 0 : 1, req.params.id]
  );

  const row = await queryOne('SELECT * FROM bulk_command_schedules WHERE id = ?', [req.params.id]);
  scheduler.registerSchedule(row); // re-registers with the new cron/enabled state
  res.json({ ...rowToDto(row), skippedDevices: invalid });
});

// POST /api/bulk-command-schedules/:id/toggle — quick enable/disable without resending the full form
router.post('/:id/toggle', param('id').isUUID(), body('enabled').isBoolean(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const existing = await queryOne('SELECT * FROM bulk_command_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  await execute('UPDATE bulk_command_schedules SET enabled = ? WHERE id = ?', [req.body.enabled ? 1 : 0, req.params.id]);
  const row = await queryOne('SELECT * FROM bulk_command_schedules WHERE id = ?', [req.params.id]);
  scheduler.registerSchedule(row);
  res.json(rowToDto(row));
});

// POST /api/bulk-command-schedules/:id/run-now — fire immediately, outside
// the cron cadence, without disturbing last_run/consecutive_failures
// bookkeeping semantics (runSchedule() still updates those the same way a
// real cron firing would — this is "run it now" not "simulate", the row
// state should reflect reality either way).
router.post('/:id/run-now', param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const row = await queryOne('SELECT * FROM bulk_command_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!row) return res.status(404).json({ error: 'Schedule not found' });

  // Runs in the background; poll GET /:id for last_run/last_status/last_run_id,
  // or open the bulk command console at that run id, same as any other run.
  scheduler.runSchedule(row).catch(e => console.error(`[BulkCommandSchedules] Manual run failed for "${row.name}":`, e.message));
  res.status(202).json({ ok: true, message: 'Run started — check last_run_id shortly for the run id to watch' });
});

// DELETE /api/bulk-command-schedules/:id
router.delete('/:id', param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const result = await execute('DELETE FROM bulk_command_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Schedule not found' });
  scheduler.unregisterSchedule(req.params.id);
  res.json({ ok: true });
});

module.exports = router;