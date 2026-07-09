// routes/slaReportSchedules.js — CRUD + control for automatic SLA report
// generation. Org-scoped like routes/slaReports.js itself; gated behind the
// same VIEW_SLA_REPORTS permission bit for read/generate-adjacent actions,
// but schedule creation/editing requires an org admin (org_role), same
// tightening middleware/tenant.js's requireOrgRole applies to org-level
// config elsewhere (invites, org settings) — a schedule silently emailing a
// client every month is exactly the kind of standing configuration that
// shouldn't be left to a lower-privileged viewer/operator to set up.
'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { requireOrgContext, requireOrgRole } = require('../middleware/tenant');
const scheduledJobs = require('../services/scheduledJobs');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

const VIEW_SLA_REPORTS = 16384;
const SCOPES = ['org', 'group', 'device'];
const PERIOD_MODES = ['previous_calendar_month', 'trailing_days'];

function validate(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return true; }
  return false;
}

// GET /api/sla-report-schedules — list schedules for the active org
router.get('/', requirePermission(VIEW_SLA_REPORTS), async (req, res) => {
  try {
    const rows = await query('SELECT * FROM sla_report_schedules WHERE org_id = ? ORDER BY created_at DESC', [req.orgId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const scheduleValidation = [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('cronExpr').custom(v => { if (!cron.validate(v)) throw new Error('Invalid cron expression'); return true; }),
  body('scope').isIn(SCOPES),
  body('scopeId').if(body('scope').isIn(['group', 'device'])).isUUID().withMessage('scopeId is required for group/device scope'),
  body('periodMode').isIn(PERIOD_MODES),
  body('periodDays').optional().isInt({ min: 1, max: 366 }),
  body('emailRecipients').optional({ nullable: true }).isString(),
  body('enabled').optional().isBoolean(),
];

// POST /api/sla-report-schedules — create (org admin only — see header note)
router.post('/', requireOrgRole('admin'), scheduleValidation, async (req, res) => {
  if (validate(req, res)) return;
  const { name, cronExpr, scope, scopeId, periodMode, periodDays, emailRecipients, enabled = true } = req.body;
  const id = uuidv4();
  try {
    await execute(
      `INSERT INTO sla_report_schedules
         (id, org_id, name, cron_expr, enabled, scope_type, scope_id, period_mode, period_days,
          email_recipients, created_by, created_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.orgId, name, cronExpr, enabled ? 1 : 0, scope, scopeId || null, periodMode,
       periodMode === 'trailing_days' ? (periodDays || 30) : null,
       emailRecipients || null, req.user.id, req.user.username, Math.floor(Date.now() / 1000)]
    );
    const row = await queryOne('SELECT * FROM sla_report_schedules WHERE id = ?', [id]);
    scheduledJobs.registerSlaReportSchedule(row);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'sla_report_schedule_create', targetType: 'sla_report_schedule', targetId: id,
      targetName: name, result: 'success',
    });
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/sla-report-schedules/:id — update
router.put('/:id', requireOrgRole('admin'), param('id').isUUID(), scheduleValidation, async (req, res) => {
  if (validate(req, res)) return;
  const { name, cronExpr, scope, scopeId, periodMode, periodDays, emailRecipients, enabled = true } = req.body;
  try {
    const existing = await queryOne('SELECT id FROM sla_report_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    await execute(
      `UPDATE sla_report_schedules SET name = ?, cron_expr = ?, enabled = ?, scope_type = ?, scope_id = ?,
              period_mode = ?, period_days = ?, email_recipients = ? WHERE id = ?`,
      [name, cronExpr, enabled ? 1 : 0, scope, scopeId || null, periodMode,
       periodMode === 'trailing_days' ? (periodDays || 30) : null,
       emailRecipients || null, req.params.id]
    );
    const row = await queryOne('SELECT * FROM sla_report_schedules WHERE id = ?', [req.params.id]);
    scheduledJobs.registerSlaReportSchedule(row);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'sla_report_schedule_update', targetType: 'sla_report_schedule', targetId: req.params.id,
      targetName: name, result: 'success',
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/sla-report-schedules/:id/toggle
router.patch('/:id/toggle', requireOrgRole('admin'), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM sla_report_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    const enabled = row.enabled ? 0 : 1;
    await execute('UPDATE sla_report_schedules SET enabled = ? WHERE id = ?', [enabled, req.params.id]);
    const updated = await queryOne('SELECT * FROM sla_report_schedules WHERE id = ?', [req.params.id]);
    scheduledJobs.registerSlaReportSchedule(updated);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'sla_report_schedule_toggle', targetType: 'sla_report_schedule', targetId: req.params.id,
      targetName: row.name, result: 'success', details: enabled ? 'enabled' : 'disabled',
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sla-report-schedules/:id/run-now — trigger immediately, out of band
router.post('/:id/run-now', requirePermission(VIEW_SLA_REPORTS), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM sla_report_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    await scheduledJobs.runSlaReportSchedule(row);
    const updated = await queryOne('SELECT * FROM sla_report_schedules WHERE id = ?', [req.params.id]);
    res.json({ ok: updated.last_status === 'success', ...updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/sla-report-schedules/:id
router.delete('/:id', requireOrgRole('admin'), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM sla_report_schedules WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    scheduledJobs.unregisterSlaReportSchedule(req.params.id);
    await execute('DELETE FROM sla_report_schedules WHERE id = ?', [req.params.id]);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'sla_report_schedule_delete', targetType: 'sla_report_schedule', targetId: req.params.id,
      targetName: row.name, result: 'success',
    });
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;