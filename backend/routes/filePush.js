// routes/filePush.js — Batch SCP file push endpoint
// POST /api/file-push
//   multipart/form-data:
//     file        — the file to push (required)
//     remotePath  — destination path on each device (required, e.g. /tmp/script.sh)
//     actionPin   — current action PIN (required)
//     deviceIds   — JSON array of device UUIDs (optional, one of deviceIds/groupId required)
//     groupId     — UUID of group to push to all devices (optional)
//     fileMode    — octal string e.g. "0755" (optional, default "0644")

const express = require('express');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');

const { requireAuth, requireActionPin } = require('../middleware/auth');
const { query, queryOne }               = require('../db');
const { decrypt }                       = require('../services/crypto');
const { scpPushMany }                   = require('../services/scpPush');
const audit                             = require('../services/audit');

const router = express.Router();
router.use(requireAuth);

// multer: memory storage, 50 MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
});

function decryptDevice(d) {
  return {
    ...d,
    _ssh_password:   decrypt(d.ssh_password),
    _ssh_key:        decrypt(d.ssh_key),
    _winrm_password: decrypt(d.winrm_password),
  };
}

router.post(
  '/',
  upload.single('file'),
  [
    body('remotePath').notEmpty().isString().isLength({ max: 500 }),
    body('actionPin').notEmpty().isString(),
    body('deviceIds').optional().isString(),
    body('groupId').optional().isUUID(),
    body('fileMode').optional().isString().matches(/^0[0-7]{3}$/),
  ],
  requireActionPin,
  async (req, res) => {
    // Validate
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { remotePath, groupId, fileMode = '0644' } = req.body;
    const mode = parseInt(fileMode, 8);

    // Parse deviceIds
    let rawDeviceIds = [];
    if (req.body.deviceIds) {
      try { rawDeviceIds = JSON.parse(req.body.deviceIds); }
      catch { return res.status(400).json({ error: 'deviceIds must be a JSON array' }); }
    }

    if (!rawDeviceIds.length && !groupId) {
      return res.status(400).json({ error: 'Provide deviceIds or groupId' });
    }

    // Load devices
    let devices = [];
    try {
      if (rawDeviceIds.length) {
        // fetch each specified device
        const placeholders = rawDeviceIds.map(() => '?').join(',');
        const rows = await query(
          `SELECT * FROM devices WHERE id IN (${placeholders})`,
          rawDeviceIds
        );
        devices = rows;
      } else {
        // all devices in the group
        const group = await queryOne('SELECT id FROM `groups` WHERE id = ?', [groupId]);
        if (!group) return res.status(404).json({ error: 'Group not found' });
        devices = await query('SELECT * FROM devices WHERE group_id = ?', [groupId]);
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    if (!devices.length) return res.status(400).json({ error: 'No devices found for target' });

    // Decrypt credentials
    const decrypted = devices.map(decryptDevice);

    // Push file
    const results = await scpPushMany(
      decrypted,
      req.file.buffer,
      remotePath,
      mode
    );

    // Audit each result
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
