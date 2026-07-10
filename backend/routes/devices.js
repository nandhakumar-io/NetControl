// routes/devices.js
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const { encrypt } = require('../services/crypto');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

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

// ── Resolve a maintenance expiry timestamp from request body ─────────────────
// Accepts either an explicit unix `until` timestamp or a convenience
// `duration_minutes` (converted to now + N minutes). Neither present means
// "no auto-expiry" — the device stays under maintenance until someone
// explicitly marks it ok. Returns null on absent/invalid input.
const MAX_MAINTENANCE_MINUTES = 30 * 24 * 60; // 30 days
function resolveMaintenanceUntil(body, nowSec) {
  if (body.until != null) {
    const until = parseInt(body.until, 10);
    return Number.isFinite(until) && until > nowSec ? until : null;
  }
  if (body.duration_minutes != null) {
    const mins = parseInt(body.duration_minutes, 10);
    if (Number.isFinite(mins) && mins > 0) {
      return nowSec + Math.min(mins, MAX_MAINTENANCE_MINUTES) * 60;
    }
  }
  return null;
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
    if (req.user.role !== 'admin') {
      devices = await query(
        'SELECT d.*, g.name as group_name FROM devices d ' +
        'INNER JOIN `groups` g ON g.id = d.group_id ' +
        'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
        'WHERE d.org_id = ? ORDER BY d.name',
        [req.user.id, req.orgId]
      );
    } else {
      devices = await query(
        'SELECT d.*, g.name as group_name FROM devices d LEFT JOIN `groups` g ON g.id = d.group_id WHERE d.org_id = ? ORDER BY d.name',
        [req.orgId]
      );
    }
    const _ = null; // scoping done
    res.json(devices.map(sanitizeDevice));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/devices/:id ─────────────────────────────────────────────────────
// SECURITY FIX: Non-admins could previously fetch ANY device by ID (IDOR).
// Now every non-admin role (operator, viewer, custom) is restricted to
// devices in the groups they've been explicitly granted access to via
// user_group_access — this is what makes per-device-group / per-client
// scoping possible (e.g. a viewer role handed to a contractor only ever
// sees the devices belonging to their assigned group(s)).
router.get('/:id', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    let device;
    if (req.user.role !== 'admin') {
      device = await queryOne(
        'SELECT d.*, g.name as group_name FROM devices d ' +
        'INNER JOIN `groups` g ON g.id = d.group_id ' +
        'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
        'WHERE d.id = ? AND d.org_id = ?',
        [req.user.id, req.params.id, req.orgId]
      );
    } else {
      device = await queryOne(
        'SELECT d.*, g.name as group_name FROM devices d LEFT JOIN `groups` g ON g.id = d.group_id WHERE d.id = ? AND d.org_id = ?',
        [req.params.id, req.orgId]
      );
    }
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(sanitizeDevice(device));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/devices (single) ───────────────────────────────────────────────
// SECURITY FIX: Only admins can add/edit/delete devices
// (requireRole is declared once here and used for every admin-only route
// below, including approve-registration and PUT further down the file.)
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

    // Enforce the org's device-limit before writing (plan/billing gate) —
    // an org on a 25-device trial plan can't silently grow past it.
    const [{ device_count }] = await query('SELECT COUNT(*) AS device_count FROM devices WHERE org_id = ?', [req.orgId]);
    if (req.org && device_count >= req.org.device_limit) {
      return res.status(403).json({
        error: `Device limit reached (${req.org.device_limit}) for this organization's plan.`,
        code: 'DEVICE_LIMIT_REACHED',
      });
    }

    await execute(
      `INSERT INTO devices
         (id, name, ip_address, mac_address, os_type, group_id,
          ssh_username, ssh_password, ssh_key,
          rpc_username, rpc_password, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, name, ip_address, normalizedMac, os_type, group_id || null,
        ssh_username  || null,
        ssh_password  ? encrypt(ssh_password)  : null,
        ssh_key       ? encrypt(ssh_key)        : null,
        rpc_username  || null,
        rpc_password  ? encrypt(rpc_password)  : null,
        req.orgId,
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
    // SECURITY/CORRECTNESS FIX: this used to load every device in the
    // entire installation with no org_id filter. Two real problems:
    //   1. A MAC/IP collision with another tenant's device (private IP
    //      ranges collide across separate clients constantly) would match
    //      here and the "toUpdate" path below would silently overwrite
    //      that OTHER org's device's IP/name — a bulk import in org A
    //      could corrupt org B's inventory.
    //   2. Legitimate new devices for this org would get incorrectly
    //      "skipped" as duplicates if another tenant happened to already
    //      have a device with the same MAC.
    // Scoping to this org's devices only fixes both.
    const existing = await query('SELECT id, ip_address, mac_address FROM devices WHERE org_id = ?', [req.orgId]);
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
              ssh_username, ssh_password, ssh_key, rpc_username, rpc_password, org_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            req.orgId,
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
          'UPDATE devices SET ip_address = ?, name = ? WHERE id = ? AND org_id = ?',
          [row.ip, name, row.existingId, req.orgId]
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

// NOTE: PUT /api/devices/:id is implemented once, further down this file
// (the "ENHANCED" handler near approve-registration). A second, older
// copy of this same route used to live here — since Express dispatches
// to whichever matching route was registered FIRST, that older copy
// silently swallowed every device edit and the enhanced version (with
// explicit credential-clearing and updated_at tracking) was permanently
// unreachable dead code. Removed to avoid the duplicate-route shadowing.

// ── DELETE /api/devices — delete ALL devices (admin only) ───────────────────
router.delete('/', requireRole('admin'), async (req, res) => {
  try {
    const { c: count } = await queryOne('SELECT COUNT(*) as c FROM devices WHERE org_id = ?', [req.orgId]);
    if (!count) return res.json({ message: 'No devices to delete', deleted: 0 });

    await execute('DELETE FROM devices WHERE org_id = ?', [req.orgId]);

    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'delete_all_devices', targetType: 'device', targetId: null,
      targetName: `${count} device(s)`, ipSource: req.realIp, result: 'success',
      details: `Deleted all ${count} device(s)`,
    });

    res.json({ message: `${count} device(s) deleted`, deleted: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/devices/:id ──────────────────────────────────────────────────
router.delete('/:id', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const device = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
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
    // BUG FIX 1: Select all fields pollDevice needs — agent_key_hash and last_seen were missing,
    // causing agent devices to always fall through to TCP and never detect correctly.
    // SECURITY FIX: scoped to this org — was previously fetchable/pollable by
    // UUID alone, letting an admin/operator in one org trigger a poll
    // against (and read the status of) a device belonging to another tenant.
    const device = await queryOne(
      'SELECT id, name, ip_address, os_type, status, last_seen, agent_key_hash FROM devices WHERE id = ? AND org_id = ?',
      [req.params.id, req.orgId]
    );
    if (!device) return res.status(404).json({ error: 'Device not found' });
    const { pollDevice, flushToDB } = require('../services/statusPoller');
    // BUG FIX 2: Pass nowSec — without it, (nowSec - lastSeen) = NaN so the
    // agent grace check always fails, making all agent devices appear offline.
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await pollDevice(device, nowSec);
    // BUG FIX 3: Flush result to DB — previously the status was never persisted,
    // so devices remained "online" in the DB even when probe detected them offline.
    await flushToDB([result], nowSec);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/devices/bulk-maintenance ───────────────────────────────────────
// Toggle maintenance mode across many devices at once (patch windows,
// whole-group maintenance — pair with the frontend's "select all" in a
// group, or select individual devices then bulk-apply).
//
//  Accepts: { deviceIds: [uuid, ...], enabled: bool, note?: string }
//
//  Operators are restricted to devices in their accessible groups — any
//  requested id outside that set is silently dropped from the update rather
//  than failing the whole batch, and the response reports how many were
//  actually skipped so the UI can tell the operator.
router.post('/bulk-maintenance',
  requireRole('admin', 'operator'),
  body('deviceIds').isArray({ min: 1, max: 500 }).withMessage('deviceIds must be an array of 1–500 items'),
  body('deviceIds.*').isUUID().withMessage('Invalid device id'),
  body('enabled').isBoolean(),
  body('note').optional({ nullable: true }).trim().isLength({ max: 255 }),
  body('duration_minutes').optional({ nullable: true }).isInt({ min: 1, max: MAX_MAINTENANCE_MINUTES }),
  body('until').optional({ nullable: true }).isInt({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid request', details: errors.array() });

    try {
      let { deviceIds } = req.body;
      const enabled = !!req.body.enabled;
      const note    = req.body.note || null;
      const now     = Math.floor(Date.now() / 1000);
      const until   = enabled ? resolveMaintenanceUntil(req.body, now) : null;

      let skipped = 0;
      if (req.user.role !== 'admin') {
        const placeholders = deviceIds.map(() => '?').join(',');
        const accessible = await query(
          `SELECT d.id FROM devices d
           INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ?
           WHERE d.id IN (${placeholders})`,
          [req.user.id, ...deviceIds]
        );
        const allowedSet = new Set(accessible.map(r => r.id));
        skipped = deviceIds.length - allowedSet.size;
        deviceIds = deviceIds.filter(id => allowedSet.has(id));
      }

      if (!deviceIds.length) {
        return res.status(403).json({ error: 'Access denied to all requested devices' });
      }

      const placeholders = deviceIds.map(() => '?').join(',');
      const result = await execute(
        `UPDATE devices
           SET maintenance_mode = ?, maintenance_note = ?,
               maintenance_since = ?, maintenance_by = ?, maintenance_until = ?
         WHERE id IN (${placeholders})`,
        [enabled ? 1 : 0, enabled ? note : null,
         enabled ? now : null, enabled ? req.user.id : null, until,
         ...deviceIds]
      );

      // Invalidate the webhook service's per-device cache for each affected
      // device so the new maintenance state takes effect immediately.
      const { invalidateMaintenanceCache } = require('../services/webhook');
      deviceIds.forEach(id => invalidateMaintenanceCache(id));

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: enabled ? 'bulk_enable_maintenance_mode' : 'bulk_disable_maintenance_mode',
        targetType: 'device', targetId: null,
        targetName: `${deviceIds.length} device(s)`,
        ipSource: req.realIp || req.ip, result: 'success',
        details: `[${req.user.role}] ${enabled ? (note || 'Maintenance mode enabled') : 'Maintenance mode disabled'}` +
                 (until ? ` (auto-clears ${new Date(until * 1000).toISOString()})` : '') +
                 (skipped ? ` (${skipped} skipped — no group access)` : ''),
      });

      res.json({ updated: result.affectedRows ?? deviceIds.length, skipped, until });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ── POST /api/devices/:id/maintenance ────────────────────────────────────────
// Toggle maintenance mode for a device. While enabled=true, this device's
// alerts (routes/alerts.js evaluateAlerts) and device-scoped webhooks
// (services/webhook.js fire) are suppressed entirely — no triggered-log
// entries, no admin notifications, no outbound webhook deliveries — until
// it's marked ok (enabled=false) again.
router.post('/:id/maintenance',
  requireRole('admin', 'operator'),
  param('id').isUUID(),
  body('enabled').isBoolean(),
  body('note').optional({ nullable: true }).trim().isLength({ max: 255 }),
  body('duration_minutes').optional({ nullable: true }).isInt({ min: 1, max: MAX_MAINTENANCE_MINUTES }),
  body('until').optional({ nullable: true }).isInt({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid request', details: errors.array() });

    try {
      // SECURITY FIX: this used to fetch by id alone — same class of bug as
      // approve-registration above. Scope to this org so an admin/operator
      // of one tenant can't toggle maintenance mode on another tenant's
      // device just by knowing/guessing its UUID.
      const device = await queryOne('SELECT id, name, group_id, maintenance_mode FROM devices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!device) return res.status(404).json({ error: 'Device not found' });

      // SECURITY: operators are restricted to devices in their accessible
      // groups (same rule as GET /:id and actions/exec).
      if (req.user.role !== 'admin') {
        const access = await queryOne(
          'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
          [req.user.id, device.group_id]
        );
        if (!access) return res.status(403).json({ error: 'Access denied to this device' });
      }

      const enabled = !!req.body.enabled;
      const note    = req.body.note || null;
      const now     = Math.floor(Date.now() / 1000);
      const until   = enabled ? resolveMaintenanceUntil(req.body, now) : null;

      await execute(
        `UPDATE devices
           SET maintenance_mode = ?, maintenance_note = ?,
               maintenance_since = ?, maintenance_by = ?, maintenance_until = ?
         WHERE id = ? AND org_id = ?`,
        [enabled ? 1 : 0, enabled ? note : null,
         enabled ? now : null, enabled ? req.user.id : null, until,
         req.params.id, req.orgId]
      );

      // Drop the webhook service's cached maintenance flag for this device
      // immediately — otherwise a stale "not under maintenance" value could
      // linger for up to MAINTENANCE_TTL_MS and let one more event slip
      // through right after the operator flips the switch.
      require('../services/webhook').invalidateMaintenanceCache(req.params.id);

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: enabled ? 'enable_maintenance_mode' : 'disable_maintenance_mode',
        targetType: 'device', targetId: req.params.id, targetName: device.name,
        ipSource: req.realIp || req.ip, result: 'success',
        details: `[${req.user.role}] ${enabled ? (note || 'Maintenance mode enabled') : 'Maintenance mode disabled'}` +
                 (until ? ` (auto-clears ${new Date(until * 1000).toISOString()})` : ''),
      });

      const updated = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      res.json(sanitizeDevice(updated));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// Add this endpoint to routes/devices.js
// POST /api/devices/:id/approve-registration — Approve a pending agent registration
// This endpoint finalizes the device registration and marks it as approved

// Add this to the device routes (after the standard CRUD endpoints)
//
// BUG FIX: this used to re-declare `const { requireRole } = require(...)`,
// which is already declared earlier in this file (used by POST/PUT/DELETE
// above). Re-declaring the same const in the same module scope is a hard
// SyntaxError ("Identifier 'requireRole' has already been declared") that
// prevented this file — and therefore the whole server — from loading at
// all. requireRole is already in scope here from the top of the file.

// ── POST /api/devices/:id/approve-registration ─────────────────────────────────
// Admin approves a device that was registered by an agent
// Sets up default group assignment and marks device as properly configured
//
// SECURITY FIX: this used to fetch/update the device by id alone, with no
// org_id check — requireRole('admin') only confirms the caller is an admin
// of *some* org, not necessarily this device's org (the whole app is
// multi-tenant; see middleware/tenant.js). Any admin who knew or guessed a
// pending device's UUID could approve/edit a different tenant's device.
// Also validates that group_id (if provided) belongs to the same org,
// otherwise a device could be moved into another tenant's group.
router.post('/:id/approve-registration', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid id' });

  try {
    const deviceId = req.params.id;
    const { name, os_type, ip_address, mac_address, group_id } = req.body;

    // Get the device first — scoped to this org.
    const device = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [deviceId, req.orgId]);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    if (group_id) {
      const group = await queryOne('SELECT id FROM `groups` WHERE id = ? AND org_id = ?', [group_id, req.orgId]);
      if (!group) return res.status(400).json({ error: 'Group not found' });
    }

    // Update device with approved information
    const normalizedMac = mac_address ? normaliseMac(mac_address) : device.mac_address;
    const now = Math.floor(Date.now() / 1000);

    await execute(
      `UPDATE devices 
       SET name=?, os_type=?, ip_address=?, mac_address=?, group_id=?, 
           status='unknown', last_approved_at=?, updated_at=?
       WHERE id=? AND org_id=?`,
      [
        name || device.name,
        os_type || device.os_type,
        ip_address || device.ip_address,
        normalizedMac,
        group_id || device.group_id || null,
        now,
        now,
        deviceId,
        req.orgId
      ]
    );

    // Log audit trail
    await audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: 'approve_device_registration',
      targetType: 'device',
      targetId: deviceId,
      targetName: name || device.name,
      ipSource: req.realIp,
      result: 'success',
      details: `Approved agent registration from ${ip_address || device.ip_address}`
    });

    // Fire webhook for device approval
    require('../services/webhook').fire('device.approved', {
      device_id: deviceId,
      device_name: name || device.name,
      ip: ip_address || device.ip_address,
      severity: 'info',
      message: `Device "${name || device.name}" approved and registered`,
    }).catch(() => {});

    // Return the updated device
    const updatedDevice = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [deviceId, req.orgId]);
    res.json(sanitizeDevice(updatedDevice));

  } catch (e) {
    console.error('[devices/approve-registration]', e.message);
    res.status(500).json({ error: 'Approval failed: ' + e.message });
  }
});

// ── PUT /api/devices/bulk-update — Edit shared fields across many devices ───
//
//  Accepts: { deviceIds: [uuid, ...], updates: { group_id?, os_type?,
//             ssh_username?, ssh_password?, ssh_key?, rpc_username?, rpc_password? } }
//
//  Only keys PRESENT in `updates` are touched — this lets the caller change
//  just the group, or just credentials, without clobbering every device's
//  other fields. This must be registered before PUT /:id, otherwise Express
//  would match "bulk-update" as an :id param and 400 on the UUID check.
//
//  Security: admin-only (same as single-device edit). Credentials are
//  encrypted the same way as the single-device PUT route below.
router.put('/bulk-update',
  requireRole('admin'),
  body('deviceIds').isArray({ min: 1, max: 500 }).withMessage('deviceIds must be an array of 1–500 items'),
  body('deviceIds.*').isUUID().withMessage('Invalid device id'),
  body('updates').isObject().withMessage('updates must be an object'),
  body('updates.group_id').optional({ nullable: true }).custom(v => !v || /^[0-9a-f-]{36}$/i.test(v)).withMessage('Invalid group_id'),
  body('updates.os_type').optional().isIn(['windows', 'linux']),
  body('updates.ssh_username').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('updates.ssh_password').optional({ nullable: true }).isLength({ max: 500 }),
  body('updates.ssh_key').optional({ nullable: true }).isLength({ max: 10000 }),
  body('updates.rpc_username').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('updates.rpc_password').optional({ nullable: true }).isLength({ max: 500 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { deviceIds, updates } = req.body;
    const ALLOWED = ['group_id', 'os_type', 'ssh_username', 'ssh_password', 'ssh_key', 'rpc_username', 'rpc_password'];
    const fields = Object.keys(updates || {}).filter(k => ALLOWED.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    try {
      if (updates.group_id) {
        const g = await queryOne('SELECT id FROM `groups` WHERE id = ? AND org_id = ?', [updates.group_id, req.orgId]);
        if (!g) return res.status(400).json({ error: 'Group not found' });
      }

      const setClauses = [];
      const values = [];
      if (fields.includes('group_id'))     { setClauses.push('group_id = ?');     values.push(updates.group_id || null); }
      if (fields.includes('os_type'))      { setClauses.push('os_type = ?');      values.push(updates.os_type); }
      if (fields.includes('ssh_username')) { setClauses.push('ssh_username = ?'); values.push(updates.ssh_username || null); }
      if (fields.includes('ssh_password')) { setClauses.push('ssh_password = ?'); values.push(updates.ssh_password ? encrypt(updates.ssh_password) : null); }
      if (fields.includes('ssh_key'))      { setClauses.push('ssh_key = ?');      values.push(updates.ssh_key ? encrypt(updates.ssh_key) : null); }
      if (fields.includes('rpc_username')) { setClauses.push('rpc_username = ?'); values.push(updates.rpc_username || null); }
      if (fields.includes('rpc_password')) { setClauses.push('rpc_password = ?'); values.push(updates.rpc_password ? encrypt(updates.rpc_password) : null); }
      const now = Math.floor(Date.now() / 1000);
      setClauses.push('updated_at = ?');
      values.push(now);

      // SECURITY FIX: this used to run `WHERE id IN (...)` with no org
      // filter at all — an admin of one org could pass another tenant's
      // device UUIDs (guessed, leaked, or from an old session) and edit
      // their credentials/group in bulk. Scoping by org_id here means the
      // update can only ever touch devices in the caller's active org;
      // any ids that don't belong to it are silently excluded rather than
      // acted on, and affectedRows below reflects the real count.
      const placeholders = deviceIds.map(() => '?').join(',');
      const result = await execute(
        `UPDATE devices SET ${setClauses.join(', ')} WHERE id IN (${placeholders}) AND org_id = ?`,
        [...values, ...deviceIds, req.orgId]
      );

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'bulk_edit_devices', targetType: 'device', targetId: null,
        targetName: `${deviceIds.length} device(s)`, ipSource: req.realIp, result: 'success',
        details: `Updated fields: ${fields.join(', ')}`,
      });

      res.json({ updated: result.affectedRows ?? deviceIds.length, fields });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ── PUT /api/devices/:id — Update device ────────────────────────────────────
// ENHANCED: Updated endpoint to handle agent registration updates
router.put('/:id', requireRole('admin'), param('id').isUUID(), deviceValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const deviceId = req.params.id;
    const {
      name, ip_address, mac_address, os_type, group_id,
      ssh_username, ssh_password, ssh_key,
      rpc_username, rpc_password,
    } = req.body;

    // Check device exists (and belongs to the active org)
    const device = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [deviceId, req.orgId]);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    // SECURITY: group_id must belong to this same org, otherwise a device
    // could be reassigned into another tenant's group.
    if (group_id) {
      const group = await queryOne('SELECT id FROM `groups` WHERE id = ? AND org_id = ?', [group_id, req.orgId]);
      if (!group) return res.status(400).json({ error: 'Group not found' });
    }

    const normalizedMac = normaliseMac(mac_address || device.mac_address);
    const now = Math.floor(Date.now() / 1000);

    // Update device
    await execute(
      `UPDATE devices
       SET name=?, ip_address=?, mac_address=?, os_type=?, group_id=?,
           ssh_username=?, ssh_password=?, ssh_key=?,
           rpc_username=?, rpc_password=?, updated_at=?
       WHERE id=? AND org_id=?`,
      [
        name,
        ip_address,
        normalizedMac,
        os_type,
        group_id || null,
        ssh_username || null,
        ssh_password ? encrypt(ssh_password) : (req.body.ssh_password === null ? null : device.ssh_password),
        ssh_key ? encrypt(ssh_key) : (req.body.ssh_key === null ? null : device.ssh_key),
        rpc_username || null,
        rpc_password ? encrypt(rpc_password) : (req.body.rpc_password === null ? null : device.rpc_password),
        now,
        deviceId,
        req.orgId
      ]
    );

    await audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: 'edit_device',
      targetType: 'device',
      targetId: deviceId,
      targetName: name,
      ipSource: req.realIp,
      result: 'success',
    });

    const updated = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [deviceId, req.orgId]);
    res.json(sanitizeDevice(updated));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;