// routes/devices.js
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { encrypt } = require('../services/crypto');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

/**
 * Strip only the secret values (passwords, private key).
 * Usernames are NOT secrets — the edit form needs them to pre-populate.
 * Replace each secret with a boolean so the frontend knows one exists.
 */
function sanitizeDevice(d) {
  const { ssh_password, ssh_key, rpc_password, ...safe } = d;
  safe.has_ssh_password = !!ssh_password;
  safe.has_ssh_key      = !!ssh_key;
  safe.has_rpc_password = !!rpc_password;
  return safe;
}

// ── Validation for a single device field ─────────────────────────────────────
const deviceValidation = [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('ip_address').isIP(),
  body('mac_address').matches(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/),
  body('os_type').isIn(['windows', 'linux']),
  body('group_id').optional({ nullable: true }).custom(v => !v || /^[0-9a-f-]{36}$/i.test(v)).withMessage('Invalid group_id'),
  body('ssh_username').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('ssh_password').optional({ nullable: true }).isLength({ max: 500 }),
  body('ssh_key').optional({ nullable: true }).isLength({ max: 10000 }),
  body('rpc_username').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('rpc_password').optional({ nullable: true }).isLength({ max: 500 }),
];

// ── Normalise MAC to uppercase colon-separated ────────────────────────────────
function normaliseMac(mac) {
  return String(mac || '').toUpperCase().replace(/-/g, ':');
}

// ── Validate a single row from a bulk payload ─────────────────────────────────
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
const IP_RE  = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/; // IPv4 + basic IPv6

function validateRow(row, index) {
  const errs = [];
  const label = `Row ${index + 2}`; // +2: header row + 0-index offset

  if (!row.name || !String(row.name).trim())
    errs.push(`${label}: name is required`);
  else if (String(row.name).trim().length > 100)
    errs.push(`${label}: name too long (max 100)`);

  if (!row.ip_address || !IP_RE.test(String(row.ip_address).trim()))
    errs.push(`${label}: invalid ip_address`);

  if (!row.mac_address || !MAC_RE.test(String(row.mac_address).trim()))
    errs.push(`${label}: invalid mac_address (expected AA:BB:CC:DD:EE:FF)`);

  const os = (row.os_type || '').toLowerCase();
  if (!['windows', 'linux'].includes(os))
    errs.push(`${label}: os_type must be "linux" or "windows"`);

  return errs;
}

// ── GET /api/devices ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    let devices;
    if (req.user.role === 'operator') {
      devices = await query(
        'SELECT d.*, g.name as group_name FROM devices d ' +
        'INNER JOIN `groups` g ON g.id = d.group_id ' +
        'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
        'ORDER BY d.name',
        [req.user.id]
      );
    } else {
      devices = await query(
        'SELECT d.*, g.name as group_name FROM devices d LEFT JOIN `groups` g ON g.id = d.group_id ORDER BY d.name'
      );
    }
    const _ = null; // scoping done
    res.json(devices.map(sanitizeDevice));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/devices/:id ─────────────────────────────────────────────────────
// SECURITY FIX: Operators could previously fetch ANY device by ID (IDOR).
// Now operators are restricted to devices in their accessible groups.
router.get('/:id', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    let device;
    if (req.user.role === 'operator') {
      device = await queryOne(
        'SELECT d.*, g.name as group_name FROM devices d ' +
        'INNER JOIN `groups` g ON g.id = d.group_id ' +
        'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
        'WHERE d.id = ?',
        [req.user.id, req.params.id]
      );
    } else {
      device = await queryOne(
        'SELECT d.*, g.name as group_name FROM devices d LEFT JOIN `groups` g ON g.id = d.group_id WHERE d.id = ?',
        [req.params.id]
      );
    }
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(sanitizeDevice(device));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/devices (single) ───────────────────────────────────────────────
// SECURITY FIX: Only admins can add/edit/delete devices
const { requireRole } = require('../middleware/auth');
router.post('/', requireRole('admin'), deviceValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const id = uuidv4();
    const {
      name, ip_address, mac_address, os_type, group_id,
      ssh_username, ssh_password, ssh_key,
      rpc_username, rpc_password,
    } = req.body;

    const normalizedMac = normaliseMac(mac_address);

    await execute(
      `INSERT INTO devices
         (id, name, ip_address, mac_address, os_type, group_id,
          ssh_username, ssh_password, ssh_key,
          rpc_username, rpc_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, name, ip_address, normalizedMac, os_type, group_id || null,
        ssh_username  || null,
        ssh_password  ? encrypt(ssh_password)  : null,
        ssh_key       ? encrypt(ssh_key)        : null,
        rpc_username  || null,
        rpc_password  ? encrypt(rpc_password)  : null,
      ]
    );

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'add_device', targetType: 'device', targetId: id,
      targetName: name, ipSource: req.realIp, result: 'success',
    });

    const device = await queryOne('SELECT * FROM devices WHERE id = ?', [id]);
    res.status(201).json(sanitizeDevice(device));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/devices/bulk-import ───────────────────────────────────────────
//
//  Accepts: { devices: [ { name, ip_address, mac_address, os_type,
//                          group_id?, ssh_username?, ssh_password?,
//                          ssh_key?, rpc_username?, rpc_password? }, … ] }
//
//  Returns: { imported, skipped, failed,
//             results: [ { name, status: 'imported'|'skipped'|'failed', reason? } ] }
//
//  Duplicate logic (DB-level, not in-memory):
//    - Exact match on (ip_address AND mac_address) → skip (update=false)
//    - Same MAC, different IP → update IP (device moved)
//    - Same IP, different MAC → treated as new device (MAC change = possible new hardware)
//
//  Security:
//    - Hard cap of 500 devices per call to prevent DoS
//    - Each row individually validated before any DB writes
//    - All secrets encrypted before storage (same as single-device route)
//    - Single audit log entry for the whole batch (not 500 separate ones)
//
router.post('/bulk-import',
  requireRole('admin'),
  body('devices').isArray({ min: 1, max: 500 }).withMessage('devices must be an array of 1–500 items'),
  async (req, res) => {
    const topErrors = validationResult(req);
    if (!topErrors.isEmpty()) return res.status(400).json({ errors: topErrors.array() });

    const rows = req.body.devices;

    // ── Phase 1: validate ALL rows before touching the DB ─────────────────
    const validationErrors = rows.flatMap((row, i) => validateRow(row, i));
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed — no devices were imported',
        validationErrors,
      });
    }

    // ── Phase 2: load existing devices for duplicate detection ────────────
    // We only load the columns we need — no secrets come out of the DB here.
    const existing = await query('SELECT id, ip_address, mac_address FROM devices');
    const byMac = new Map(existing.map(d => [d.mac_address.toUpperCase(), d]));
    const byIp  = new Map(existing.map(d => [d.ip_address, d]));

    // ── Phase 3: classify rows ────────────────────────────────────────────
    const toInsert = [];  // brand-new devices
    const toUpdate = [];  // MAC exists but IP changed (device moved)
    const skipped  = [];  // exact duplicate (mac + ip both match)

    for (const row of rows) {
      const mac = normaliseMac(row.mac_address);
      const ip  = String(row.ip_address).trim();

      const existingByMac = byMac.get(mac);
      const existingByIp  = byIp.get(ip);

      if (existingByMac && existingByMac.ip_address === ip) {
        // Perfect duplicate — skip silently
        skipped.push({ name: String(row.name).trim(), status: 'skipped', reason: 'Already exists (same IP + MAC)' });
      } else if (existingByMac && existingByMac.ip_address !== ip) {
        // Same device, IP has changed — update IP only
        toUpdate.push({ ...row, mac, ip, existingId: existingByMac.id });
      } else {
        // New device
        toInsert.push({ ...row, mac, ip });
      }
    }

    // ── Phase 4: execute inserts + updates ───────────────────────────────
    const results = [...skipped];
    let imported = 0;
    let failed   = 0;

    for (const row of toInsert) {
      const name = String(row.name).trim();
      try {
        const id = uuidv4();
        await execute(
          `INSERT INTO devices
             (id, name, ip_address, mac_address, os_type, group_id,
              ssh_username, ssh_password, ssh_key, rpc_username, rpc_password)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            name,
            row.ip,
            row.mac,
            (row.os_type || 'linux').toLowerCase(),
            row.group_id || null,
            row.ssh_username  ? String(row.ssh_username).trim()  : null,
            row.ssh_password  ? encrypt(String(row.ssh_password)) : null,
            row.ssh_key       ? encrypt(String(row.ssh_key))      : null,
            row.rpc_username  ? String(row.rpc_username).trim()   : null,
            row.rpc_password  ? encrypt(String(row.rpc_password)) : null,
          ]
        );
        results.push({ name, status: 'imported' });
        imported++;
      } catch (e) {
        results.push({ name, status: 'failed', reason: e.message });
        failed++;
      }
    }

    for (const row of toUpdate) {
      const name = String(row.name).trim();
      try {
        await execute(
          'UPDATE devices SET ip_address = ?, name = ? WHERE id = ?',
          [row.ip, name, row.existingId]
        );
        results.push({ name, status: 'imported', reason: 'IP updated (device moved)' });
        imported++;
      } catch (e) {
        results.push({ name, status: 'failed', reason: e.message });
        failed++;
      }
    }

    // ── Phase 5: single audit log entry for the whole batch ───────────────
    await audit.log({
      userId:     req.user.id,
      username:   req.user.username,
      action:     'bulk_import_devices',
      targetType: 'device',
      targetId:   null,
      targetName: `${imported} imported, ${skipped.length} skipped, ${failed} failed`,
      ipSource:   req.realIp,
      result:     failed > 0 && imported === 0 ? 'failure'
                : failed > 0                   ? 'partial'
                :                                'success',
      details: JSON.stringify({ total: rows.length, imported, skipped: skipped.length, failed }),
    });

    res.status(200).json({
      imported,
      skipped: skipped.length,
      failed,
      results,
    });
  }
);

// ── PUT /api/devices/:id ─────────────────────────────────────────────────────
router.put('/:id', requireRole('admin'), param('id').isUUID(), deviceValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const existing = await queryOne('SELECT id FROM devices WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Device not found' });

    const {
      name, ip_address, mac_address, os_type, group_id,
      ssh_username, ssh_password, ssh_key,
      rpc_username, rpc_password,
    } = req.body;

    const normalizedMac = normaliseMac(mac_address);

    const encSshPw  = ssh_password ? encrypt(ssh_password) : null;
    const encSshKey = ssh_key      ? encrypt(ssh_key)      : null;
    const encRpcPw  = rpc_password ? encrypt(rpc_password) : null;

    await execute(
      `UPDATE devices SET
         name         = ?,
         ip_address   = ?,
         mac_address  = ?,
         os_type      = ?,
         group_id     = ?,
         ssh_username = ?,
         ssh_password = CASE WHEN ? IS NOT NULL THEN ? ELSE ssh_password END,
         ssh_key      = CASE WHEN ? IS NOT NULL THEN ? ELSE ssh_key      END,
         rpc_username = ?,
         rpc_password = CASE WHEN ? IS NOT NULL THEN ? ELSE rpc_password END
       WHERE id = ?`,
      [
        name, ip_address, normalizedMac, os_type, group_id || null,
        ssh_username || null,
        encSshPw,  encSshPw,
        encSshKey, encSshKey,
        rpc_username || null,
        encRpcPw,  encRpcPw,
        req.params.id,
      ]
    );

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'edit_device', targetType: 'device', targetId: req.params.id,
      targetName: name, ipSource: req.realIp, result: 'success',
    });

    const device = await queryOne('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    res.json(sanitizeDevice(device));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/devices/:id ──────────────────────────────────────────────────
router.delete('/:id', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const device = await queryOne('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    await execute('DELETE FROM devices WHERE id = ?', [req.params.id]);
    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'delete_device', targetType: 'device', targetId: req.params.id,
      targetName: device.name, ipSource: req.realIp, result: 'success',
    });
    res.json({ message: 'Device deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/devices/poll-all ───────────────────────────────────────────────
router.post('/poll-all', async (req, res) => {
  try {
    const { pollAll } = require('../services/statusPoller');
    pollAll().catch(console.error);
    res.json({ message: 'Full poll triggered' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/devices/:id/poll ───────────────────────────────────────────────
router.post('/:id/poll', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const device = await queryOne(
      'SELECT id, name, ip_address, os_type, status FROM devices WHERE id = ?',
      [req.params.id]
    );
    if (!device) return res.status(404).json({ error: 'Device not found' });
    const { pollDevice } = require('../services/statusPoller');
    const result = await pollDevice(device);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

