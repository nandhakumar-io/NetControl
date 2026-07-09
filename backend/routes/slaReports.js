// routes/slaReports.js — Client-facing uptime/SLA PDF reports.
// Gated behind its own permission bit (16384, VIEW_SLA_REPORTS) — separate
// from MANAGE_COMPLIANCE/DISCOVER_NETWORK since viewing/exporting reports is
// a much lower-stakes action than the routes those bits guard, and admins
// commonly want to hand this bit to a client-facing account manager role
// without granting device/compliance access.
'use strict';
const express = require('express');
const { body, param, query: queryValidator, validationResult } = require('express-validator');
const fs = require('fs');

const { query, queryOne, execute } = require('../db');
const { requireAuth, requirePermission, requireRole } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const slaReportService = require('../services/slaReportService');
const audit = require('../services/audit');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

const VIEW_SLA_REPORTS = 16384;

function validate(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return true; }
  return false;
}

const SCOPES = ['org', 'group', 'device'];

const periodValidation = [
  body('scope').isIn(SCOPES).withMessage(`scope must be one of: ${SCOPES.join(', ')}`),
  body('scopeId').if(body('scope').isIn(['group', 'device'])).isUUID().withMessage('scopeId is required for group/device scope'),
  body('periodStart').isInt({ min: 0 }),
  body('periodEnd').isInt({ min: 0 }),
];

// ── GET /api/sla-reports/preview — compute uptime data without saving a PDF ──
// Powers a "preview before you generate" screen in the UI.
router.get('/preview',
  requirePermission(VIEW_SLA_REPORTS),
  queryValidator('scope').optional().isIn(SCOPES),
  queryValidator('scopeId').optional().isUUID(),
  queryValidator('from').isInt({ min: 0 }),
  queryValidator('to').isInt({ min: 0 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const scope = req.query.scope || 'org';
    const from = parseInt(req.query.from, 10);
    const to = parseInt(req.query.to, 10);
    if (to <= from) return res.status(400).json({ error: '`to` must be after `from`' });
    try {
      const data = await slaReportService.buildReportData(req.orgId, { scope, scopeId: req.query.scopeId || null, from, to });
      res.json(data);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
);

// ── POST /api/sla-reports/generate — render and store a PDF report ──────────
router.post('/generate', requirePermission(VIEW_SLA_REPORTS), periodValidation, async (req, res) => {
  if (validate(req, res)) return;
  const { scope, scopeId, periodStart, periodEnd } = req.body;
  if (periodEnd <= periodStart) return res.status(400).json({ error: '`periodEnd` must be after `periodStart`' });
  try {
    const result = await slaReportService.generateReport({
      orgId: req.orgId, orgName: req.org?.name, scope, scopeId: scopeId || null,
      from: periodStart, to: periodEnd, userId: req.user.id, username: req.user.username,
    });

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'sla_report_generated', targetType: 'sla_report', targetId: result.id,
      targetName: result.reportData.scopeName, result: 'success',
      details: `${scope} scope, ${result.reportData.deviceCount} device(s), avg uptime ${result.reportData.avgUptimePct ?? 'n/a'}%`,
    });

    res.status(201).json({
      id: result.id, fileName: result.fileName,
      scopeName: result.reportData.scopeName, deviceCount: result.reportData.deviceCount,
      avgUptimePct: result.reportData.avgUptimePct,
      periodStart, periodEnd,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── GET /api/sla-reports — list previously generated reports ────────────────
router.get('/', requirePermission(VIEW_SLA_REPORTS), async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, scope_type, scope_id, scope_name, period_start, period_end,
              device_count, avg_uptime_pct, file_name, generated_by_name, created_at
         FROM sla_reports WHERE org_id = ? ORDER BY created_at DESC LIMIT 200`,
      [req.orgId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/sla-reports/:id/download ────────────────────────────────────────
router.get('/:id/download', requirePermission(VIEW_SLA_REPORTS), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM sla_reports WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    let filePath;
    try { filePath = slaReportService.reportFilePath(row.file_name); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'Report file is no longer available' });

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'sla_report_download', targetType: 'sla_report', targetId: row.id,
      targetName: row.scope_name, result: 'success',
    }).catch(() => {});

    res.download(filePath, row.file_name);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/sla-reports/:id — admin only ─────────────────────────────────
router.delete('/:id', requireRole('admin'), param('id').isUUID(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    const row = await queryOne('SELECT * FROM sla_reports WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Report not found' });

    try {
      const filePath = slaReportService.reportFilePath(row.file_name);
      await fs.promises.unlink(filePath).catch(() => {});
    } catch { /* invalid/missing path — nothing to unlink */ }

    await execute('DELETE FROM sla_reports WHERE id = ?', [row.id]);

    await audit.log({
      userId: req.user.id, username: req.user.username, ipSource: req.realIp || req.ip,
      action: 'sla_report_delete', targetType: 'sla_report', targetId: row.id,
      targetName: row.scope_name, result: 'success',
    });

    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;