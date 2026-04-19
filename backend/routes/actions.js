// routes/actions.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, queryOne } = require('../db');
const { requireAuth, requireActionPin } = require('../middleware/auth');
const { actionLimiter } = require('../middleware/rateLimiter');
const { decrypt } = require('../services/crypto');
const { wake } = require('../services/wol');
const ssh = require('../services/ssh');
const winrm = require('../services/winrm');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, actionLimiter);

async function loadDevice(id) {
  const d = await queryOne('SELECT * FROM devices WHERE id = ?', [id]);
  if (!d) return null;
  return {
    ...d,
    _ssh_password:   decrypt(d.ssh_password),
    _ssh_key:        decrypt(d.ssh_key),
    _winrm_password: decrypt(d.winrm_password),
  };
}

async function performAction(action, device) {
  if (action === 'wake') {
    await wake(device.mac_address);
    return 'wake packet sent';
  }
  if (action === 'shutdown') {
    if (device.os_type === 'linux') await ssh.shutdown(device);
    else await winrm.shutdown(device);
    return 'shutdown command sent';
  }
  if (action === 'restart') {
    if (device.os_type === 'linux') await ssh.restart(device);
    else await winrm.restart(device);
    return 'restart command sent';
  }
  throw new Error(`Unknown action: ${action}`);
}

function actionRoute(action) {
  return [
    body('actionPin').notEmpty().isString(),
    body('deviceId').optional().isUUID(),
    body('groupId').optional().isUUID(),
    requireActionPin,
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { deviceId, groupId } = req.body;
      if (!deviceId && !groupId)
        return res.status(400).json({ error: 'deviceId or groupId required' });

      // SECURITY FIX: Operators can only act on devices in their accessible groups (IDOR prevention)
      let devices = [];
      if (deviceId) {
        const d = await loadDevice(deviceId);
        if (!d) return res.status(404).json({ error: 'Device not found' });
        if (req.user.role === 'operator') {
          const access = await queryOne(
            'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
            [req.user.id, d.group_id]
          );
          if (!access) return res.status(403).json({ error: 'Access denied to this device' });
        }
        devices = [d];
      } else {
        const group = await queryOne('SELECT * FROM `groups` WHERE id = ?', [groupId]);
        if (!group) return res.status(404).json({ error: 'Group not found' });
        if (req.user.role === 'operator') {
          const access = await queryOne(
            'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
            [req.user.id, groupId]
          );
          if (!access) return res.status(403).json({ error: 'Access denied to this group' });
        }
        const rows = await query('SELECT * FROM devices WHERE group_id = ?', [groupId]);
        devices = rows.map(d => ({
          ...d,
          _ssh_password:   decrypt(d.ssh_password),
          _ssh_key:        decrypt(d.ssh_key),
          _winrm_password: decrypt(d.winrm_password),
        }));
      }

      if (!devices.length) return res.status(400).json({ error: 'No devices found for target' });

      const results = [];
      let overall = 'success';

      for (const device of devices) {
        let result = 'success', details = '';
        try {
          details = await performAction(action, device);
        } catch (e) {
          result = 'failure';
          details = e.message;
          if (overall === 'success') overall = 'partial';
        }
        await audit.log({ userId: req.user.id, username: req.user.username,
          action, targetType: 'device', targetId: device.id,
          targetName: device.name, ipSource: req.realIp, result, details });
        results.push({ device: device.name, id: device.id, result, details });
      }

      if (results.every(r => r.result === 'failure')) overall = 'failure';
      res.json({ action, results, overall });
    },
  ];
}

router.post('/wake',     actionRoute('wake'));
router.post('/shutdown', actionRoute('shutdown'));
router.post('/restart',  actionRoute('restart'));

router.post('/exec',
  body('actionPin').notEmpty().isString(),
  body('deviceId').isUUID(),
  body('command').notEmpty().isString().isLength({ max: 500 }),
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const device = await loadDevice(req.body.deviceId);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    // SECURITY FIX: Operators can only exec on their accessible devices
    if (req.user.role === 'operator') {
      const access = await queryOne(
        'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
        [req.user.id, device.group_id]
      );
      if (!access) return res.status(403).json({ error: 'Access denied to this device' });
    }

    let result = 'success', output = '';
    try {
      const r = device.os_type === 'linux'
        ? await ssh.execCommand(device, req.body.command)
        : await winrm.execCommand(device, req.body.command);
      output = r.stdout;
    } catch (e) { result = 'failure'; output = e.message; }

    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'exec_command', targetType: 'device', targetId: device.id,
      targetName: device.name, ipSource: req.realIp, result,
      details: `CMD: ${req.body.command}` });

    res.json({ result, output });
  }
);

module.exports = router;
