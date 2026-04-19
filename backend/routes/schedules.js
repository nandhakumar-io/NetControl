// routes/schedules.js
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const { query, queryOne, execute } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { registerSchedule, unregisterSchedule } = require('../services/scheduler');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/schedules
router.get('/', async (req, res) => {
  try {
    let schedules;

    if (req.user.role === 'admin') {
      // Admins see all schedules
      schedules = await query(`
        SELECT s.*,
          s.cron_expr AS cron_expression,
          CASE s.target_type
            WHEN 'device' THEN (SELECT name FROM devices WHERE id = s.target_id)
            WHEN 'group'  THEN (SELECT name FROM \`groups\` WHERE id = s.target_id)
          END as target_name
        FROM schedules s
        ORDER BY s.created_at DESC
      `);
    } else {
      // Operators/viewers see:
      //   1. Schedules they created themselves
      //   2. Schedules targeting a group they have been granted access to
      //   3. Schedules targeting a device that belongs to one of their accessible groups
      schedules = await query(`
        SELECT DISTINCT s.*,
          s.cron_expr AS cron_expression,
          CASE s.target_type
            WHEN 'device' THEN (SELECT name FROM devices WHERE id = s.target_id)
            WHEN 'group'  THEN (SELECT name FROM \`groups\` WHERE id = s.target_id)
          END as target_name
        FROM schedules s
        WHERE
          -- own schedules
          s.created_by = ?
          OR
          -- schedules targeting a group the user has access to
          (s.target_type = 'group' AND s.target_id IN (
            SELECT group_id FROM user_group_access WHERE user_id = ?
          ))
          OR
          -- schedules targeting a device in one of the user's accessible groups
          (s.target_type = 'device' AND s.target_id IN (
            SELECT d.id FROM devices d
            INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ?
          ))
        ORDER BY s.created_at DESC
      `, [req.user.id, req.user.id, req.user.id]);
    }

    res.json(schedules);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const scheduleValidation = [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('action').isIn(['wake', 'shutdown', 'restart']),
  body('cron_expression').custom((v) => {
    if (!cron.validate(v)) throw new Error('Invalid cron expression');
    return true;
  }),
  body('target_type').isIn(['device', 'group']),
  body('target_id').isUUID(),
  body('enabled').optional().isBoolean(),
];

// POST /api/schedules
router.post('/', scheduleValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const id = uuidv4();
    const { name, action, cron_expression, target_type, target_id, enabled = true } = req.body;
    await execute(
      'INSERT INTO schedules (id, name, action, cron_expr, target_type, target_id, enabled, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, action, cron_expression, target_type, target_id, enabled ? 1 : 0, req.user.id]
    );
    const schedule = await queryOne('SELECT * FROM schedules WHERE id = ?', [id]);
    registerSchedule(schedule);
    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'add_schedule', targetId: id, targetName: name, ipSource: req.realIp, result: 'success' });
    res.status(201).json(schedule);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/schedules/:id
router.put('/:id', param('id').isUUID(), scheduleValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const existing = await queryOne('SELECT * FROM schedules WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });
    if (req.user.role !== 'admin' && existing.created_by !== req.user.id)
      return res.status(403).json({ error: 'You can only edit your own schedules' });
    const { name, action, cron_expression, target_type, target_id, enabled = true } = req.body;
    await execute(
      'UPDATE schedules SET name=?, action=?, cron_expr=?, target_type=?, target_id=?, enabled=? WHERE id=?',
      [name, action, cron_expression, target_type, target_id, enabled ? 1 : 0, req.params.id]
    );
    const schedule = await queryOne('SELECT * FROM schedules WHERE id = ?', [req.params.id]);
    registerSchedule(schedule);
    res.json(schedule);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/schedules/:id/toggle
router.patch('/:id/toggle', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const s = await queryOne('SELECT * FROM schedules WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Schedule not found' });
    if (req.user.role !== 'admin' && s.created_by !== req.user.id)
      return res.status(403).json({ error: 'You can only toggle your own schedules' });
    await execute('UPDATE schedules SET enabled = ? WHERE id = ?', [s.enabled ? 0 : 1, req.params.id]);
    const updated = await queryOne('SELECT * FROM schedules WHERE id = ?', [req.params.id]);
    registerSchedule(updated);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/schedules/:id
router.delete('/:id', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const owned = await queryOne('SELECT created_by FROM schedules WHERE id = ?', [req.params.id]);
    if (!owned) return res.status(404).json({ error: 'Schedule not found' });
    if (req.user.role !== 'admin' && owned.created_by !== req.user.id)
      return res.status(403).json({ error: 'You can only delete your own schedules' });
    const s = await queryOne('SELECT * FROM schedules WHERE id = ?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Schedule not found' });
    unregisterSchedule(req.params.id);
    await execute('DELETE FROM schedules WHERE id = ?', [req.params.id]);
    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'delete_schedule', targetId: req.params.id, targetName: s.name,
      ipSource: req.realIp, result: 'success' });
    res.json({ message: 'Schedule deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
