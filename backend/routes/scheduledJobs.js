// routes/scheduledJobs.js — CRUD + control for scheduled backups
// (backupSchedulesRouter, mounted at /api/backup-schedules) and scheduled
// log/audit exports (logExportSchedulesRouter, mounted at
// /api/log-export-schedules).
//
// server.js does:
//   const { backupSchedulesRouter, logExportSchedulesRouter } = require('./routes/scheduledJobs');
//
// The actual cron engine (register/unregister/run — load-on-boot,
// node-cron, one process only) lives in services/scheduledJobs.js and is
// reused here; this file is only the HTTP surface a signed-in operator
// talks to (list/create/edit/toggle/run-now/delete), same split as
// routes/slaReportSchedules.js + services/scheduledJobs.js's SLA half.
//
// Gating mirrors routes/backup.js (view gated by the backup permission
// bit, mutations admin-only) and routes/audit.js (view gated by the audit
// permission bit) respectively. Create/update/delete require an action PIN
// — ScheduleBackupModal.jsx and ScheduleLogExportModal.jsx both collect one
// and refuse to submit without it, matching how routes/backup.js treats
// saved destinations (standing config that writes/reads data unattended
// on a timer, same trust bar as adding an S3/remote-folder destination).
'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole, requirePermission, requireActionPin } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const scheduledJobs = require('../services/scheduledJobs');
const audit = require('../services/audit');

const VIEW_BACKUPS = 8192; // matches routes/backup.js's own gate
const VIEW_AUDIT_LOG = 128; // matches routes/audit.js's own gate

const BACKUP_FORMATS = ['zip', 'tar', 'tar.gz'];
const LOG_EXPORT_FORMATS = ['csv', 'txt'];
const LOG_EXPORT_TARGETS = ['file', 'syslog'];

function validate(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return true; }
  return false;
}

// ── Backup schedules ─────────────────────────────────────────────────────────
const backupSchedulesRouter = express.Router();
backupSchedulesRouter.use(requireAuth, requireOrgContext, requirePermission(VIEW_BACKUPS));

// GET /api/backup-schedules
backupSchedulesRouter.get('/', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM backup_schedules WHERE org_id = ? ORDER BY created_at DESC', [req.orgId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const backupScheduleValidation = [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('cronExpr').custom(v => { if (!cron.validate(v)) throw new Error('Invalid cron expression'); return true; }),
  body('sourcePath').trim().notEmpty().isLength({ max: 1000 }),
  body('sourceDeviceId').optional({ nullable: true }).isString(),
  body('mount').optional({ nullable: true }).isString(),
  body('format').isIn(BACKUP_FORMATS).withMessage(`format must be one of: ${BACKUP_FORMATS.join(', ')}`),
  body('label').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('destinationId').optional({ nullable: true }).isUUID(),
  body('enabled').optional().isBoolean(),
  body('actionPin').notEmpty().isString(),
];

// POST /api/backup-schedules — create (admin + action PIN)
backupSchedulesRouter.post('/', requireRole('admin'), backupScheduleValidation, requireActionPin, async (req, res) => {
  if (validate(req, res)) return;
  const { name, cronExpr, sourcePath, sourceDeviceId, mount, format, label, destinationId, enabled = true } = req.body;
  const isRemoteSource = !!sourceDeviceId;

  try {
    if (isRemoteSource) {
      if (!mount) return res.status(400).json({ error: 'mount is required when the source is a device' });
      const d = await queryOne('SELECT id FROM devices WHERE id = ? AND org_id = ?', [sourceDeviceId, req.orgId]);
      if (!d) return res.status(400).json({ error: 'Source device not found' });
    }
    if (destinationId) {
      const dest = await queryOne('SELECT id FROM backup_destinations WHERE id = ? AND org_id = ?', [destinationId, req.orgId]);
      if (!dest) return res.status(400).json({ error: 'Destination not found' });
    }

    const id = uuidv4();
    await execute(
      `INSERT INTO backup_schedules
         (id, name, cron_expr, enabled, source_device_id, mount, source_path, format, label,
          destination_id, created_by, created_by_name, created_at, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, cronExpr, enabled ? 1 : 0, isRemoteSource ? sourceDeviceId : null, isRemoteSource ? mount : null,
       sourcePath, format, label || null, destinationId || null, req.user.id, req.user.username,
       Math.floor(Date.now() / 1000), req.orgId]
    );

    const row = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [id]);
    scheduledJobs.registerBackupSchedule(row);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'backup_schedule_create', targetType: 'backup_schedule', targetId: id,
      targetName: name, result: 'success',
    });
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/backup-schedules/:id — update (admin + action PIN)
backupSchedulesRouter.put('/:id', requireRole('admin'), param('id').isUUID(), backupScheduleValidation, requireActionPin, async (req, res) => {
  if (validate(req, res)) return;
  const { name, cronExpr, sourcePath, sourceDeviceId, mount, format, label, destinationId, enabled = true } = req.body;
  const isRemoteSource = !!sourceDeviceId;

  try {
    const existing = await queryOne('SELECT id FROM backup_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    if (isRemoteSource) {
      if (!mount) return res.status(400).json({ error: 'mount is required when the source is a device' });
      const d = await queryOne('SELECT id FROM devices WHERE id = ? AND org_id = ?', [sourceDeviceId, req.orgId]);
      if (!d) return res.status(400).json({ error: 'Source device not found' });
    }
    if (destinationId) {
      const dest = await queryOne('SELECT id FROM backup_destinations WHERE id = ? AND org_id = ?', [destinationId, req.orgId]);
      if (!dest) return res.status(400).json({ error: 'Destination not found' });
    }

    await execute(
      `UPDATE backup_schedules SET name = ?, cron_expr = ?, enabled = ?, source_device_id = ?, mount = ?,
              source_path = ?, format = ?, label = ?, destination_id = ? WHERE id = ?`,
      [name, cronExpr, enabled ? 1 : 0, isRemoteSource ? sourceDeviceId : null, isRemoteSource ? mount : null,
       sourcePath, format, label || null, destinationId || null, req.params.id]
    );

    const row = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [req.params.id]);
    scheduledJobs.registerBackupSchedule(row);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'backup_schedule_update', targetType: 'backup_schedule', targetId: req.params.id,
      targetName: name, result: 'success',
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/backup-schedules/:id/toggle — admin only, no PIN (mirrors
// routes/backup.js's destination delete: a quick enable/disable flip, not
// a new/changed config commitment).
backupSchedulesRouter.patch('/:id/toggle', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM backup_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    const enabled = row.enabled ? 0 : 1;
    await execute('UPDATE backup_schedules SET enabled = ? WHERE id = ?', [enabled, req.params.id]);
    const updated = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [req.params.id]);
    scheduledJobs.registerBackupSchedule(updated);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'backup_schedule_toggle', targetType: 'backup_schedule', targetId: req.params.id,
      targetName: row.name, result: 'success', details: enabled ? 'enabled' : 'disabled',
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/backup-schedules/:id/run — trigger immediately, out of band
backupSchedulesRouter.post('/:id/run', param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM backup_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    await scheduledJobs.runBackupSchedule(row);
    const updated = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [req.params.id]);
    res.json({ ok: updated.last_status === 'success', ...updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/backup-schedules/:id — admin + action PIN
backupSchedulesRouter.delete('/:id', requireRole('admin'), param('id').isUUID(), body('actionPin').notEmpty().isString(), requireActionPin, async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM backup_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    scheduledJobs.unregisterBackupSchedule(req.params.id);
    await execute('DELETE FROM backup_schedules WHERE id = ?', [req.params.id]);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'backup_schedule_delete', targetType: 'backup_schedule', targetId: req.params.id,
      targetName: row.name, result: 'success',
    });
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Log (audit) export schedules ─────────────────────────────────────────────
const logExportSchedulesRouter = express.Router();
logExportSchedulesRouter.use(requireAuth, requireOrgContext, requirePermission(VIEW_AUDIT_LOG));

// GET /api/log-export-schedules
logExportSchedulesRouter.get('/', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM log_export_schedules WHERE org_id = ? ORDER BY created_at DESC', [req.orgId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const logExportScheduleValidation = [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('cronExpr').custom(v => { if (!cron.validate(v)) throw new Error('Invalid cron expression'); return true; }),
  body('exportTarget').isIn(LOG_EXPORT_TARGETS),
  body('format').isIn(LOG_EXPORT_FORMATS).withMessage(`format must be one of: ${LOG_EXPORT_FORMATS.join(', ')}`),
  body('filters').optional().isObject(),
  body('destinationId').optional({ nullable: true }).isUUID(),
  body('enabled').optional().isBoolean(),
  body('actionPin').notEmpty().isString(),
];

// POST /api/log-export-schedules — create (admin + action PIN)
logExportSchedulesRouter.post('/', requireRole('admin'), logExportScheduleValidation, requireActionPin, async (req, res) => {
  if (validate(req, res)) return;
  const { name, cronExpr, exportTarget, format, filters = {}, destinationId, enabled = true } = req.body;

  try {
    if (exportTarget === 'file' && destinationId) {
      const dest = await queryOne('SELECT id FROM backup_destinations WHERE id = ? AND org_id = ?', [destinationId, req.orgId]);
      if (!dest) return res.status(400).json({ error: 'Destination not found' });
    }

    const id = uuidv4();
    await execute(
      `INSERT INTO log_export_schedules
         (id, name, cron_expr, enabled, format, filters, destination_id, export_target,
          created_by, created_by_name, created_at, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, cronExpr, enabled ? 1 : 0, format, JSON.stringify(filters || {}),
       exportTarget === 'file' ? (destinationId || null) : null, exportTarget,
       req.user.id, req.user.username, Math.floor(Date.now() / 1000), req.orgId]
    );

    const row = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [id]);
    scheduledJobs.registerLogExportSchedule(row);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'log_export_schedule_create', targetType: 'log_export_schedule', targetId: id,
      targetName: name, result: 'success',
    });
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/log-export-schedules/:id — update (admin + action PIN)
logExportSchedulesRouter.put('/:id', requireRole('admin'), param('id').isUUID(), logExportScheduleValidation, requireActionPin, async (req, res) => {
  if (validate(req, res)) return;
  const { name, cronExpr, exportTarget, format, filters = {}, destinationId, enabled = true } = req.body;

  try {
    const existing = await queryOne('SELECT id FROM log_export_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    if (exportTarget === 'file' && destinationId) {
      const dest = await queryOne('SELECT id FROM backup_destinations WHERE id = ? AND org_id = ?', [destinationId, req.orgId]);
      if (!dest) return res.status(400).json({ error: 'Destination not found' });
    }

    await execute(
      `UPDATE log_export_schedules SET name = ?, cron_expr = ?, enabled = ?, format = ?, filters = ?,
              destination_id = ?, export_target = ? WHERE id = ?`,
      [name, cronExpr, enabled ? 1 : 0, format, JSON.stringify(filters || {}),
       exportTarget === 'file' ? (destinationId || null) : null, exportTarget, req.params.id]
    );

    const row = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [req.params.id]);
    scheduledJobs.registerLogExportSchedule(row);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'log_export_schedule_update', targetType: 'log_export_schedule', targetId: req.params.id,
      targetName: name, result: 'success',
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/log-export-schedules/:id/toggle — admin only, no PIN
logExportSchedulesRouter.patch('/:id/toggle', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM log_export_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    const enabled = row.enabled ? 0 : 1;
    await execute('UPDATE log_export_schedules SET enabled = ? WHERE id = ?', [enabled, req.params.id]);
    const updated = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [req.params.id]);
    scheduledJobs.registerLogExportSchedule(updated);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'log_export_schedule_toggle', targetType: 'log_export_schedule', targetId: req.params.id,
      targetName: row.name, result: 'success', details: enabled ? 'enabled' : 'disabled',
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/log-export-schedules/:id/run — trigger immediately, out of band
logExportSchedulesRouter.post('/:id/run', param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM log_export_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    await scheduledJobs.runLogExportSchedule(row);
    const updated = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [req.params.id]);
    res.json({ ok: updated.last_status === 'success', ...updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/log-export-schedules/:id — admin + action PIN
logExportSchedulesRouter.delete('/:id', requireRole('admin'), param('id').isUUID(), body('actionPin').notEmpty().isString(), requireActionPin, async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM log_export_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    scheduledJobs.unregisterLogExportSchedule(req.params.id);
    await execute('DELETE FROM log_export_schedules WHERE id = ?', [req.params.id]);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'log_export_schedule_delete', targetType: 'log_export_schedule', targetId: req.params.id,
      targetName: row.name, result: 'success',
    });
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { backupSchedulesRouter, logExportSchedulesRouter };