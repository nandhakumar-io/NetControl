// routes/actions.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const { query, queryOne } = require('../db');
const { requireAuth, requireActionPin, requireRole } = require('../middleware/auth');
const { verifyDeviceOrgAccess } = require('../middleware/tenant');
const { actionLimiter } = require('../middleware/rateLimiter');
const { decrypt } = require('../services/crypto');
const { wakeSmart } = require('../services/wol');
const ssh = require('../services/ssh');
const winrm = require('../services/winrm');
const audit = require('../services/audit');
const webhook = require('../services/webhook');
const { isUnderMaintenance, maintenanceBlockedReason } = require('../services/maintenance');

const router = express.Router();
// SECURITY FIX: requireActionPin checks a single PIN shared by everyone in
// the org — it's a "confirm you meant to do this" step, not an access
// control boundary. Without a role check here, any authenticated user who
// knew the PIN and had ANY user_group_access grant (including a viewer,
// which this app doesn't otherwise treat as a hard boundary against) could
// wake/shutdown/restart devices or run arbitrary shell commands via /exec.
// Restrict the whole router to admin/operator; requireOrgContext/group
// checks below still further narrow *which* devices within that role.
router.use(requireAuth, requireRole('admin', 'operator'), actionLimiter);

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
  // Defense in depth: routes/actions.js's own route handlers already check
  // this before calling performAction (see actionRoute() below), but
  // routes/alerts.js's auto-action path (alert rules configured to
  // auto-wake/restart/shutdown) calls performAction() directly and would
  // otherwise bypass the lock entirely — a device flagged under
  // maintenance should be hands-off from *every* caller, not just the ones
  // that remembered to check first.
  if (isUnderMaintenance(device)) {
    throw new Error(maintenanceBlockedReason(device));
  }
  if (action === 'wake') {
    const result = await wakeSmart(device);
    return result.method === 'relay'
      ? `wake packet relayed via ${result.relayAgent}`
      : 'wake packet sent (direct — no on-subnet relay agent found)';
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

      let devices = [];
      try {
        if (deviceId) {
          const d = await loadDevice(deviceId);
          if (!d) return res.status(404).json({ error: 'Device not found' });
          await verifyDeviceOrgAccess(req, d);
          if (req.user.role !== 'admin') {
            const access = await queryOne(
              'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
              [req.user.id, d.group_id]
            );
            if (!access) return res.status(403).json({ error: 'Access denied to this device' });
          }
          // Enforce the maintenance lock: block here, not just in the UI —
          // this endpoint is what the UI itself calls, and the PIN/API can
          // be hit directly, so the actual restriction has to live here.
          if (isUnderMaintenance(d)) {
            return res.status(409).json({ error: maintenanceBlockedReason(d), code: 'DEVICE_UNDER_MAINTENANCE' });
          }
          devices = [d];
        } else {
          const group = await queryOne('SELECT * FROM `groups` WHERE id = ?', [groupId]);
          if (!group) return res.status(404).json({ error: 'Group not found' });
          const headerOrgId = req.headers?.['x-org-id'];
          const orgId = headerOrgId || req.user?.activeOrgId;
          if (!orgId || group.org_id !== orgId) {
            return res.status(403).json({ error: 'Access denied to this group' });
          }
          if (req.user.role !== 'admin') {
            const access = await queryOne(
              'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
              [req.user.id, groupId]
            );
            if (!access) return res.status(403).json({ error: 'Access denied to this group' });
          }
          const rows = await query('SELECT * FROM devices WHERE group_id = ? AND org_id = ?', [groupId, orgId]);
          devices = rows.map(d => ({
            ...d,
            _ssh_password:   decrypt(d.ssh_password),
            _ssh_key:        decrypt(d.ssh_key),
            _winrm_password: decrypt(d.winrm_password),
          }));
        }
      } catch (e) {
        return res.status(e.status || 500).json({ error: e.message, code: e.code });
      }

      if (!devices.length) return res.status(400).json({ error: 'No devices found for target' });

      const results = [];
      let overall = 'success';

      for (const device of devices) {
        let result = 'success', details = '';
        if (isUnderMaintenance(device)) {
          result = 'skipped';
          details = maintenanceBlockedReason(device);
          if (overall === 'success') overall = 'partial';
          await audit.log({ userId: req.user.id, username: req.user.username,
            action, targetType: 'device', targetId: device.id,
            targetName: device.name, ipSource: req.realIp, result: 'skipped', details });
          results.push({ device: device.name, id: device.id, result, details });
          continue;
        }
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

        if (result === 'success') {
          webhook.fire(`device.${action}`, {
            device_id: device.id, device_name: device.name,
            performed_by: req.user.username, severity: 'info',
            message: `${action} performed on ${device.name} by ${req.user.username}`,
          }).catch(() => {});
        }
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

    try {
      await verifyDeviceOrgAccess(req, device);
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message, code: e.code });
    }

    // SECURITY FIX: Operators can only exec on their accessible devices
    if (req.user.role !== 'admin') {
      const access = await queryOne(
        'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
        [req.user.id, device.group_id]
      );
      if (!access) return res.status(403).json({ error: 'Access denied to this device' });
    }

    if (isUnderMaintenance(device)) {
      return res.status(409).json({ error: maintenanceBlockedReason(device), code: 'DEVICE_UNDER_MAINTENANCE' });
    }

    let result = 'success', output = '';
    try {
      const r = device.os_type === 'linux'
        ? await ssh.execCommand(device, req.body.command)
        : await winrm.execCommand(device, req.body.command);
      output = r.stdout;
    } catch (e) {
      result = 'failure'; output = e.message;
      if (device.os_type === 'linux') {
        webhook.fire('ssh.failure', {
          device_id: device.id, device_name: device.name, error: e.message,
          severity: 'critical', message: `SSH command failed on ${device.name}: ${e.message}`,
        }).catch(() => {});
      }
    }

    await audit.log({ userId: req.user.id, username: req.user.username,
      action: 'exec_command', targetType: 'device', targetId: device.id,
      targetName: device.name, ipSource: req.realIp, result,
      details: `CMD: ${req.body.command}` });

    res.json({ result, output });
  }
);

module.exports = router;
// Exposed so other modules (alert-rule auto-actions in routes/alerts.js) can
// reuse the exact same wake/shutdown/restart implementation instead of
// duplicating it — see performAlertAction() in alerts.js.
module.exports.loadDevice = loadDevice;
module.exports.performAction = performAction;