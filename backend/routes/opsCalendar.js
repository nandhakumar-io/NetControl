// routes/opsCalendar.js — read-only aggregation of every cron-scheduled
// system in the app into one calendar. Backup schedules, bulk-command
// schedules, digest schedules, SLA report schedules, and log-export
// schedules all exist as separate features with their own cron config —
// this doesn't change any of them, it just expands all their cron_exprs
// into concrete occurrences over a date range so an admin can see
// everything landing this week in one place (and notice, e.g., a backup
// window overlapping a scheduled bulk patch run) instead of checking five
// pages one at a time.
'use strict';
const express = require('express');
const { query: queryValidator, validationResult } = require('express-validator');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');
const { occurrencesInRange } = require('../services/cronOccurrences');

const router = express.Router();
router.use(requireAuth, requireOrgContext);

const MAX_RANGE_DAYS = 62; // a bit over a month — generous for a calendar view, bounded so a bad ?end= can't force scanning years of minutes

// ── GET /api/ops-calendar?start=<unix>&end=<unix> ────────────────────────────
router.get('/',
  [
    queryValidator('start').isInt({ min: 0 }).withMessage('start must be a unix timestamp (seconds)'),
    queryValidator('end').isInt({ min: 0 }).withMessage('end must be a unix timestamp (seconds)'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const startSec = parseInt(req.query.start, 10);
    const endSec = parseInt(req.query.end, 10);
    if (endSec <= startSec) return res.status(400).json({ error: 'end must be after start' });
    if ((endSec - startSec) > MAX_RANGE_DAYS * 86400) {
      return res.status(400).json({ error: `Range too large — max ${MAX_RANGE_DAYS} days` });
    }
    const fromMs = startSec * 1000, toMs = endSec * 1000;

    try {
      const [backups, bulkRuns, digests, slaReports, logExports] = await Promise.all([
        query(
          `SELECT id, name, cron_expr, enabled, source_device_id, source_path, destination_id
             FROM backup_schedules WHERE org_id = ? AND enabled = 1`,
          [req.orgId]
        ),
        query(
          `SELECT id, name, cron_expr, enabled, timeout_sec
             FROM bulk_command_schedules WHERE org_id = ? AND enabled = 1`,
          [req.orgId]
        ),
        // Digest schedules are instance-wide (admin-configured, not
        // per-tenant — see routes/digest.js), so no org_id filter here;
        // every org sees the same digest cadence, matching how the
        // Digest settings page itself works.
        query(`SELECT id, name, cron_expr, enabled, period_days FROM digest_schedules WHERE enabled = 1`),
        query(
          `SELECT id, name, cron_expr, enabled, scope_type FROM sla_report_schedules WHERE org_id = ? AND enabled = 1`,
          [req.orgId]
        ),
        query(`SELECT id, name, cron_expr, enabled, format FROM log_export_schedules WHERE enabled = 1`),
      ]);

      const events = [];
      const expand = (rows, kind, extra) => {
        for (const row of rows) {
          const occurrences = occurrencesInRange(row.cron_expr, fromMs, toMs);
          for (const ts of occurrences) {
            events.push({
              kind, id: row.id, name: row.name, at: ts,
              ...extra(row),
            });
          }
        }
      };

      expand(backups, 'backup', r => ({ path: `/backups`, scheduleId: r.id }));
      expand(bulkRuns, 'bulk_command', r => ({ path: `/bulk-command-schedules`, scheduleId: r.id, timeoutSec: r.timeout_sec }));
      expand(digests, 'digest', r => ({ path: null, scheduleId: r.id, periodDays: r.period_days })); // no dedicated frontend page yet — see routes/digest.js
      expand(slaReports, 'sla_report', r => ({ path: `/sla-reports`, scheduleId: r.id, scopeType: r.scope_type }));
      expand(logExports, 'log_export', r => ({ path: `/audit`, scheduleId: r.id, format: r.format }));

      events.sort((a, b) => a.at - b.at);

      // Flag same-day collisions across DIFFERENT kinds — a backup and a
      // bulk-command run both landing on the same day is exactly the
      // "would've caught this by eye eventually, now it's flagged" case
      // this feature exists for. Same-kind collisions (two backups the
      // same day) aren't flagged — that's normal and expected.
      const byDay = new Map();
      for (const ev of events) {
        const day = new Date(ev.at * 1000).toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, new Set());
        byDay.get(day).add(ev.kind);
      }
      for (const ev of events) {
        const day = new Date(ev.at * 1000).toISOString().slice(0, 10);
        ev.busyDay = byDay.get(day).size > 1;
      }

      res.json({ events, range: { start: startSec, end: endSec } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;