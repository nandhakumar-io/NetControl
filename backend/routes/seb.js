// routes/seb.js — NetControl's own endpoints for the SEB Server 2.2 integration.
// (These are NOT SEB Server endpoints; they orchestrate calls to it via
// services/sebServer.js and track outcomes via services/sebQuit.js.)
//
//   GET  /api/seb/config                       integration status (no secrets)
//   GET  /api/seb/exams/:examId/connections    preview what SEB Server reports + which devices match
//   GET  /api/seb/bindings                     Windows devices + their bound SEB identifier
//   PUT  /api/seb/bindings/:deviceId           bind { key } / unbind { key: null } a device to a SEB client
//   POST /api/seb/quit                         quit SEB on a device / device list / group
//   GET  /api/seb/runs                         recent runs
//   GET  /api/seb/runs/:id                     one run with per-device progress
//   POST /api/seb/runs/:id/cancel              stop waiting / block pending shutdowns
//
// Same trust bar as routes/actions.js (it can end an exam and power machines
// off): admin/operator only, org + group scoped, maintenance-locked, PIN
// confirmed, rate limited, audited per device.
'use strict';
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { query, queryOne, execute } = require('../db');
const { requireAuth, requireActionPin, requireRole } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const { actionLimiter } = require('../middleware/rateLimiter');
const { isUnderMaintenance, maintenanceBlockedReason } = require('../services/maintenance');
const seb = require('../services/sebServer');
const sebQuit = require('../services/sebQuit');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requireOrgContext, requireRole('admin', 'operator'));

const EXAM_ID_RE = /^[\w.:-]{1,64}$/;
const MAX_DEVICES = 200;

function sebErrorStatus(e) {
  if (e.code === 'SEB_NOT_CONFIGURED') return 503;
  if (e.code === 'SEB_NOT_FOUND') return 404;
  if (e.code === 'SEB_AUTH' || e.code === 'SEB_UNREACHABLE' || e.code === 'SEB_TIMEOUT' || e.code === 'SEB_HTTP') return 502;
  return 500;
}

async function userCanAccessGroup(req, groupId) {
  if (req.user.role === 'admin') return true;
  const a = await queryOne('SELECT 1 AS ok FROM user_group_access WHERE user_id = ? AND group_id = ?', [req.user.id, groupId]);
  return !!a;
}

// ── GET /api/seb/config ──────────────────────────────────────────────────────
router.get('/config', (_req, res) => {
  res.json({
    configured: seb.isConfigured(),
    ...seb.publicConfig(),
    defaultExamId: process.env.SEB_DEFAULT_EXAM_ID || '',
    timeoutSec: sebQuit.DEFAULT_TIMEOUT_SEC(),
    maxTimeoutSec: sebQuit.MAX_TIMEOUT_SEC,
    shutdownDelaySec: sebQuit.SHUTDOWN_DELAY_SEC(),
  });
});

// ── GET /api/seb/exams/:examId/connections ───────────────────────────────────
// Read-only preview: lets an operator confirm the exam id is right and that
// the matching (IP / hostname) lines up with real devices before pulling the trigger.
router.get('/exams/:examId/connections',
  actionLimiter,
  param('examId').matches(EXAM_ID_RE),
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid exam id' });
    try {
      const connections = await seb.getMonitoring(req.params.examId);
      const devices = await query(
        'SELECT id, name, hostname, ip_address, group_id, seb_match_key FROM devices WHERE org_id = ? AND os_type = \'windows\'',
        [req.orgId]
      );
      const matchedBy = new Map();
      for (const d of devices) {
        const { con, by } = seb.matchConnectionDetailed(d, connections);
        if (con) matchedBy.set(con.token, { device: d, by });
      }
      let activeCount = 0;
      let exitedCount = 0;
      for (const c of connections) {
        if (seb.isTerminal(c.status) || ['CLOSED', 'DISABLED'].includes(c.status)) exitedCount++;
        else if (['READY', 'ACTIVE', 'AUTHENTICATED', 'CONNECTION_REQUESTED'].includes(c.status)) activeCount++;
      }
      res.json({
        examId: req.params.examId,
        total: connections.length,
        activeCount,
        exitedCount,
        connections: connections.map(c => ({
          tokenSuffix: c.token.slice(-6),
          status: c.status,
          isExited: seb.isTerminal(c.status) || ['CLOSED', 'DISABLED'].includes(c.status),
          isActive: !seb.isTerminal(c.status) && ['READY', 'ACTIVE', 'AUTHENTICATED'].includes(c.status),
          ip: c.clientAddress || null,
          user: c.userSession || null,
          fields: [...new Set(c.values.filter(v => v !== c.token && v !== ''))].slice(0, 14),
          device: matchedBy.has(c.token) ? { id: matchedBy.get(c.token).device.id, name: matchedBy.get(c.token).device.name } : null,
          matchedBy: matchedBy.has(c.token) ? matchedBy.get(c.token).by : null,
        })),
      });
    } catch (e) {
      res.status(sebErrorStatus(e)).json({ error: e.message, code: e.code });
    }
  }
);

// ── GET /api/seb/device-statuses ─────────────────────────────────────────────
// Returns live SEB connection status for all devices in the current org.
// Powers the "SEB Active" / "SEB Exited" indicators and filters in NetControl.
router.get('/device-statuses', async (req, res) => {
  try {
    if (!seb.isConfigured()) {
      return res.json({ configured: false, devices: {}, activeCount: 0, exitedCount: 0 });
    }
    const examId = req.query.examId || process.env.SEB_DEFAULT_EXAM_ID || '2';
    const connections = await seb.getMonitoring(examId, { deduplicate: true });

    const params = [req.orgId];
    let scope = '';
    if (req.user.role !== 'admin') {
      scope = ' AND group_id IN (SELECT group_id FROM user_group_access WHERE user_id = ?)';
      params.push(req.user.id);
    }
    const devices = await query(
      `SELECT id, name, hostname, ip_address, group_id, seb_match_key FROM devices WHERE org_id = ? AND os_type = 'windows'${scope}`,
      params
    );

    const byDevice = {};
    let activeCount = 0;
    let exitedCount = 0;

    for (const d of devices) {
      const { con, by } = seb.matchConnectionDetailed(d, connections);
      if (con) {
        const isExited = seb.isTerminal(con.status) || ['CLOSED', 'DISABLED'].includes(con.status);
        const isActive = !isExited && ['READY', 'ACTIVE', 'AUTHENTICATED', 'CONNECTION_REQUESTED'].includes(con.status);
        if (isActive) activeCount++;
        if (isExited) exitedCount++;

        byDevice[d.id] = {
          status: con.status,
          isActive,
          isExited,
          user: con.userSession || null,
          ip: con.clientAddress || null,
          tokenSuffix: (con.token || '').slice(-6),
          matchedBy: by,
          examId,
        };
      }
    }

    res.json({
      configured: true,
      examId,
      totalConnections: connections.length,
      activeCount,
      exitedCount,
      devices: byDevice,
    });
  } catch (err) {
    res.json({
      configured: true,
      error: err.message,
      devices: {},
      activeCount: 0,
      exitedCount: 0,
    });
  }
});

// ── GET /api/seb/bindings ────────────────────────────────────────────────────
router.get('/bindings', async (req, res) => {
  try {
    const params = [req.orgId];
    let scope = '';
    if (req.user.role !== 'admin') {
      scope = ' AND d.group_id IN (SELECT group_id FROM user_group_access WHERE user_id = ?)';
      params.push(req.user.id);
    }
    const rows = await query(
      `SELECT d.id, d.name, d.ip_address, d.hostname, d.group_id, g.name AS group_name, d.seb_match_key
         FROM devices d LEFT JOIN \`groups\` g ON g.id = d.group_id
        WHERE d.org_id = ? AND d.os_type = 'windows'${scope}
        ORDER BY g.name, d.name`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/seb/bindings/:deviceId ──────────────────────────────────────────
// body: { key: string | null }. The key is a stable identifier SEB Server
// reports for the client (machine name, fixed address, ...), NOT the
// per-session connection token. One key can only belong to one device per org.
router.put('/bindings/:deviceId',
  param('deviceId').isUUID(),
  body('key').custom(v => v === null || (typeof v === 'string' && v.trim().length <= 255)),
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid request' });
    try {
      const device = await queryOne('SELECT * FROM devices WHERE id = ? AND org_id = ?', [req.params.deviceId, req.orgId]);
      if (!device) return res.status(404).json({ error: 'Device not found' });
      if (device.os_type !== 'windows') return res.status(400).json({ error: 'Only Windows devices can be bound to a SEB client' });
      if (device.group_id ? !(await userCanAccessGroup(req, device.group_id)) : req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied to this device' });
      }

      const key = req.body.key === null ? null : req.body.key.trim() || null;
      if (key) {
        const clash = await queryOne(
          'SELECT id, name FROM devices WHERE org_id = ? AND LOWER(seb_match_key) = LOWER(?) AND id <> ?',
          [req.orgId, key, device.id]
        );
        if (clash) return res.status(409).json({ error: `"${key}" is already bound to ${clash.name}` });
      }
      await execute('UPDATE devices SET seb_match_key = ? WHERE id = ?', [key, device.id]);
      await audit.log({
        userId: req.user.id, username: req.user.username, orgId: req.orgId,
        action: key ? 'seb_bind' : 'seb_unbind', targetType: 'device', targetId: device.id,
        targetName: device.name, ipSource: req.realIp, result: 'success',
        details: key ? `bound to SEB identifier "${key}"` : `unbound (was "${device.seb_match_key || ''}")`,
      }).catch(() => {});
      res.json({ ok: true, seb_match_key: key });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

// ── POST /api/seb/quit ───────────────────────────────────────────────────────
// body: { actionPin, examId, shutdownAfter?, timeoutSec?, deviceId | deviceIds[] | groupId }
router.post('/quit',
  actionLimiter,
  body('actionPin').notEmpty().isString(),
  body('examId').isString().trim().matches(EXAM_ID_RE).withMessage('examId is required (letters, digits, . _ - :)'),
  body('shutdownAfter').optional().isBoolean(),
  body('timeoutSec').optional().isInt({ min: 15, max: sebQuit.MAX_TIMEOUT_SEC }),
  body('deviceId').optional().isUUID(),
  body('groupId').optional().isUUID(),
  body('deviceIds').optional().isArray({ min: 1, max: MAX_DEVICES }),
  body('deviceIds.*').optional().isUUID(),
  requireActionPin,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!seb.isConfigured()) {
      return res.status(503).json({ error: 'SEB Server integration is not configured on this NetControl instance', code: 'SEB_NOT_CONFIGURED' });
    }

    const { examId, deviceId, groupId, deviceIds } = req.body;
    const shutdownAfter = req.body.shutdownAfter === true || req.body.shutdownAfter === 'true';
    if (!deviceId && !groupId && !deviceIds) {
      return res.status(400).json({ error: 'deviceId, deviceIds or groupId required' });
    }

    // ── resolve scope → device rows (org filter lives in the query itself) ──
    let rows = [];
    let scopeType, scopeId = null, scopeName;
    try {
      if (groupId) {
        const group = await queryOne('SELECT * FROM `groups` WHERE id = ? AND org_id = ?', [groupId, req.orgId]);
        if (!group) return res.status(404).json({ error: 'Group not found' });
        if (!(await userCanAccessGroup(req, groupId))) return res.status(403).json({ error: 'Access denied to this group' });
        rows = await query('SELECT * FROM devices WHERE group_id = ? AND org_id = ?', [groupId, req.orgId]);
        scopeType = 'group'; scopeId = groupId; scopeName = group.name;
      } else {
        const ids = [...new Set(deviceIds || [deviceId])];
        rows = await query(
          `SELECT * FROM devices WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
          [req.orgId, ...ids]
        );
        if (!rows.length) return res.status(404).json({ error: 'Device not found' });
        scopeType = ids.length === 1 ? 'device' : 'devices';
        scopeId = ids.length === 1 ? ids[0] : null;
        scopeName = ids.length === 1 ? rows[0].name : `${rows.length} devices`;
      }
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message, code: e.code });
    }
    if (!rows.length) return res.status(400).json({ error: 'No devices found for target' });

    // ── per-device eligibility ──────────────────────────────────────────────
    const groupAccess = new Map();
    const eligible = [], skipped = [];
    const busy = await sebQuit.devicesInFlight(rows.map(r => r.id));
    for (const d of rows) {
      if (req.user.role !== 'admin' && d.group_id) {
        if (!groupAccess.has(d.group_id)) groupAccess.set(d.group_id, await userCanAccessGroup(req, d.group_id));
        if (!groupAccess.get(d.group_id)) { skipped.push({ device: d, reason: 'Access denied to this device' }); continue; }
      } else if (req.user.role !== 'admin' && !d.group_id) {
        skipped.push({ device: d, reason: 'Access denied to this device' }); continue;
      }
      if (d.os_type !== 'windows') { skipped.push({ device: d, reason: 'Not a Windows device — SEB quit applies to Windows endpoints only' }); continue; }
      if (isUnderMaintenance(d)) { skipped.push({ device: d, reason: maintenanceBlockedReason(d) }); continue; }
      if (busy.has(d.id)) { skipped.push({ device: d, reason: 'A SEB quit is already in progress for this device' }); continue; }
      eligible.push(d);
    }

    if (!eligible.length) {
      return res.status(409).json({
        error: 'No eligible devices in selection',
        skipped: skipped.map(s => ({ deviceId: s.device.id, device: s.device.name, reason: s.reason })),
      });
    }

    try {
      const { runId, timeoutSec } = await sebQuit.startRun({
        orgId: req.orgId, user: { id: req.user.id, username: req.user.username }, ip: req.realIp,
        examId, scopeType, scopeId, scopeName, shutdownAfter,
        timeoutSec: req.body.timeoutSec, devices: eligible, skipped,
      });
      await audit.log({
        userId: req.user.id, username: req.user.username, orgId: req.orgId,
        action: 'seb_quit_run', targetType: scopeType === 'group' ? 'group' : 'device', targetId: scopeId,
        targetName: scopeName, ipSource: req.realIp, result: 'success',
        details: `exam ${examId}; ${eligible.length} device(s); shutdown after exit: ${shutdownAfter ? 'yes' : 'no'}; run ${runId}`,
      }).catch(() => {});
      res.status(202).json({
        runId, total: rows.length, started: eligible.length, timeoutSec, shutdownAfter,
        skipped: skipped.map(s => ({ deviceId: s.device.id, device: s.device.name, reason: s.reason })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── GET /api/seb/runs ────────────────────────────────────────────────────────
router.get('/runs', async (req, res) => {
  try { res.json(await sebQuit.listRuns(req.orgId, parseInt(req.query.limit, 10) || 20)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/seb/runs/:id ────────────────────────────────────────────────────
router.get('/runs/:id', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const run = await sebQuit.getRun(req.params.id, req.orgId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/seb/runs/:id/cancel ────────────────────────────────────────────
// Stops tracking and blocks any shutdown not yet sent. A SEB_QUIT instruction
// that was already registered cannot be recalled.
router.post('/runs/:id/cancel', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const ok = await sebQuit.cancelRun(req.params.id, req.orgId);
    if (!ok) return res.status(409).json({ error: 'Run not found or already finished' });
    await audit.log({
      userId: req.user.id, username: req.user.username, orgId: req.orgId,
      action: 'seb_quit_cancel', targetType: 'seb_run', targetId: req.params.id,
      ipSource: req.realIp, result: 'success', details: 'SEB quit run cancelled — shutdowns blocked',
    }).catch(() => {});
    const run = await sebQuit.getRun(req.params.id, req.orgId);
    res.json({ ok: true, run });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;