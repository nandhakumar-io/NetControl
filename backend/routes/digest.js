// routes/digest.js — CRUD + control endpoints for scheduled digest reports.
// Admin only, same as routes/security.js (webhook config) — this configures
// where operational summaries get sent, same sensitivity class.
'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit = require('../services/audit');
const digestService = require('../services/digestService');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const cronValidator = body('cronExpr').custom((v) => {
  if (!cron.validate(v)) throw new Error('Invalid cron expression');
  return true;
});

// GET /api/digest — list schedules
router.get('/', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM digest_schedules ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/digest/log — history of generated digests
router.get('/log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const rows = await query(
      `SELECT id, schedule_id, schedule_name, period_start, period_end,
              webhook_sent, email_sent, email_error, generated_at
       FROM digest_log ORDER BY generated_at DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/digest/log/:id — full stored digest (summary JSON)
router.get('/log/:id', param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const row = await queryOne('SELECT * FROM digest_log WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ...row, summary: JSON.parse(row.summary) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/digest/preview — build (but don't save/send) a digest for the
// requested window, so an admin can see what a schedule would produce
// before turning it on.
router.get('/preview', async (req, res) => {
  try {
    const periodDays = Math.min(Math.max(parseInt(req.query.periodDays) || 7, 1), 90);
    const digestData = await digestService.buildDigest(periodDays);
    res.json({ digest: digestData, text: digestService.renderText(digestData) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const scheduleValidation = [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  cronValidator,
  body('periodDays').optional().isInt({ min: 1, max: 90 }),
  body('emailRecipients').optional({ nullable: true }).isString(),
  body('enabled').optional().isBoolean(),
];

// POST /api/digest — create a schedule
router.post('/', scheduleValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, cronExpr, periodDays = 7, emailRecipients, enabled = true } = req.body;
  const id = uuidv4();
  try {
    await execute(
      `INSERT INTO digest_schedules (id, name, cron_expr, enabled, period_days, email_recipients, created_by, created_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, cronExpr, enabled ? 1 : 0, periodDays, emailRecipients || null, req.user.id, req.user.username, Math.floor(Date.now() / 1000)]
    );
    const row = await queryOne('SELECT * FROM digest_schedules WHERE id = ?', [id]);
    digestService.registerSchedule(row);

    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'digest_schedule_create',
      targetType: 'digest_schedule', targetId: id, targetName: name, ipSource: req.ip, result: 'success',
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/digest/:id — update a schedule
router.put('/:id', param('id').isUUID(), scheduleValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, cronExpr, periodDays = 7, emailRecipients, enabled = true } = req.body;
  try {
    const existing = await queryOne('SELECT id FROM digest_schedules WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    await execute(
      `UPDATE digest_schedules SET name = ?, cron_expr = ?, enabled = ?, period_days = ?, email_recipients = ? WHERE id = ?`,
      [name, cronExpr, enabled ? 1 : 0, periodDays, emailRecipients || null, req.params.id]
    );
    const row = await queryOne('SELECT * FROM digest_schedules WHERE id = ?', [req.params.id]);
    digestService.registerSchedule(row);

    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'digest_schedule_update',
      targetType: 'digest_schedule', targetId: req.params.id, targetName: name, ipSource: req.ip, result: 'success',
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/digest/:id/toggle
router.patch('/:id/toggle', param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const row = await queryOne('SELECT * FROM digest_schedules WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    const enabled = row.enabled ? 0 : 1;
    await execute('UPDATE digest_schedules SET enabled = ? WHERE id = ?', [enabled, req.params.id]);
    const updated = await queryOne('SELECT * FROM digest_schedules WHERE id = ?', [req.params.id]);
    digestService.registerSchedule(updated);

    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'digest_schedule_toggle',
      targetType: 'digest_schedule', targetId: req.params.id, targetName: row.name, ipSource: req.ip, result: 'success',
      details: enabled ? 'enabled' : 'disabled',
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/digest/:id/run-now — trigger a schedule immediately, out of band
router.post('/:id/run-now', param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const row = await queryOne('SELECT * FROM digest_schedules WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    const result = await digestService.runDigest(row);
    res.json({ ok: true, logId: result.logId, webhooksSent: result.webhookResults.length, emailSent: result.emailResult.sent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/digest/:id
router.delete('/:id', param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const row = await queryOne('SELECT * FROM digest_schedules WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    digestService.unregisterSchedule(req.params.id);
    await execute('DELETE FROM digest_schedules WHERE id = ?', [req.params.id]);

    await audit.log({
      userId: req.user.id, username: req.user.username, action: 'digest_schedule_delete',
      targetType: 'digest_schedule', targetId: req.params.id, targetName: row.name, ipSource: req.ip, result: 'success',
    });
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;