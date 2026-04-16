// routes/groups.js
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/groups
router.get('/', async (req, res) => {
  try {
    const groups = await query(
      'SELECT g.*, COUNT(d.id) as device_count FROM `groups` g LEFT JOIN devices d ON d.group_id = g.id GROUP BY g.id ORDER BY g.name'
    );
    res.json(groups);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/groups/:id/devices
router.get('/:id/devices', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const devices = await query(
      'SELECT id, name, ip_address, mac_address, os_type, group_id, status, last_seen, created_at FROM devices WHERE group_id = ? ORDER BY name',
      [req.params.id]
    );
    res.json(devices);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/groups
router.post('/',
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 500 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const id = uuidv4();
      const { name, description } = req.body;
      await execute('INSERT INTO `groups` (id, name, description) VALUES (?, ?, ?)',
        [id, name, description || null]);
      await audit.log({ userId: req.user.id, username: req.user.username,
        action: 'add_group', targetType: 'group', targetId: id,
        targetName: name, ipSource: req.ip, result: 'success' });
      res.status(201).json(await queryOne('SELECT * FROM `groups` WHERE id = ?', [id]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Group name already exists' });
      res.status(500).json({ error: e.message });
    }
  }
);

// PUT /api/groups/:id
router.put('/:id',
  param('id').isUUID(),
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 500 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      if (!await queryOne('SELECT id FROM `groups` WHERE id = ?', [req.params.id]))
        return res.status(404).json({ error: 'Group not found' });
      const { name, description } = req.body;
      await execute('UPDATE `groups` SET name = ?, description = ? WHERE id = ?',
        [name, description || null, req.params.id]);
      res.json(await queryOne('SELECT * FROM `groups` WHERE id = ?', [req.params.id]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// DELETE /api/groups/:id
router.delete('/:id', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const group = await queryOne('SELECT * FROM `groups` WHERE id = ?', [req.params.id]);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await execute('DELETE FROM `groups` WHERE id = ?', [req.params.id]);
    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'delete_group', targetType: 'group', targetId: req.params.id,
      targetName: group.name, ipSource: req.ip, result: 'success' });
    res.json({ message: 'Group deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

