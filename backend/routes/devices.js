// routes/devices.js
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
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

// ── Tags helper ───────────────────────────────────────────────────────────────
// device_tags is a separate join table (not a JSON column on devices) so
// filtering by tag can use a real index instead of a LIKE scan, and so
// "distinct tags in this org" is a cheap GROUP BY instead of parsing JSON
// out of every device row.
const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,49}$/i;

async function attachTags(devices) {
  if (!devices.length) return devices;
  const ids = devices.map(d => d.id);
  const rows = await query(
    `SELECT device_id, tag FROM device_tags WHERE device_id IN (${ids.map(() => '?').join(',')}) ORDER BY tag`,
    ids
  );
  const byDevice = new Map();
  for (const r of rows) {
    if (!byDevice.has(r.device_id)) byDevice.set(r.device_id, []);
    byDevice.get(r.device_id).push(r.tag);
  }
  return devices.map(d => ({ ...d, tags: byDevice.get(d.id) || [] }));
}

// ── GET /api/devices ─────────────────────────────────────────────────────────
// ?tags=prod,k8s-node — optional ad-hoc filter, matches devices carrying ANY
// of the listed tags (tags are freeform labels independent of the group
// hierarchy, meant for exactly this kind of cross-cutting slice).
router.get('/', async (req, res) => {
  try {
    const tagFilter = (req.query.tags || '').split(',').map(t => t.trim()).filter(Boolean);
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
    devices = await attachTags(devices);
    if (tagFilter.length) {
      devices = devices.filter(d => d.tags.some(t => tagFilter.includes(t)));
    }
    res.json(devices.map(sanitizeDevice));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/devices/tags ────────────────────────────────────────────────────
// Distinct tag list for the org, with usage counts — powers the autocomplete
// / tag-cloud filter bar. Must stay registered before GET /:id below, or
// Express would try to match "tags" against the :id param (and 400 it, since
// it's not a UUID).
router.get('/tags', async (req, res) => {
  try {
    const rows = await query(
      `SELECT dt.tag, COUNT(*) AS device_count
         FROM device_tags dt
         JOIN devices d ON d.id = dt.device_id
        WHERE d.org_id = ?
        GROUP BY dt.tag ORDER BY dt.tag`,
      [req.orgId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/devices/health-scores ───────────────────────────────────────────
// Composite 0-100 score per device — see services/deviceHealthScore.js for
// exactly what goes into it. Fetched once by the Devices page and merged into
// the device list client-side (kept as its own endpoint rather than baked
// into GET /, so a page that doesn't need it — e.g. a device picker in
// Backup/Bulk Command — doesn't pay for alert/compliance/forecast/uptime
// queries on every load).
// Must stay registered before GET /:id below, same reasoning as /tags.
router.get('/health-scores', async (req, res) => {
  try {
    const { computeHealthScores } = require('../services/deviceHealthScore');
    const scores = await computeHealthScores(req.orgId);

    // Non-admins only see scores for devices in groups they've been granted
    // access to — same restriction GET / and GET /:id already apply.
    if (req.user.role !== 'admin') {
      const allowed = await query(
        'SELECT d.id FROM devices d INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? WHERE d.org_id = ?',
        [req.user.id, req.orgId]
      );
      const allowedIds = new Set(allowed.map(r => r.id));
      for (const id of Object.keys(scores)) if (!allowedIds.has(id)) delete scores[id];
    }

    res.json(scores);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/devices/wake-eligibility ────────────────────────────────────────
// Per-device WoL relay routing decision (services/wol.js#checkEligibility),
// computed WITHOUT sending any packet — powers a "Wake-capable via: <agent>"
// indicator on the Devices page so an operator can see before clicking Wake
// whether a relay path exists at all, instead of only finding out after a
// click produces a silent "direct" fallback that never reaches a
// cross-subnet device. Fetched as its own endpoint (same reasoning as
// /health-scores above) since it touches every other online device's IP to
// find relay candidates and shouldn't block the page's first paint.
// Must stay registered before GET /:id below, same reasoning as /tags.
router.get('/wake-eligibility', async (req, res) => {
  try {
    const { checkEligibility } = require('../services/wol');
    let devices = await query(
      'SELECT id, ip_address, group_id FROM devices WHERE org_id = ?',
      [req.orgId]
    );
    if (req.user.role !== 'admin') {
      const allowed = await query(
        'SELECT d.id FROM devices d INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? WHERE d.org_id = ?',
        [req.user.id, req.orgId]
      );
      const allowedIds = new Set(allowed.map(r => r.id));
      devices = devices.filter(d => allowedIds.has(d.id));
    }

    const results = {};
    for (const d of devices) {
      try {
        const r = await checkEligibility(d);
        results[d.id] = r.method === 'relay'
          ? { method: 'relay', relayAgent: r.relayAgent.name }
          : { method: r.method };
      } catch {
        results[d.id] = { method: 'none' };
      }
    }
    res.json(results);
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
    const [withTags] = await attachTags([device]);
    res.json(sanitizeDevice(withTags));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/devices/:id/tags — replace the full tag set in one call ────────
// Body: { tags: ["prod", "needs-review"] }. Simplest shape for a chip-editor
// UI that just diffs and re-sends the whole set rather than issuing
// individual add/remove calls per keystroke.
router.put('/:id/tags', requireRole('admin', 'operator'), param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const device = await queryOne('SELECT id FROM devices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const tags = Array.isArray(req.body.tags) ? req.body.tags : [];
    const clean = [...new Set(tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))];
    for (const t of clean) {
      if (!TAG_RE.test(t)) return res.status(400).json({ error: `Invalid tag "${t}" — letters, numbers, "-", "_" only, 1-50 chars` });
    }

    await execute('DELETE FROM device_tags WHERE device_id = ?', [req.params.id]);
    for (const t of clean) {
      await execute(
        'INSERT INTO device_tags (id, device_id, org_id, tag, created_at) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), req.params.id, req.orgId, t, Math.floor(Date.now() / 1000)]
      );
    }
    res.json({ ok: true, tags: clean });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/devices/:id/tags — add a single tag without disturbing others ─
router.post('/:id/tags', requireRole('admin', 'operator'), param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const device = await queryOne('SELECT id FROM devices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const tag = String(req.body.tag || '').trim().toLowerCase();
    if (!TAG_RE.test(tag)) return res.status(400).json({ error: 'Invalid tag — letters, numbers, "-", "_" only, 1-50 chars' });

    await execute(
      'INSERT IGNORE INTO device_tags (id, device_id, org_id, tag, created_at) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), req.params.id, req.orgId, tag, Math.floor(Date.now() / 1000)]
    );
    res.status(201).json({ ok: true, tag });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/devices/:id/tags/:tag ────────────────────────────────────────
router.delete('/:id/tags/:tag', requireRole('admin', 'operator'), param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    await execute(
      'DELETE dt FROM device_tags dt JOIN devices d ON d.id = dt.device_id WHERE dt.device_id = ? AND dt.tag = ? AND d.org_id = ?',
      [req.params.id, String(req.params.tag).toLowerCase(), req.orgId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/devices (single) ───────────────────────────────────────────────
// SECURITY FIX: Only admins can add/edit/delete devices
// requireRole is imported once at the top of the file (alongside requireAuth)
// and used for every admin-only route below, including approve-registration
// and PUT further down the file, as well as the tag routes above.
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

// ── POST /api/devices/:id/reset-host-key ───────────────────────────────────────
// Clears the pinned SSH host key fingerprint (services/sshHostKeys.js TOFU
// pinning) so the next connection re-pins whatever key it sees. Needed
// after a legitimate device reimage, OS reinstall, or hardware swap — any
// of which rotate the host key and would otherwise cause every SSH action
// on this device to be refused as a possible MITM. Admin-only and audited,
// since clearing the pin does briefly re-open the TOFU trust window.
router.post('/:id/reset-host-key', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const device = await queryOne('SELECT id, name FROM devices WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    await execute('UPDATE devices SET ssh_host_key_fingerprint = NULL WHERE id = ?', [req.params.id]);
    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'reset_ssh_host_key', targetType: 'device', targetId: req.params.id,
      targetName: device.name, ipSource: req.realIp, result: 'success',
      details: 'Pinned SSH host key cleared — will re-pin on next connection',
    });
    res.json({ message: 'Host key pin cleared — the next SSH connection will trust and re-pin whatever key it sees.' });
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

// ── POST /api/devices/bulk-agent-update ──────────────────────────────────────
// Queues an immediate agent self-update for the selected devices, instead of
// each agent waiting for its own AUTO_UPDATE poll cooldown (agent/
// netcontrol-agent.js's checkForUpdate() normally waits up to
// UPDATE_RETRY_COOLDOWN_MS, and does nothing at all if AUTO_UPDATE=false).
//
// This is a one-shot, explicit admin action — it doesn't touch or require
// AUTO_UPDATE, and doesn't affect devices that weren't selected. Setting
// agent_update_requested_at just marks the request; the agent picks it up
// on its next metrics POST, where routes/metrics.js's ingest handler folds
// it into the response as `force_update: true` and clears the flag once
// delivered (see routes/metrics.js).
//
// Admin-only: unlike Wake/Shutdown/Restart, this pushes and runs a new
// binary on the device, so it gets the same restriction as
// reset-host-key/bulk-import rather than being open to operators.
router.post('/bulk-agent-update',
  requireRole('admin'),
  body('deviceIds').isArray({ min: 1, max: 500 }).withMessage('deviceIds must be an array of 1–500 items'),
  body('deviceIds.*').isUUID().withMessage('Invalid device id'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid request', details: errors.array() });

    try {
      const { deviceIds } = req.body;
      const now = Math.floor(Date.now() / 1000);
      const placeholders = deviceIds.map(() => '?').join(',');

      // Org-scoped update — same shape as bulk-maintenance below, but no
      // operator carve-out: only admins can reach this route at all.
      const result = await execute(
        `UPDATE devices SET agent_update_requested_at = ?
           WHERE id IN (${placeholders}) AND org_id = ? AND agent_key_hash IS NOT NULL`,
        [now, ...deviceIds, req.orgId]
      );

      const requested = result.affectedRows || 0;
      const skipped = deviceIds.length - requested;

      await audit.log({
        userId: req.user.id, username: req.user.username,
        action: 'bulk_agent_update_request', targetType: 'device', targetId: null,
        targetName: `${requested} device(s)`, ipSource: req.realIp, result: 'success',
        details: `Queued immediate agent update for ${requested} device(s)${skipped ? `, ${skipped} skipped (not agent-managed or not found)` : ''}`,
      });

      res.json({ requested, skipped });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

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
//             ssh_username?, ssh_password?, ssh_key?, rpc_username?, rpc_password?,
//             tags?, tagsMode? } }
//
//  Only keys PRESENT in `updates` are touched — this lets the caller change
//  just the group, or just credentials, without clobbering every device's
//  other fields. This must be registered before PUT /:id, otherwise Express
//  would match "bulk-update" as an :id param and 400 on the UUID check.
//
//  tags is handled separately from the SET-clause fields above because tags
//  live in device_tags (a join table, same reasoning as the single-device
//  tag routes above), not a column on devices. tagsMode controls how the
//  given tags combine with whatever a device already has:
//    - 'add' (default): union — non-destructive, safe as the default for a
//      bulk action so it can't silently wipe tags nobody meant to touch.
//    - 'replace': every selected device ends up with exactly this tag set,
//      same semantics as PUT /:id/tags on a single device.
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
  body('updates.tags').optional().isArray({ max: 20 }).withMessage('At most 20 tags'),
  body('updates.tags.*').optional().isString().isLength({ max: 50 }),
  body('updates.tagsMode').optional().isIn(['add', 'replace']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { deviceIds, updates } = req.body;
    const ALLOWED = ['group_id', 'os_type', 'ssh_username', 'ssh_password', 'ssh_key', 'rpc_username', 'rpc_password'];
    const fields = Object.keys(updates || {}).filter(k => ALLOWED.includes(k));
    const hasTags = Array.isArray(updates.tags) && updates.tags.length > 0;
    if (fields.length === 0 && !hasTags) return res.status(400).json({ error: 'No valid fields to update' });

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

      if (hasTags) {
        const clean = [...new Set(updates.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
        const mode = updates.tagsMode === 'replace' ? 'replace' : 'add';

        // Re-scope to devices that actually belong to this org — same
        // tenant-isolation reasoning as the SECURITY FIX above, applied to
        // the tag writes too.
        const orgRows = await query(
          `SELECT id FROM devices WHERE id IN (${placeholders}) AND org_id = ?`,
          [...deviceIds, req.orgId]
        );
        const orgDeviceIds = orgRows.map(r => r.id);

        if (orgDeviceIds.length) {
          if (mode === 'replace') {
            const delPlaceholders = orgDeviceIds.map(() => '?').join(',');
            await execute(`DELETE FROM device_tags WHERE device_id IN (${delPlaceholders})`, orgDeviceIds);
          }
          if (clean.length) {
            const rows = [];
            for (const deviceId of orgDeviceIds) {
              for (const tag of clean) rows.push(uuidv4(), deviceId, req.orgId, tag, now);
            }
            const rowPlaceholders = orgDeviceIds.flatMap(() => clean.map(() => '(?, ?, ?, ?, ?)')).join(', ');
            // INSERT IGNORE — 'add' mode is a union with whatever a device
            // already has, so re-adding a tag it's already carrying should
            // be a harmless no-op, not a duplicate-key error that aborts
            // the whole batch.
            await execute(
              `INSERT IGNORE INTO device_tags (id, device_id, org_id, tag, created_at) VALUES ${rowPlaceholders}`,
              rows
            );
          }
        }
      }

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

    // Structured before/after diff — powers the Audit page's side-by-side
    // diff view for this event. Only fields that actually changed are
    // included, and credential fields (ssh_password, ssh_key, rpc_password)
    // are reported as changed/unchanged only — their values are secrets
    // and never belong in the audit trail, even encrypted.
    const DIFF_FIELDS = ['name', 'ip_address', 'mac_address', 'os_type', 'group_id'];
    const newValues = { name, ip_address: ip_address, mac_address: normalizedMac, os_type, group_id: group_id || null };
    const changed = {};
    for (const field of DIFF_FIELDS) {
      const before = device[field] ?? null;
      const after = newValues[field] ?? null;
      if (String(before) !== String(after)) changed[field] = { before, after };
    }
    if (ssh_password || ssh_key || rpc_password) {
      changed.credentials = { before: 'unchanged', after: 'updated' };
    }

    await audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: 'edit_device',
      targetType: 'device',
      targetId: deviceId,
      targetName: name,
      ipSource: req.realIp,
      result: 'success',
      details: Object.keys(changed).length ? JSON.stringify({ diff: changed }) : null,
    });

    const updated = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [deviceId, req.orgId]);
    res.json(sanitizeDevice(updated));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;