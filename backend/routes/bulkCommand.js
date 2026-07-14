// routes/bulkCommand.js — "run this one command across N devices and
// watch the results stream in live, retry the ones that failed."
//
// Same trust bar as routes/actions.js's /exec (arbitrary shell/PowerShell
// on real infrastructure): admin/operator only, org + group scoped, PIN
// confirmed, rate limited, fully audited per-device via services/bulkCommand.js.
'use strict';
const crypto = require('crypto');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireActionPin, requireRole } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const { actionLimiter } = require('../middleware/rateLimiter');
const { decrypt } = require('../services/crypto');
const bulkCommand = require('../services/bulkCommand');

const router = express.Router();
router.use(requireAuth, requireOrgContext, requireRole('admin', 'operator'));

function hashCommand(command) {
  return crypto.createHash('sha256').update(command).digest('hex');
}

// Fire-and-forget upsert into the org's command history — never allowed to
// slow down or fail a run itself, same pattern as audit.log() elsewhere.
async function recordHistory(orgId, command, userId, username) {
  try {
    const hash = hashCommand(command);
    const existing = await queryOne(
      'SELECT id FROM bulk_command_history WHERE org_id = ? AND command_hash = ?',
      [orgId, hash]
    );
    if (existing) {
      await execute(
        'UPDATE bulk_command_history SET run_count = run_count + 1, last_used_at = NOW() WHERE id = ?',
        [existing.id]
      );
    } else {
      await execute(
        `INSERT INTO bulk_command_history
           (id, org_id, command, command_hash, run_count, is_favorite, created_by, created_by_username, created_at, last_used_at)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?, NOW(), NOW())`,
        [uuidv4(), orgId, command, hash, userId, username]
      );
    }
  } catch (e) {
    console.error('[BulkCommand] Failed to record command history:', e.message);
  }
}

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

    recordHistory(req.orgId, command, req.user.id, req.user.username); // fire-and-forget

    res.status(201).json({ runId, total: accessible.length, skipped });
  }
);

// ── Command history / favorites ─────────────────────────────────────────
// GET /api/bulk-command/history — favorites first (most recently used
// favorite first), then everything else by recency. Capped so the dropdown
// stays fast/scannable rather than becoming a dumping ground of every
// one-off command anyone in the org has ever run.
router.get('/history', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, command, run_count, is_favorite, created_by_username, last_used_at
         FROM bulk_command_history
        WHERE org_id = ?
        ORDER BY is_favorite DESC, last_used_at DESC
        LIMIT 30`,
      [req.orgId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bulk-command/history/:id/favorite — toggle. Body: { favorite: bool }
router.post('/history/:id/favorite',
  [param('id').isUUID(), body('favorite').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const row = await queryOne('SELECT id FROM bulk_command_history WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      await execute('UPDATE bulk_command_history SET is_favorite = ? WHERE id = ?', [req.body.favorite ? 1 : 0, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// DELETE /api/bulk-command/history/:id — remove a single history entry
// (e.g. a mistyped or sensitive one-off command someone doesn't want
// lingering in the shared org dropdown).
router.delete('/history/:id', param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const result = await execute('DELETE FROM bulk_command_history WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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