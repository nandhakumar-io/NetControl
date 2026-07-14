// routes/bulkCommand.js — "run this one command across N devices and
// watch the results stream in live, retry the ones that failed."
//
// Same trust bar as routes/actions.js's /exec (arbitrary shell/PowerShell
// on real infrastructure): admin/operator only, org + group scoped, PIN
// confirmed, rate limited, fully audited per-device via services/bulkCommand.js.
'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query, queryOne } = require('../db');
const { requireAuth, requireActionPin, requireRole } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const { actionLimiter } = require('../middleware/rateLimiter');
const { decrypt } = require('../services/crypto');
const bulkCommand = require('../services/bulkCommand');

const router = express.Router();
router.use(requireAuth, requireOrgContext, requireRole('admin', 'operator'));

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

// ── POST /api/bulk-command/run ────────────────────────────────────────────
// body: { actionPin, command, deviceIds: [...] }  (frontend expands a group
// selection into deviceIds before calling this — keeps the access-control
// logic in one place: per-device, not per-group)
router.post('/run',
  actionLimiter,
  [
    body('actionPin').notEmpty().isString(),
    body('command').notEmpty().isString().isLength({ max: 1000 }),
    body('deviceIds').isArray({ min: 1, max: 200 }),
    body('deviceIds.*').isUUID(),
  ],
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { command, deviceIds } = req.body;

    // Load + org/group-scope every device up front — a device that fails
    // this check is reported back as 'skipped' rather than silently
    // dropped, so the console shows why the count doesn't match what was
    // selected instead of the run just looking incomplete.
    const accessible = [];
    const skipped = [];
    for (const id of [...new Set(deviceIds)]) {
      const device = await loadDevice(id);
      if (!device || device.org_id !== req.orgId) { skipped.push({ deviceId: id, reason: 'Device not found' }); continue; }
      if (req.user.role !== 'admin') {
        const access = await queryOne(
          'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
          [req.user.id, device.group_id]
        );
        if (!access) { skipped.push({ deviceId: id, deviceName: device.name, reason: 'Access denied' }); continue; }
      }
      accessible.push(device);
    }

    if (!accessible.length) {
      return res.status(400).json({ error: 'No accessible devices in selection', skipped });
    }

    const runId = bulkCommand.startRun({
      command, devices: accessible, userId: req.user.id, username: req.user.username, orgId: req.orgId,
    });

    res.status(201).json({ runId, total: accessible.length, skipped });
  }
);

// ── GET /api/bulk-command/:runId/stream — SSE, connect any time during or
// shortly after the run; replays everything so far then streams live ─────
router.get('/:runId/stream', param('runId').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  // getJob is now backed by Redis (see services/bulkCommand.js) so this
  // finds the job regardless of which cluster worker actually ran it —
  // previously an in-memory-only Map here meant this request could 404
  // just because it landed on a different worker than POST /run did,
  // leaving the console stuck showing every device as "pending" forever.
  const job = await bulkCommand.getJob(req.params.runId);
  if (!job || job.orgId !== req.orgId) return res.status(404).json({ error: 'Run not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const unsub = await bulkCommand.attachStream(req.params.runId, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    bulkCommand.detachStream(req.params.runId, unsub);
  });
});

// ── GET /api/bulk-command/devices — device picker list for the console,
// same shape as GET /api/devices but trimmed to just what the picker needs ─
router.get('/devices', async (req, res) => {
  try {
    const rows = await query(
      `SELECT d.id, d.name, d.ip_address, d.os_type, d.status, d.group_id, g.name AS group_name
         FROM devices d LEFT JOIN \`groups\` g ON g.id = d.group_id
        WHERE d.org_id = ? ORDER BY d.name`,
      [req.orgId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;