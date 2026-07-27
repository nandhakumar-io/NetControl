// routes/groups.js
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const audit = require('../services/audit');
const { DEVICE_TYPES } = require('../db/migrate-group-device-type');

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
        'SELECT g.*, COUNT(d.id) as device_count, prev.device_count as device_count_prev ' +
        'FROM `groups` g ' +
        'INNER JOIN user_group_access uga ON uga.group_id = g.id AND uga.user_id = ? ' +
        'LEFT JOIN devices d ON d.group_id = g.id ' +
        'LEFT JOIN group_device_count_snapshots prev ON prev.group_id = g.id ' +
        '  AND prev.snapshot_date = (SELECT MAX(snapshot_date) FROM group_device_count_snapshots WHERE group_id = g.id AND snapshot_date < CURDATE()) ' +
        'WHERE g.org_id = ? ' +
        'GROUP BY g.id, prev.device_count ORDER BY g.name',
        [req.user.id, req.orgId]
      );
    } else {
      groups = await query(
        'SELECT g.*, COUNT(d.id) as device_count, prev.device_count as device_count_prev ' +
        'FROM `groups` g LEFT JOIN devices d ON d.group_id = g.id ' +
        'LEFT JOIN group_device_count_snapshots prev ON prev.group_id = g.id ' +
        '  AND prev.snapshot_date = (SELECT MAX(snapshot_date) FROM group_device_count_snapshots WHERE group_id = g.id AND snapshot_date < CURDATE()) ' +
        'WHERE g.org_id = ? GROUP BY g.id, prev.device_count ORDER BY g.name',
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
      'SELECT id, name, ip_address, mac_address, os_type, group_id, status, last_seen, created_at, seat_row, seat_col FROM devices WHERE group_id = ? AND org_id = ? ORDER BY name',
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
  body('device_type').optional().isIn(DEVICE_TYPES),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const id = uuidv4();
      const { name, description, device_type } = req.body;
      await execute('INSERT INTO `groups` (id, name, description, device_type, org_id) VALUES (?, ?, ?, ?, ?)',
        [id, name, description || null, device_type || 'router', req.orgId]);
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
  body('device_type').optional().isIn(DEVICE_TYPES),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      if (!await queryOne('SELECT id FROM `groups` WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]))
        return res.status(404).json({ error: 'Group not found' });
      const { name, description, device_type } = req.body;
      await execute('UPDATE `groups` SET name = ?, description = ?, device_type = ? WHERE id = ? AND org_id = ?',
        [name, description || null, device_type || 'router', req.params.id, req.orgId]);
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

// PUT /api/groups/:id/layout — save a "lab" group's theater-style seat
// layout (per-row column counts + gaps) and which device sits in which
// seat. Re-saving always replaces the full layout + seat assignments for
// this group in one transaction-like pass, rather than patching — the
// editor always sends its complete current state, so partial updates would
// just be a source of drift between what's shown and what's stored.
router.put('/:id/layout',
  requireManageGroups,
  param('id').isUUID(),
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
    try {
      const group = await queryOne('SELECT id, name FROM `groups` WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!group) return res.status(404).json({ error: 'Group not found' });

      const { isLab = true, rowGap = 24, rows = [], seats = [] } = req.body;

      // ── Validate layout shape ─────────────────────────────────────────
      // Each row is made of one or more BLOCKS (theater-style sections),
      // e.g. "left block: 6 seats | aisle | center block: 10 seats | aisle
      // | right block: 6 seats". `col` in a seat assignment is still just
      // the flat 0-based seat index reading left-to-right across the whole
      // row (blocks only affect visual grouping/gaps), so storage and the
      // seat-bounds check below don't need to know about block boundaries
      // — only the row's total seat count.
      if (!Array.isArray(rows) || rows.length > 50)
        return res.status(400).json({ error: 'rows must be an array of at most 50 rows' });
      for (const r of rows) {
        if (!Array.isArray(r?.blocks) || r.blocks.length < 1 || r.blocks.length > 20)
          return res.status(400).json({ error: 'each row must have between 1 and 20 blocks' });
        for (const b of r.blocks) {
          const cols = Number(b?.cols);
          if (!Number.isInteger(cols) || cols < 1 || cols > 100)
            return res.status(400).json({ error: 'each block.cols must be an integer between 1 and 100' });
        }
        const gap = Number(r?.gap), blockGap = Number(r?.blockGap);
        if (!Number.isFinite(gap) || gap < 0 || gap > 200)
          return res.status(400).json({ error: 'each row.gap (within-block seat gap) must be between 0 and 200' });
        if (!Number.isFinite(blockGap) || blockGap < 0 || blockGap > 400)
          return res.status(400).json({ error: 'each row.blockGap (aisle gap) must be between 0 and 400' });
      }
      const rowGapNum = Number(rowGap);
      if (!Number.isFinite(rowGapNum) || rowGapNum < 0 || rowGapNum > 200)
        return res.status(400).json({ error: 'rowGap must be between 0 and 200' });

      const rowTotalCols = (r) => r.blocks.reduce((sum, b) => sum + Number(b.cols), 0);

      // ── Validate seat assignments against the row/col bounds above and
      //    against real devices that actually belong to this group ───────
      if (!Array.isArray(seats)) return res.status(400).json({ error: 'seats must be an array' });
      const seen = new Set();
      for (const s of seats) {
        const row = Number(s?.row), col = Number(s?.col);
        if (!Number.isInteger(row) || row < 0 || row >= rows.length)
          return res.status(400).json({ error: `seat row ${s?.row} is out of range for this layout` });
        if (!Number.isInteger(col) || col < 0 || col >= rowTotalCols(rows[row]))
          return res.status(400).json({ error: `seat col ${s?.col} is out of range for row ${row}` });
        if (!s?.deviceId) return res.status(400).json({ error: 'each seat needs a deviceId' });
        const key = `${row}:${col}`;
        if (seen.has(key)) return res.status(400).json({ error: `seat ${key} is assigned more than once` });
        seen.add(key);
      }
      if (seats.length) {
        const deviceIds = seats.map(s => s.deviceId);
        const placeholders = deviceIds.map(() => '?').join(',');
        const owned = await query(
          `SELECT id FROM devices WHERE id IN (${placeholders}) AND group_id = ? AND org_id = ?`,
          [...deviceIds, req.params.id, req.orgId]
        );
        if (owned.length !== new Set(deviceIds).size)
          return res.status(400).json({ error: 'one or more seats reference a device not in this group' });
      }

      await execute(
        'UPDATE `groups` SET is_lab = ?, layout_config = ? WHERE id = ? AND org_id = ?',
        [isLab ? 1 : 0, JSON.stringify({ rowGap: rowGapNum, rows }), req.params.id, req.orgId]
      );

      // Clear every existing seat in this group, then re-apply exactly what
      // was submitted — see comment above on why this is a full replace.
      await execute('UPDATE devices SET seat_row = NULL, seat_col = NULL WHERE group_id = ? AND org_id = ?',
        [req.params.id, req.orgId]);
      for (const s of seats) {
        await execute('UPDATE devices SET seat_row = ?, seat_col = ? WHERE id = ? AND group_id = ? AND org_id = ?',
          [s.row, s.col, s.deviceId, req.params.id, req.orgId]);
      }

      await audit.log({ userId: req.user.id, username: req.user.username,
        action: 'update_group_layout', targetType: 'group', targetId: req.params.id,
        targetName: group.name, ipSource: req.realIp, result: 'success',
        details: `${rows.length} row(s), ${seats.length} seat(s) assigned` });

      const updatedGroup = await queryOne('SELECT * FROM `groups` WHERE id = ?', [req.params.id]);
      const devices = await query(
        'SELECT id, name, ip_address, mac_address, os_type, group_id, status, last_seen, created_at, seat_row, seat_col FROM devices WHERE group_id = ? AND org_id = ? ORDER BY name',
        [req.params.id, req.orgId]
      );
      res.json({ group: updatedGroup, devices });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

module.exports = router;