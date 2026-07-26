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
const { isUnderMaintenance, maintenanceBlockedReason } = require('../services/maintenance');
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

// Fire-and-forget upsert of "which run this user last watched" — the
// cross-browser replacement for the old localStorage pointer. Never
// allowed to slow down or fail a run itself, same pattern as recordHistory
// and audit.log() elsewhere.
async function recordLastRun(userId, runId, orgId) {
  try {
    await execute(
      `INSERT INTO user_last_bulk_run (user_id, run_id, org_id, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE run_id = VALUES(run_id), org_id = VALUES(org_id), updated_at = NOW()`,
      [userId, runId, orgId]
    );
  } catch (e) {
    console.error('[BulkCommand] Failed to record last-run pointer:', e.message);
  }
}

// SECURITY: org_id is filtered in the query itself, not just checked after
// the fact — see middleware/tenant.js's verifyDeviceOrgAccess() comment for
// why relying on a call-site check alone is the pattern that caused the
// cross-tenant device access bug in actions.js/sshProxy.js/webTerminal.js.
// A device belonging to another org now simply doesn't come back as a row.
async function loadDevice(id, orgId) {
  const d = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [id, orgId]);
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
    // Optional override for large/piped commands that legitimately need
    // longer than the 30s default (e.g. `apt update && apt upgrade -y`,
    // multi-stage backups piped through gzip/ssh). Bounds mirror
    // services/bulkCommand.js's MIN/MAX_TIMEOUT_MS so a bad value is
    // rejected here rather than silently clamped deep in execution.
    body('timeoutSec').optional().isInt({ min: 5, max: 3600 }).withMessage('timeoutSec must be between 5 and 3600 seconds'),
  ],
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { command, deviceIds, timeoutSec } = req.body;

    // Load + org/group-scope every device up front — a device that fails
    // this check is reported back as 'skipped' rather than silently
    // dropped, so the console shows why the count doesn't match what was
    // selected instead of the run just looking incomplete.
    const accessible = [];
    const skipped = [];
    for (const id of [...new Set(deviceIds)]) {
      const device = await loadDevice(id, req.orgId);
      if (!device) { skipped.push({ deviceId: id, reason: 'Device not found' }); continue; }
      if (req.user.role !== 'admin') {
        const access = await queryOne(
          'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
          [req.user.id, device.group_id]
        );
        if (!access) { skipped.push({ deviceId: id, deviceName: device.name, reason: 'Access denied' }); continue; }
      }
      // Maintenance lock: devices flagged maintenance_mode=1 (see
      // routes/devices.js's POST /:id/maintenance) are off-limits to every
      // action, including bulk commands, until someone explicitly marks
      // them active/healthy again — skip rather than fail the whole run.
      if (isUnderMaintenance(device)) {
        skipped.push({ deviceId: id, deviceName: device.name, reason: maintenanceBlockedReason(device) });
        continue;
      }
      accessible.push(device);
    }

    if (!accessible.length) {
      return res.status(400).json({ error: 'No accessible devices in selection', skipped });
    }

    const runId = bulkCommand.startRun({
      command, devices: accessible, userId: req.user.id, username: req.user.username, orgId: req.orgId,
      timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
    });

    recordHistory(req.orgId, command, req.user.id, req.user.username); // fire-and-forget
    recordLastRun(req.user.id, runId, req.orgId);                       // fire-and-forget

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

// ── Reusable command + device-list templates ────────────────────────────
// Unlike history (dedupe by command text only), a template also snapshots
// the target device selection, so "Patch Tuesday reboot — branch office
// switches" can be loaded back with one click instead of re-picking
// devices and retyping the command every time. See
// db/migrate-bulk-command-templates.js for the full rationale, including
// how this differs from bulk_command_schedules (cron-unattended runs).
//
// NOTE: like /devices and /active below, this must stay registered before
// GET /:runId — otherwise Express would match "/templates" against the
// ":runId" param first and the isUUID() validator would reject it.

// GET /api/bulk-command/templates — most recently used first
router.get('/templates', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, name, description, command, device_ids, timeout_sec,
              use_count, created_by_username, created_at, last_used_at
         FROM bulk_command_templates
        WHERE org_id = ?
        ORDER BY last_used_at IS NULL, last_used_at DESC, created_at DESC
        LIMIT 50`,
      [req.orgId]
    );
    res.json(rows.map(r => ({ ...r, device_ids: JSON.parse(r.device_ids || '[]') })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bulk-command/templates — save the current console state
// (command + selected device ids) as a named, reusable preset.
router.post('/templates',
  [
    body('name').notEmpty().isString().isLength({ max: 100 }),
    body('description').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('command').notEmpty().isString().isLength({ max: 1000 }),
    body('deviceIds').isArray({ min: 1, max: 200 }),
    body('deviceIds.*').isUUID(),
    body('timeoutSec').optional().isInt({ min: 5, max: 3600 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const existing = await queryOne(
        'SELECT id FROM bulk_command_templates WHERE org_id = ? AND name = ?',
        [req.orgId, req.body.name]
      );
      if (existing) return res.status(409).json({ error: 'A template with that name already exists' });

      const id = uuidv4();
      await execute(
        `INSERT INTO bulk_command_templates
           (id, org_id, name, description, command, device_ids, timeout_sec, created_by, created_by_username, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          id, req.orgId, req.body.name, req.body.description || null,
          req.body.command, JSON.stringify(req.body.deviceIds),
          req.body.timeoutSec || 30, req.user.id, req.user.username,
        ]
      );
      res.status(201).json({ id, ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// PUT /api/bulk-command/templates/:id — overwrite an existing template
// (e.g. the target list drifted and someone re-saves it under the same name).
router.put('/templates/:id',
  [
    param('id').isUUID(),
    body('name').notEmpty().isString().isLength({ max: 100 }),
    body('description').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('command').notEmpty().isString().isLength({ max: 1000 }),
    body('deviceIds').isArray({ min: 1, max: 200 }),
    body('deviceIds.*').isUUID(),
    body('timeoutSec').optional().isInt({ min: 5, max: 3600 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const row = await queryOne('SELECT id FROM bulk_command_templates WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
      if (!row) return res.status(404).json({ error: 'Not found' });

      const dupe = await queryOne(
        'SELECT id FROM bulk_command_templates WHERE org_id = ? AND name = ? AND id != ?',
        [req.orgId, req.body.name, req.params.id]
      );
      if (dupe) return res.status(409).json({ error: 'A template with that name already exists' });

      await execute(
        `UPDATE bulk_command_templates
            SET name = ?, description = ?, command = ?, device_ids = ?, timeout_sec = ?
          WHERE id = ?`,
        [req.body.name, req.body.description || null, req.body.command, JSON.stringify(req.body.deviceIds), req.body.timeoutSec || 30, req.params.id]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// DELETE /api/bulk-command/templates/:id
router.delete('/templates/:id', param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const result = await execute('DELETE FROM bulk_command_templates WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bulk-command/templates/:id/use — bump usage stats and hand
// back the full template so the frontend can load command + device
// selection into the console in one round trip. Devices that no longer
// exist (or moved orgs) are silently filtered out here rather than left
// for the frontend to guess about, since /run would skip them anyway.
router.post('/templates/:id/use', param('id').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const row = await queryOne('SELECT * FROM bulk_command_templates WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const savedIds = JSON.parse(row.device_ids || '[]');
    const stillValid = savedIds.length
      ? await query(
          `SELECT id FROM devices WHERE org_id = ? AND id IN (${savedIds.map(() => '?').join(',')})`,
          [req.orgId, ...savedIds]
        )
      : [];
    const validIds = stillValid.map(d => d.id);
    const missingCount = savedIds.length - validIds.length;

    execute(
      'UPDATE bulk_command_templates SET use_count = use_count + 1, last_used_at = NOW() WHERE id = ?',
      [req.params.id]
    ).catch(() => {}); // fire-and-forget, same pattern as recordHistory

    res.json({
      id: row.id, name: row.name, description: row.description,
      command: row.command, deviceIds: validIds, timeoutSec: row.timeout_sec,
      missingCount,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/bulk-command/devices — device picker list for the console,
// same shape as GET /api/devices but trimmed to just what the picker needs ─
// NOTE: this must stay registered before GET /:runId below — otherwise
// Express would match "/devices" against the ":runId" param first (and
// the isUUID() validator would reject "devices" as a bad id, 400ing what
// should be a normal picker request).
router.get('/devices', async (req, res) => {
  try {
    const rows = await query(
      `SELECT d.id, d.name, d.ip_address, d.os_type, d.status, d.group_id, g.name AS group_name,
              (SELECT GROUP_CONCAT(dt.tag ORDER BY dt.tag SEPARATOR ',')
                 FROM device_tags dt WHERE dt.device_id = d.id) AS tags_csv
         FROM devices d LEFT JOIN \`groups\` g ON g.id = d.group_id
        WHERE d.org_id = ? ORDER BY d.name`,
      [req.orgId]
    );
    const tagFilter = (req.query.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    let out = rows.map(r => ({ ...r, tags: r.tags_csv ? r.tags_csv.split(',') : [], tags_csv: undefined }));
    if (tagFilter.length) out = out.filter(d => d.tags.some(t => tagFilter.includes(t)));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/bulk-command/active — "which run was I last watching", the
// cross-browser resume pointer. Must stay registered before GET /:runId
// for the same reason as /devices above ('active' would otherwise get
// matched against :runId's isUUID() validator and 400). Self-cleaning:
// if the pointed-at run has expired out of Redis (see JOB_TTL_SEC in
// services/bulkCommand.js), the stale pointer is deleted here so it
// doesn't keep resolving to a 404 on every future page load. ─────────────
router.get('/active', async (req, res) => {
  try {
    const row = await queryOne(
      'SELECT run_id FROM user_last_bulk_run WHERE user_id = ? AND org_id = ?',
      [req.user.id, req.orgId]
    );
    if (!row) return res.json({ runId: null });

    const job = await bulkCommand.getJob(row.run_id);
    if (!job) {
      await execute('DELETE FROM user_last_bulk_run WHERE user_id = ?', [req.user.id]);
      return res.json({ runId: null });
    }
    res.json({ runId: row.run_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/bulk-command/:runId — full job state + replayed event log as a
// plain JSON response (not SSE). Used to restore the console when the page
// is reloaded or navigated back to — the frontend persists the last runId
// locally and calls this on mount to rebuild results/progress/status before
// (re)attaching the live stream if the run is still in progress ──────────
router.get('/:runId', param('runId').isUUID(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const job = await bulkCommand.getJob(req.params.runId);
  if (!job || job.orgId !== req.orgId) return res.status(404).json({ error: 'Run not found' });

  const events = await bulkCommand.getEvents(req.params.runId);
  res.json({ job, events });
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
  // NOTE: this used to be a raw SSE comment (`: ping\n\n`). Comments never
  // dispatch an event to EventSource in the browser, so the frontend's
  // stall watchdog had no way to distinguish "connection is fine, the
  // command is just legitimately still running" from "connection actually
  // died" — any run whose per-device timeout exceeded the watchdog's 45s
  // window (this page explicitly supports up to 3600s) got falsely flagged
  // as stalled, and reconnecting couldn't fix it since the real problem was
  // that heartbeats were invisible, not that the connection was down. A
  // named `ping` event fixes that: BulkCommandPage listens for it and
  // treats it as proof the stream is alive.
  const ping = setInterval(() => { try { res.write('event: ping\ndata: {}\n\n'); } catch {} }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    bulkCommand.detachStream(req.params.runId, unsub);
  });
});

module.exports = router;