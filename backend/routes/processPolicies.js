// routes/processPolicies.js — Restricted-program policy management
//
// Lets an admin define rules blocking or flagging specific
// programs/processes running on agents (global, per-group, or
// per-device). The agent itself fetches the *effective* rule set for
// its own device via GET /api/metrics/policies (agent-key auth, see
// routes/metrics.js) and reports detections via POST /api/metrics/violation.
// This file only exposes the admin-facing CRUD + violation history.
'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

const MATCH_TYPES = ['exact', 'contains'];
const ACTIONS = ['alert', 'kill'];
const OS_TYPES = ['linux', 'windows'];

// ── GET /api/process-policies — list all policies ─────────────────────────────
router.get('/', requirePermission(4096), async (req, res) => {
  try {
    const rows = await query(
      `SELECT pp.*, d.name AS device_name, g.name AS group_name, u.username AS created_by_name
         FROM process_policies pp
    LEFT JOIN devices d ON pp.device_id = d.id
    LEFT JOIN \`groups\` g ON pp.group_id = g.id
    LEFT JOIN users u ON pp.created_by = u.id
        ORDER BY pp.created_at DESC`
    );
    res.json(rows.map(r => ({ ...r, enabled: !!r.enabled })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/process-policies/violations — recent detections ─────────────────
router.get('/violations', requirePermission(4096), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const rows = await query(
      `SELECT pv.*, d.name AS device_name
         FROM process_violations pv
         JOIN devices d ON pv.device_id = d.id
        ORDER BY pv.detected_at DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/process-policies/violations — clear history ──────────────────
router.delete('/violations', requirePermission(4096), async (req, res) => {
  try {
    await execute('DELETE FROM process_violations');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/process-policies — create a restriction ─────────────────────────
router.post('/', requirePermission(4096), async (req, res) => {
  try {
    const {
      process_name, match_type = 'contains', action = 'alert',
      device_id = null, group_id = null, os_type = null, enabled = true,
    } = req.body;

    if (!process_name?.trim()) return res.status(400).json({ error: 'process_name is required' });
    if (!MATCH_TYPES.includes(match_type)) return res.status(400).json({ error: 'invalid match_type' });
    if (!ACTIONS.includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (os_type && !OS_TYPES.includes(os_type)) return res.status(400).json({ error: 'invalid os_type' });
    if (device_id && group_id) return res.status(400).json({ error: 'choose either a device or a group, not both' });

    if (device_id) {
      const d = await queryOne('SELECT id FROM devices WHERE id = ?', [device_id]);
      if (!d) return res.status(404).json({ error: 'Device not found' });
    }
    if (group_id) {
      const g = await queryOne('SELECT id FROM `groups` WHERE id = ?', [group_id]);
      if (!g) return res.status(404).json({ error: 'Group not found' });
    }

    const id = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    await execute(
      `INSERT INTO process_policies
         (id, device_id, group_id, process_name, match_type, action, os_type, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, device_id || null, group_id || null, process_name.trim(),
       match_type, action, os_type || null, enabled ? 1 : 0, req.user.id, now]
    );

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'create_process_policy', targetType: 'process_policy', targetId: id,
      targetName: process_name.trim(), ipSource: req.realIp || req.ip, result: 'success',
      details: `${action} on "${process_name.trim()}" (${match_type})${device_id ? ' — device-scoped' : group_id ? ' — group-scoped' : ' — global'}`,
    });

    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/process-policies/:id ──────────────────────────────────────────────
router.put('/:id', requirePermission(4096), async (req, res) => {
  try {
    const existing = await queryOne('SELECT * FROM process_policies WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Policy not found' });

    const {
      process_name = existing.process_name, match_type = existing.match_type,
      action = existing.action, device_id = existing.device_id,
      group_id = existing.group_id, os_type = existing.os_type,
      enabled = existing.enabled,
    } = req.body;

    if (!process_name?.trim()) return res.status(400).json({ error: 'process_name is required' });
    if (!MATCH_TYPES.includes(match_type)) return res.status(400).json({ error: 'invalid match_type' });
    if (!ACTIONS.includes(action)) return res.status(400).json({ error: 'invalid action' });
    if (device_id && group_id) return res.status(400).json({ error: 'choose either a device or a group, not both' });

    await execute(
      `UPDATE process_policies SET process_name=?, match_type=?, action=?, device_id=?, group_id=?, os_type=?, enabled=? WHERE id=?`,
      [process_name.trim(), match_type, action, device_id || null, group_id || null,
       os_type || null, enabled ? 1 : 0, req.params.id]
    );

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'update_process_policy', targetType: 'process_policy', targetId: req.params.id,
      targetName: process_name.trim(), ipSource: req.realIp || req.ip, result: 'success',
    });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/process-policies/:id ───────────────────────────────────────────
router.delete('/:id', requirePermission(4096), async (req, res) => {
  try {
    const existing = await queryOne('SELECT process_name FROM process_policies WHERE id = ?', [req.params.id]);
    await execute('DELETE FROM process_policies WHERE id = ?', [req.params.id]);

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'delete_process_policy', targetType: 'process_policy', targetId: req.params.id,
      targetName: existing?.process_name || req.params.id, ipSource: req.realIp || req.ip, result: 'success',
    });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;