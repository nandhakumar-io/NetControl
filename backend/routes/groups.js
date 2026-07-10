// routes/groups.js
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

// SECURITY FIX: POST/PUT/DELETE below previously had no role/permission
// check beyond requireAuth, so any authenticated user — including viewers —
// could create, rename, or delete groups. manage_groups (bit 16) restricts
// this to admins (custom roles with the bit set also pass).
const requireManageGroups = requirePermission(16);

// GET /api/groups
router.get('/', async (req, res) => {
  try {
    let groups;
    if (req.user.role !== 'admin') {
      // Operators only see groups they have been explicitly granted access to
      groups = await query(
        'SELECT g.*, COUNT(d.id) as device_count ' +
        'FROM `groups` g ' +
        'INNER JOIN user_group_access uga ON uga.group_id = g.id AND uga.user_id = ? ' +
        'LEFT JOIN devices d ON d.group_id = g.id ' +
        'WHERE g.org_id = ? ' +
        'GROUP BY g.id ORDER BY g.name',
        [req.user.id, req.orgId]
      );
    } else {
      groups = await query(
        'SELECT g.*, COUNT(d.id) as device_count FROM `groups` g LEFT JOIN devices d ON d.group_id = g.id WHERE g.org_id = ? GROUP BY g.id ORDER BY g.name',
        [req.orgId]
      );
    }
    res.json(groups);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/groups/:id/devices
router.get('/:id/devices', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    // Operators must have access to this group
    if (req.user.role !== 'admin') {
      const access = await queryOne(
        'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
        [req.user.id, req.params.id]
      );
      if (!access) return res.status(403).json({ error: 'Access denied to this group' });
    }
    const devices = await query(
      'SELECT id, name, ip_address, mac_address, os_type, group_id, status, last_seen, created_at FROM devices WHERE group_id = ? AND org_id = ? ORDER BY name',
      [req.params.id, req.orgId]
    );
    res.json(devices);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/groups
router.post('/',
  requireManageGroups,
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 500 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const id = uuidv4();
      const { name, description } = req.body;
      await execute('INSERT INTO `groups` (id, name, description, org_id) VALUES (?, ?, ?, ?)',
        [id, name, description || null, req.orgId]);
      await audit.log({ userId: req.user.id, username: req.user.username,
        action: 'add_group', targetType: 'group', targetId: id,
        targetName: name, ipSource: req.realIp, result: 'success' });
      res.status(201).json(await queryOne('SELECT * FROM `groups` WHERE id = ?', [id]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Group name already exists' });
      res.status(500).json({ error: e.message });
    }
  }
);

// PUT /api/groups/:id
router.put('/:id',
  requireManageGroups,
  param('id').isUUID(),
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 500 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      if (!await queryOne('SELECT id FROM `groups` WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]))
        return res.status(404).json({ error: 'Group not found' });
      const { name, description } = req.body;
      await execute('UPDATE `groups` SET name = ?, description = ? WHERE id = ? AND org_id = ?',
        [name, description || null, req.params.id, req.orgId]);
      res.json(await queryOne('SELECT * FROM `groups` WHERE id = ?', [req.params.id]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// DELETE /api/groups — delete ALL groups (devices become unassigned, not deleted)
router.delete('/', requireManageGroups, async (req, res) => {
  try {
    const { c: count } = await queryOne('SELECT COUNT(*) as c FROM `groups` WHERE org_id = ?', [req.orgId]);
    if (!count) return res.json({ message: 'No groups to delete', deleted: 0 });

    await execute('DELETE FROM `groups` WHERE org_id = ?', [req.orgId]);

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'delete_all_groups', targetType: 'group', targetId: null,
      targetName: `${count} group(s)`, ipSource: req.realIp, result: 'success',
      details: `Deleted all ${count} group(s); devices unassigned`,
    });

    res.json({ message: `${count} group(s) deleted`, deleted: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/groups/:id
router.delete('/:id', requireManageGroups, param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const group = await queryOne('SELECT * FROM `groups` WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await execute('DELETE FROM `groups` WHERE id = ?', [req.params.id]);
    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'delete_group', targetType: 'group', targetId: req.params.id,
      targetName: group.name, ipSource: req.realIp, result: 'success' });
    res.json({ message: 'Group deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;