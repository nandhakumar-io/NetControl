// routes/groups.js
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const audit = require('../services/audit');
const { DEVICE_TYPES } = require('../db/migrate-group-device-type');
const { deviceAccessSql, canUserAccessGroup, canUserAccessCluster } = require('../services/accessControl');

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
      const devFilter = deviceAccessSql(req.user, 'd');
      groups = await query(
        `SELECT g.*, COUNT(d.id) as device_count, prev.device_count as device_count_prev
         FROM \`groups\` g
         LEFT JOIN devices d ON d.group_id = g.id AND ${devFilter.sql}
         LEFT JOIN group_device_count_snapshots prev ON prev.group_id = g.id
           AND prev.snapshot_date = (SELECT MAX(snapshot_date) FROM group_device_count_snapshots WHERE group_id = g.id AND snapshot_date < CURDATE())
         WHERE g.org_id = ? AND (
           EXISTS (SELECT 1 FROM user_group_access uga WHERE uga.group_id = g.id AND uga.user_id = ?) OR
           EXISTS (SELECT 1 FROM user_cluster_access uca WHERE uca.group_id = g.id AND uca.user_id = ?)
         )
         GROUP BY g.id, prev.device_count ORDER BY g.name`,
        [...devFilter.params, req.orgId, req.user.id, req.user.id]
      );
    } else {
      groups = await query(
        `SELECT g.*, COUNT(d.id) as device_count, prev.device_count as device_count_prev
         FROM \`groups\` g LEFT JOIN devices d ON d.group_id = g.id
         LEFT JOIN group_device_count_snapshots prev ON prev.group_id = g.id
           AND prev.snapshot_date = (SELECT MAX(snapshot_date) FROM group_device_count_snapshots WHERE group_id = g.id AND snapshot_date < CURDATE())
         WHERE g.org_id = ? GROUP BY g.id, prev.device_count ORDER BY g.name`,
        [req.orgId]
      );
    }

    let clusters = [];
    if (req.user.role !== 'admin') {
      clusters = await query(
        `SELECT c.*, COUNT(d.id) AS device_count
           FROM clusters c
           LEFT JOIN devices d ON d.cluster_id = c.id
          WHERE c.org_id = ? AND (
            EXISTS (SELECT 1 FROM user_cluster_access uca WHERE uca.cluster_id = c.id AND uca.user_id = ?) OR
            (
              EXISTS (SELECT 1 FROM user_group_access uga WHERE uga.group_id = c.group_id AND uga.user_id = ?) AND
              NOT EXISTS (SELECT 1 FROM user_cluster_access uca WHERE uca.group_id = c.group_id AND uca.user_id = ?)
            )
          )
          GROUP BY c.id ORDER BY c.name`,
        [req.orgId, req.user.id, req.user.id, req.user.id]
      );
    } else {
      clusters = await query(
        `SELECT c.*, COUNT(d.id) AS device_count
           FROM clusters c
           LEFT JOIN devices d ON d.cluster_id = c.id
          WHERE c.org_id = ?
          GROUP BY c.id ORDER BY c.name`,
        [req.orgId]
      );
    }

    const clusterMap = new Map();
    for (const c of clusters) {
      if (!clusterMap.has(c.group_id)) clusterMap.set(c.group_id, []);
      clusterMap.get(c.group_id).push(c);
    }
    for (const g of groups) {
      g.clusters = clusterMap.get(g.id) || [];
    }

    res.json(groups);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/groups/:id/devices
router.get('/:id/devices', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    if (req.user.role !== 'admin') {
      const access = await canUserAccessGroup(req.user, req.params.id);
      if (!access) return res.status(403).json({ error: 'Access denied to this group' });
    }
    const devFilter = deviceAccessSql(req.user, 'd');
    const devices = await query(
      `SELECT d.id, d.name, d.ip_address, d.mac_address, d.os_type, d.group_id, d.cluster_id,
              d.status, d.last_seen, d.created_at, d.seat_row, d.seat_col,
              c.name as cluster_name, c.color as cluster_color
       FROM devices d
       LEFT JOIN clusters c ON c.id = d.cluster_id
       WHERE d.group_id = ? AND d.org_id = ? AND ${devFilter.sql}
       ORDER BY d.name`,
      [req.params.id, req.orgId, ...devFilter.params]
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

// ── Clusters / Batches Endpoints ─────────────────────────────────────────────

// GET /api/groups/:id/clusters — list clusters in this group
router.get('/:id/clusters', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    if (req.user.role !== 'admin') {
      const canAccess = await canUserAccessGroup(req.user, req.params.id);
      if (!canAccess) return res.status(403).json({ error: 'Access denied to this group' });
    }

    let clusterFilter = '';
    const clusterParams = [req.params.id, req.orgId];
    if (req.user.role !== 'admin') {
      const hasRestrictions = await queryOne(
        'SELECT 1 FROM user_cluster_access WHERE user_id = ? AND group_id = ?',
        [req.user.id, req.params.id]
      );
      if (hasRestrictions) {
        clusterFilter = ' AND c.id IN (SELECT cluster_id FROM user_cluster_access WHERE user_id = ? AND group_id = ?)';
        clusterParams.push(req.user.id, req.params.id);
      }
    }

    const clusters = await query(
      `SELECT c.*, 
              COUNT(d.id) AS device_count,
              SUM(CASE WHEN d.status = 'online' THEN 1 ELSE 0 END) AS online_count
         FROM clusters c
         LEFT JOIN devices d ON d.cluster_id = c.id
        WHERE c.group_id = ? AND c.org_id = ?${clusterFilter}
        GROUP BY c.id
        ORDER BY c.name`,
      clusterParams
    );

    // Get assigned staff/operators for each cluster
    const assignments = await query(
      `SELECT uca.cluster_id, u.id AS user_id, u.username, u.name
         FROM user_cluster_access uca
         JOIN users u ON u.id = uca.user_id
        WHERE uca.group_id = ?`,
      [req.params.id]
    );
    const assignMap = new Map();
    for (const a of assignments) {
      if (!assignMap.has(a.cluster_id)) assignMap.set(a.cluster_id, []);
      assignMap.get(a.cluster_id).push({ id: a.user_id, username: a.username, name: a.name });
    }

    res.json(clusters.map(c => ({
      ...c,
      device_count: parseInt(c.device_count, 10) || 0,
      online_count: parseInt(c.online_count, 10) || 0,
      assigned_operators: assignMap.get(c.id) || [],
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/groups/:id/clusters — create cluster/batch in this group
router.post('/:id/clusters',
  requireManageGroups,
  param('id').isUUID(),
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('color').optional().trim().matches(/^#[0-9a-fA-F]{6}$/),
  body('deviceIds').optional().isArray(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const group = await queryOne('SELECT id, name FROM `groups` WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!group) return res.status(404).json({ error: 'Group not found' });

      const clusterId = uuidv4();
      const { name, description, color = '#a855f7', deviceIds = [] } = req.body;

      await execute(
        'INSERT INTO clusters (id, group_id, org_id, name, description, color) VALUES (?, ?, ?, ?, ?, ?)',
        [clusterId, req.params.id, req.orgId, name, description || null, color]
      );

      if (deviceIds.length > 0) {
        const placeholders = deviceIds.map(() => '?').join(',');
        await execute(
          `UPDATE devices SET cluster_id = ? WHERE id IN (${placeholders}) AND group_id = ? AND org_id = ?`,
          [clusterId, ...deviceIds, req.params.id, req.orgId]
        );
      }

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'create_cluster', targetType: 'cluster', targetId: clusterId,
        targetName: `${group.name} / ${name}`, ipSource: req.realIp, result: 'success',
        details: `Created cluster "${name}" in group "${group.name}" with ${deviceIds.length} device(s)`,
      });

      const cluster = await queryOne('SELECT * FROM clusters WHERE id = ?', [clusterId]);
      res.status(201).json(cluster);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// PUT /api/groups/:id/clusters/:clusterId — update cluster details & device membership
router.put('/:id/clusters/:clusterId',
  requireManageGroups,
  param('id').isUUID(),
  param('clusterId').isUUID(),
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('color').optional().trim().matches(/^#[0-9a-fA-F]{6}$/),
  body('deviceIds').optional().isArray(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const cluster = await queryOne(
        'SELECT * FROM clusters WHERE id = ? AND group_id = ? AND org_id = ?',
        [req.params.clusterId, req.params.id, req.orgId]
      );
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      const { name, description, color, deviceIds } = req.body;
      await execute(
        'UPDATE clusters SET name = ?, description = ?, color = ? WHERE id = ?',
        [name, description || null, color || cluster.color, req.params.clusterId]
      );

      if (Array.isArray(deviceIds)) {
        await execute(
          'UPDATE devices SET cluster_id = NULL WHERE cluster_id = ? AND group_id = ? AND org_id = ?',
          [req.params.clusterId, req.params.id, req.orgId]
        );
        if (deviceIds.length > 0) {
          const placeholders = deviceIds.map(() => '?').join(',');
          await execute(
            `UPDATE devices SET cluster_id = ? WHERE id IN (${placeholders}) AND group_id = ? AND org_id = ?`,
            [req.params.clusterId, ...deviceIds, req.params.id, req.orgId]
          );
        }
      }

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'update_cluster', targetType: 'cluster', targetId: req.params.clusterId,
        targetName: name, ipSource: req.realIp, result: 'success',
      });

      res.json(await queryOne('SELECT * FROM clusters WHERE id = ?', [req.params.clusterId]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// DELETE /api/groups/:id/clusters/:clusterId — delete cluster (devices become unclustered)
router.delete('/:id/clusters/:clusterId',
  requireManageGroups,
  param('id').isUUID(),
  param('clusterId').isUUID(),
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
    try {
      const cluster = await queryOne(
        'SELECT * FROM clusters WHERE id = ? AND group_id = ? AND org_id = ?',
        [req.params.clusterId, req.params.id, req.orgId]
      );
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      await execute('UPDATE devices SET cluster_id = NULL WHERE cluster_id = ?', [req.params.clusterId]);
      await execute('DELETE FROM clusters WHERE id = ?', [req.params.clusterId]);

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'delete_cluster', targetType: 'cluster', targetId: req.params.clusterId,
        targetName: cluster.name, ipSource: req.realIp, result: 'success',
      });

      res.json({ message: 'Cluster deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

module.exports = router;