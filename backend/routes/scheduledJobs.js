// routes/scheduledJobs.js — CRUD + control endpoints for scheduled backups
// and scheduled log exports.
//
// The cron engine itself (register/unregister/run, load-on-boot) lives in
// services/scheduledJobs.js, mirroring how routes/schedules.js is the thin
// HTTP layer over services/scheduler.js. This file only touches the DB and
// tells the service to (re)register/unregister/run a job — same split used
// everywhere else in this app.
'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole, requirePermission, requireActionPin } = require('../middleware/auth');
const audit = require('../services/audit');
const scheduledJobs = require('../services/scheduledJobs');

const FORMATS = ['zip', 'tar', 'tar.gz'];
const LOG_FORMATS = ['csv', 'txt'];

// Backup schedules gate on the same permission bit as routes/backup.js
// (8192), since a schedule is just an unattended way of doing the same
// thing a one-off POST /api/backup does — so create/edit/toggle/run only
// need the permission bit + action PIN, same as a one-off run. Only
// deleting a schedule is admin-only, mirroring DELETE /api/backup/:id.
const requireBackupPermission = requirePermission(8192);

const cronValidator = body('cronExpr').custom((v) => {
  if (!cron.validate(v)) throw new Error('Invalid cron expression');
  return true;
});

// ── /api/backup-schedules ───────────────────────────────────────────────────
const backupSchedulesRouter = express.Router();
backupSchedulesRouter.use(requireAuth);
backupSchedulesRouter.use(requireBackupPermission);

// GET /api/backup-schedules
backupSchedulesRouter.get('/', async (req, res) => {
  try {
    const rows = await query(
      `SELECT bs.*, d.name AS source_device_name
       FROM backup_schedules bs
       LEFT JOIN devices d ON d.id = bs.source_device_id
       ORDER BY bs.created_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const backupScheduleValidation = [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  cronValidator,
  body('sourcePath').notEmpty().isString().isLength({ max: 1000 }),
  body('sourceDeviceId').optional({ nullable: true }).isString(),
  body('mount').optional({ nullable: true }).isString(),
  body('format').isIn(FORMATS).withMessage(`format must be one of: ${FORMATS.join(', ')}`),
  body('label').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('destinationId').optional({ nullable: true }).isUUID(),
  body('enabled').optional().isBoolean(),
  body('actionPin').notEmpty().isString(),
];

// POST /api/backup-schedules
backupSchedulesRouter.post(
  '/', backupScheduleValidation, requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      name, cronExpr, sourcePath, format, label,
      sourceDeviceId, mount, destinationId, enabled = true,
    } = req.body;

    if (sourceDeviceId && !mount) {
      return res.status(400).json({ error: 'mount is required when backing up from a device' });
    }

    try {
      if (sourceDeviceId) {
        const d = await queryOne('SELECT id FROM devices WHERE id = ?', [sourceDeviceId]);
        if (!d) return res.status(400).json({ error: 'Source device not found' });
      }
      if (destinationId) {
        const dest = await queryOne('SELECT id FROM backup_destinations WHERE id = ?', [destinationId]);
        if (!dest) return res.status(400).json({ error: 'Destination not found' });
      }

      const id = uuidv4();
      await execute(
        `INSERT INTO backup_schedules
           (id, name, cron_expr, enabled, source_device_id, mount, source_path, format, label,
            destination_id, created_by, created_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, cronExpr, enabled ? 1 : 0, sourceDeviceId || null, mount || null, sourcePath,
         format, label || null, destinationId || null, req.user.id, req.user.username,
         Math.floor(Date.now() / 1000)]
      );

      const schedule = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [id]);
      scheduledJobs.registerBackupSchedule(schedule);

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'backup_schedule_create', targetType: 'backup_schedule', targetId: id, targetName: name,
        ipSource: req.ip, result: 'success', details: `cron=${cronExpr} source=${sourcePath}`,
      });

      res.status(201).json(schedule);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// PUT /api/backup-schedules/:id
backupSchedulesRouter.put(
  '/:id', param('id').isUUID(), backupScheduleValidation, requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const existing = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Schedule not found' });

      const {
        name, cronExpr, sourcePath, format, label,
        sourceDeviceId, mount, destinationId, enabled = true,
      } = req.body;

      if (sourceDeviceId && !mount) {
        return res.status(400).json({ error: 'mount is required when backing up from a device' });
      }
      if (sourceDeviceId) {
        const d = await queryOne('SELECT id FROM devices WHERE id = ?', [sourceDeviceId]);
        if (!d) return res.status(400).json({ error: 'Source device not found' });
      }
      if (destinationId) {
        const dest = await queryOne('SELECT id FROM backup_destinations WHERE id = ?', [destinationId]);
        if (!dest) return res.status(400).json({ error: 'Destination not found' });
      }

      await execute(
        `UPDATE backup_schedules
         SET name = ?, cron_expr = ?, enabled = ?, source_device_id = ?, mount = ?,
             source_path = ?, format = ?, label = ?, destination_id = ?
         WHERE id = ?`,
        [name, cronExpr, enabled ? 1 : 0, sourceDeviceId || null, mount || null,
         sourcePath, format, label || null, destinationId || null, req.params.id]
      );

      const schedule = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [req.params.id]);
      scheduledJobs.registerBackupSchedule(schedule);

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'backup_schedule_update', targetType: 'backup_schedule', targetId: req.params.id, targetName: name,
        ipSource: req.ip, result: 'success', details: `cron=${cronExpr} source=${sourcePath}`,
      });

      res.json(schedule);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// PATCH /api/backup-schedules/:id/toggle
backupSchedulesRouter.patch('/:id/toggle', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const s = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Schedule not found' });

    await execute('UPDATE backup_schedules SET enabled = ? WHERE id = ?', [s.enabled ? 0 : 1, req.params.id]);
    const updated = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [req.params.id]);
    scheduledJobs.registerBackupSchedule(updated);

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'backup_schedule_toggle', targetType: 'backup_schedule', targetId: req.params.id, targetName: s.name,
      ipSource: req.ip, result: 'success', details: updated.enabled ? 'enabled' : 'disabled',
    });

    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/backup-schedules/:id/run — run immediately, outside its cron cadence
backupSchedulesRouter.post('/:id/run', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const s = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Schedule not found' });

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'backup_schedule_run_now', targetType: 'backup_schedule', targetId: s.id, targetName: s.name,
      ipSource: req.ip, result: 'success',
    });

    // Fire-and-forget: the run itself logs its own success/failure via
    // audit + last_run/last_status, same as a cron-triggered run. The HTTP
    // response only confirms the run was kicked off.
    scheduledJobs.runBackupSchedule(s).catch(console.error);

    res.json({ started: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/backup-schedules/:id
backupSchedulesRouter.delete(
  '/:id', requireRole('admin'), param('id').isUUID(), body('actionPin').notEmpty().isString(), requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const s = await queryOne('SELECT * FROM backup_schedules WHERE id = ?', [req.params.id]);
      if (!s) return res.status(404).json({ error: 'Schedule not found' });

      scheduledJobs.unregisterBackupSchedule(req.params.id);
      await execute('DELETE FROM backup_schedules WHERE id = ?', [req.params.id]);

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'backup_schedule_delete', targetType: 'backup_schedule', targetId: s.id, targetName: s.name,
        ipSource: req.ip, result: 'success',
      });

      res.json({ deleted: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ── /api/log-export-schedules ───────────────────────────────────────────────
const logExportSchedulesRouter = express.Router();
logExportSchedulesRouter.use(requireAuth);
logExportSchedulesRouter.use(requirePermission(128)); // matches routes/audit.js's export gate

logExportSchedulesRouter.get('/', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM log_export_schedules ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const EXPORT_TARGETS = ['file', 'syslog'];

const logExportScheduleValidation = [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  cronValidator,
  body('exportTarget').optional().isIn(EXPORT_TARGETS).withMessage(`exportTarget must be one of: ${EXPORT_TARGETS.join(', ')}`),
  // format is meaningless for a syslog target (no file is produced), so it's
  // only required when exportTarget is 'file' (the default).
  body('format').custom((value, { req }) => {
    if ((req.body.exportTarget || 'file') === 'syslog') return true;
    if (!LOG_FORMATS.includes(value)) throw new Error(`format must be one of: ${LOG_FORMATS.join(', ')}`);
    return true;
  }),
  body('filters').optional({ nullable: true }).isObject(),
  body('destinationId').optional({ nullable: true }).isUUID(),
  body('enabled').optional().isBoolean(),
  body('actionPin').notEmpty().isString(),
];

logExportSchedulesRouter.post(
  '/', logExportScheduleValidation, requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, cronExpr, filters = {}, destinationId, enabled = true } = req.body;
    const exportTarget = req.body.exportTarget || 'file';
    const format = exportTarget === 'syslog' ? 'csv' : req.body.format; // unused for syslog, kept non-null to satisfy the column
    try {
      if (exportTarget === 'file' && destinationId) {
        const dest = await queryOne('SELECT id FROM backup_destinations WHERE id = ?', [destinationId]);
        if (!dest) return res.status(400).json({ error: 'Destination not found' });
      }
      if (exportTarget === 'syslog') {
        const syslogForwarder = require('../services/syslogForwarder');
        const cfg = await syslogForwarder.getConfig();
        if (!cfg.enabled || !cfg.host) {
          return res.status(400).json({ error: 'Syslog forwarding is not configured — set it up under Audit Log → Syslog Settings first' });
        }
      }

      const id = uuidv4();
      await execute(
        `INSERT INTO log_export_schedules
           (id, name, cron_expr, enabled, format, export_target, filters, destination_id, created_by, created_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, cronExpr, enabled ? 1 : 0, format, exportTarget, JSON.stringify(filters),
         exportTarget === 'file' ? (destinationId || null) : null,
         req.user.id, req.user.username, Math.floor(Date.now() / 1000)]
      );

      const schedule = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [id]);
      scheduledJobs.registerLogExportSchedule(schedule);

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'log_export_schedule_create', targetType: 'log_export_schedule', targetId: id, targetName: name,
        ipSource: req.ip, result: 'success', details: `cron=${cronExpr} target=${exportTarget}`,
      });

      res.status(201).json(schedule);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

logExportSchedulesRouter.put(
  '/:id', param('id').isUUID(), logExportScheduleValidation, requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const existing = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Schedule not found' });

      const { name, cronExpr, filters = {}, destinationId, enabled = true } = req.body;
      const exportTarget = req.body.exportTarget || 'file';
      const format = exportTarget === 'syslog' ? 'csv' : req.body.format;

      if (exportTarget === 'file' && destinationId) {
        const dest = await queryOne('SELECT id FROM backup_destinations WHERE id = ?', [destinationId]);
        if (!dest) return res.status(400).json({ error: 'Destination not found' });
      }
      if (exportTarget === 'syslog') {
        const syslogForwarder = require('../services/syslogForwarder');
        const cfg = await syslogForwarder.getConfig();
        if (!cfg.enabled || !cfg.host) {
          return res.status(400).json({ error: 'Syslog forwarding is not configured — set it up under Audit Log → Syslog Settings first' });
        }
      }

      await execute(
        `UPDATE log_export_schedules
         SET name = ?, cron_expr = ?, enabled = ?, format = ?, export_target = ?, filters = ?, destination_id = ?
         WHERE id = ?`,
        [name, cronExpr, enabled ? 1 : 0, format, exportTarget, JSON.stringify(filters),
         exportTarget === 'file' ? (destinationId || null) : null, req.params.id]
      );

      const schedule = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [req.params.id]);
      scheduledJobs.registerLogExportSchedule(schedule);

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'log_export_schedule_update', targetType: 'log_export_schedule', targetId: req.params.id, targetName: name,
        ipSource: req.ip, result: 'success', details: `cron=${cronExpr} target=${exportTarget}`,
      });

      res.json(schedule);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

logExportSchedulesRouter.patch('/:id/toggle', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const s = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Schedule not found' });

    await execute('UPDATE log_export_schedules SET enabled = ? WHERE id = ?', [s.enabled ? 0 : 1, req.params.id]);
    const updated = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [req.params.id]);
    scheduledJobs.registerLogExportSchedule(updated);

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'log_export_schedule_toggle', targetType: 'log_export_schedule', targetId: req.params.id, targetName: s.name,
      ipSource: req.ip, result: 'success', details: updated.enabled ? 'enabled' : 'disabled',
    });

    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

logExportSchedulesRouter.post('/:id/run', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const s = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Schedule not found' });

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'log_export_schedule_run_now', targetType: 'log_export_schedule', targetId: s.id, targetName: s.name,
      ipSource: req.ip, result: 'success',
    });

    scheduledJobs.runLogExportSchedule(s).catch(console.error);
    res.json({ started: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

logExportSchedulesRouter.delete(
  '/:id', requireRole('admin'), param('id').isUUID(), body('actionPin').notEmpty().isString(), requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const s = await queryOne('SELECT * FROM log_export_schedules WHERE id = ?', [req.params.id]);
      if (!s) return res.status(404).json({ error: 'Schedule not found' });

      scheduledJobs.unregisterLogExportSchedule(req.params.id);
      await execute('DELETE FROM log_export_schedules WHERE id = ?', [req.params.id]);

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'log_export_schedule_delete', targetType: 'log_export_schedule', targetId: s.id, targetName: s.name,
        ipSource: req.ip, result: 'success',
      });

      res.json({ deleted: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

module.exports = { backupSchedulesRouter, logExportSchedulesRouter };