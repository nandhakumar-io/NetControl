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
  // ssh_username and rpc_username are left in 'safe' — they are not secrets
  return safe;
}

// GET /api/devices
router.get('/', async (req, res) => {
  try {
    const devices = await query(
      'SELECT d.*, g.name as group_name FROM devices d LEFT JOIN `groups` g ON g.id = d.group_id ORDER BY d.name'
    );
    res.json(devices.map(sanitizeDevice));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/devices/:id
router.get('/:id', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const device = await queryOne(
      'SELECT d.*, g.name as group_name FROM devices d LEFT JOIN `groups` g ON g.id = d.group_id WHERE d.id = ?',
      [req.params.id]
    );
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(sanitizeDevice(device));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const deviceValidation = [
  body('name').trim().notEmpty().isLength({ max: 100 }),
  body('ip_address').isIP(),
  body('mac_address').matches(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/),
  body('os_type').isIn(['windows', 'linux']),
  body('group_id').optional({ nullable: true }).custom(v => !v || /^[0-9a-f-]{36}$/i.test(v)).withMessage('Invalid group_id'),
  // SSH (Linux)
  body('ssh_username').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('ssh_password').optional({ nullable: true }).isLength({ max: 500 }),
  body('ssh_key').optional({ nullable: true }).isLength({ max: 10000 }),
  // net rpc (Windows)
  body('rpc_username').optional({ nullable: true }).trim().isLength({ max: 100 }),
  body('rpc_password').optional({ nullable: true }).isLength({ max: 500 }),
];

// POST /api/devices
router.post('/', deviceValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const id = uuidv4();
    const {
      name, ip_address, mac_address, os_type, group_id,
      ssh_username, ssh_password, ssh_key,
      rpc_username, rpc_password,
    } = req.body;

    const normalizedMac = mac_address.toUpperCase().replace(/-/g, ':');

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
      targetName: name, ipSource: req.ip, result: 'success',
    });

    const device = await queryOne('SELECT * FROM devices WHERE id = ?', [id]);
    res.status(201).json(sanitizeDevice(device));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/devices/:id
// Password fields: if the request sends a non-empty value → encrypt and save the new one.
//                  if the request sends empty/null        → keep the existing value in DB.
router.put('/:id', param('id').isUUID(), deviceValidation, async (req, res) => {
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

    const normalizedMac = mac_address.toUpperCase().replace(/-/g, ':');

    // Only update a secret column if a new value was explicitly provided
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
      targetName: name, ipSource: req.ip, result: 'success',
    });

    const device = await queryOne('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    res.json(sanitizeDevice(device));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/devices/:id
router.delete('/:id', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const device = await queryOne('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    await execute('DELETE FROM devices WHERE id = ?', [req.params.id]);
    await audit.log({
      userId: req.user.id, username: req.user.username,
      action: 'delete_device', targetType: 'device', targetId: req.params.id,
      targetName: device.name, ipSource: req.ip, result: 'success',
    });
    res.json({ message: 'Device deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/devices/poll-all  — on-demand full poll (must be before /:id routes)
router.post('/poll-all', async (req, res) => {
  try {
    const { pollAll } = require('../services/statusPoller');
    pollAll().catch(console.error);
    res.json({ message: 'Full poll triggered' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/devices/:id/poll  — on-demand status refresh for a single device
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
