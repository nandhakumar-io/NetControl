// routes/filePush.js
// FIX: multer MUST run before requireActionPin — multer populates req.body
// from multipart/form-data so actionPin is available for the PIN check.

const express = require('express');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');

const path = require('path');
const { requireAuth, requireActionPin, requireRole } = require('../middleware/auth');
const { query, queryOne }               = require('../db');
const { decrypt }                       = require('../services/crypto');
const { scpPushMany }                   = require('../services/scpPush');
const audit                             = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
});

function decryptDevice(d) {
  const sshPw   = decrypt(d.ssh_password);
  const winrmPw = decrypt(d.winrm_password);
  return {
    ...d,
    _ssh_password:       sshPw   || winrmPw || null,  // winrm fallback
    _ssh_key:            decrypt(d.ssh_key),
    _winrm_password:     winrmPw,
    _effective_username: d.ssh_username || d.winrm_username || null,
  };
}

router.post(
  '/',
  // ① multer first — populates req.body from multipart form
  upload.single('file'),
  // ② validation
  [
    body('remotePath').notEmpty().isString().isLength({ max: 500 })
      // SECURITY FIX: Prevent path traversal — reject any path containing '..'
      .custom(v => {
        const normalised = path.posix.normalize(v);
        if (normalised.includes('..')) throw new Error('Path traversal not allowed');
        return true;
      }),
    body('actionPin').notEmpty().isString(),
    // SECURITY FIX: Validate each deviceId is a UUID to prevent injection
    body('deviceIds').optional().isString(),
    body('groupId').optional().isUUID(),
    body('fileMode').optional().isString().matches(/^0[0-7]{3}$/),
  ],
  // ③ PIN check — req.body.actionPin is now available
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { remotePath, groupId, fileMode = '0644' } = req.body;
    const mode = parseInt(fileMode, 8);

    let rawDeviceIds = [];
    if (req.body.deviceIds) {
      try { rawDeviceIds = JSON.parse(req.body.deviceIds); }
      catch { return res.status(400).json({ error: 'deviceIds must be a JSON array' }); }
    }

    if (!rawDeviceIds.length && !groupId) {
      return res.status(400).json({ error: 'Provide deviceIds or groupId' });
    }

    // SECURITY FIX: Validate each deviceId is a UUID format
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (rawDeviceIds.some(id => !UUID_RE.test(String(id)))) {
      return res.status(400).json({ error: 'deviceIds must all be valid UUIDs' });
    }

    let devices = [];
    try {
      if (rawDeviceIds.length) {
        const placeholders = rawDeviceIds.map(() => '?').join(',');
        if (req.user.role === 'operator') {
          // SECURITY FIX: Operators can only push to devices in their accessible groups (IDOR)
          devices = await query(
            `SELECT d.* FROM devices d
             INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ?
             WHERE d.id IN (${placeholders})`,
            [req.user.id, ...rawDeviceIds]
          );
          if (devices.length !== rawDeviceIds.length)
            return res.status(403).json({ error: 'One or more devices are not in your accessible groups' });
        } else {
          devices = await query(
            `SELECT * FROM devices WHERE id IN (${placeholders})`,
            rawDeviceIds
          );
        }
      } else {
        const group = await queryOne('SELECT id FROM `groups` WHERE id = ?', [groupId]);
        if (!group) return res.status(404).json({ error: 'Group not found' });
        if (req.user.role === 'operator') {
          // SECURITY FIX: Operators can only push to their accessible groups
          const access = await queryOne(
            'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
            [req.user.id, groupId]
          );
          if (!access) return res.status(403).json({ error: 'Access denied to this group' });
        }
        devices = await query('SELECT * FROM devices WHERE group_id = ?', [groupId]);
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    if (!devices.length) return res.status(400).json({ error: 'No devices found for target' });

    const decrypted = devices.map(decryptDevice);
    const results   = await scpPushMany(decrypted, req.file.buffer, remotePath, mode);

    for (const r of results) {
      const dev = devices.find(d => d.name === r.device || d.ip_address === r.device);
      await audit.log({
        userId:     req.user.id,
        username:   req.user.username,
        action:     'file_push',
        targetType: 'device',
        targetId:   dev?.id || 'unknown',
        targetName: r.device,
        ipSource:   req.ip,
        result:     r.result,
        details:    `File: ${req.file.originalname} → ${remotePath} | ${r.details}`,
      });
    }

    const overall =
      results.every(r => r.result === 'failure') ? 'failure' :
      results.every(r => r.result === 'success') ? 'success' : 'partial';

    res.json({
      file:       req.file.originalname,
      remotePath,
      results,
      overall,
      pushed:     results.filter(r => r.result === 'success').length,
      failed:     results.filter(r => r.result === 'failure').length,
    });
  }
);

module.exports = router;
