// routes/jobs.js — "Jobs" timeline: a single view over bulk edits, bulk
// wakes, scheduled restarts, and agent updates, which today are scattered
// across the Audit page, the Schedules page, and one-off toasts.
//
// There's no dedicated "job run" table to read from — bulk command runs
// (services/bulkCommand.js) are transient, TTL'd Redis/in-memory state
// meant for the live progress stream, not history. What IS durable is
// audit_log, which already gets a row per action. Some of those actions
// are logged once for the whole batch (bulk_import_devices,
// bulk_agent_update_request, bulk_enable/disable_maintenance_mode — see
// routes/devices.js), but the higher-frequency ones (wake/shutdown/restart,
// bulk_exec_command, scheduled_*) are logged once PER DEVICE in a tight
// loop (routes/actions.js, services/bulkCommand.js, services/scheduler.js).
//
// So a "job" here is reconstructed rather than read directly: consecutive
// audit_log rows sharing the same (username, action) that land within
// BATCH_WINDOW_SEC of each other are folded into one job with rolled-up
// success/failure/skipped counts. This is a heuristic, not a stored fact —
// two truly unrelated single-device wakes fired by the same user a couple
// seconds apart would show up as one job. Given the alternative (adding and
// backfilling a new job_id column everywhere audit.log() is called), the
// heuristic is the pragmatic version of this feature; it's clearly labeled
// as a timeline reconstruction, not a ledger, in the UI.
'use strict';
const express = require('express');
const { query } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { requireOrgContext } = require('../middleware/tenant');

const router = express.Router();
router.use(requireAuth, requireOrgContext, requirePermission(128)); // same bit as Audit Log — this is a view over that same data

const BATCH_WINDOW_SEC = 5;
const LOOKBACK_ROWS = 2000; // most-recent audit rows scanned per request, well past what a single page needs

// Actions that make sense on a "Jobs" timeline — deliberately excludes
// things like logins, device edits, or config changes that aren't a
// wake/bulk/scheduled run against a set of devices.
const JOB_ACTIONS = new Set([
  'wake', 'shutdown', 'restart',
  'wake_relayed',
  'scheduled_wake', 'scheduled_shutdown', 'scheduled_restart',
  'bulk_exec_command',
  'bulk_import_devices',
  'bulk_agent_update_request',
  'bulk_enable_maintenance_mode', 'bulk_disable_maintenance_mode',
]);

// Actions that are ALREADY one row per whole batch (see the header comment) —
// these never get folded with neighboring rows, even if they share a
// username/action with something else nearby, since each one already IS a
// complete job on its own.
const SINGLE_ROW_ACTIONS = new Set([
  'bulk_import_devices',
  'bulk_agent_update_request',
  'bulk_enable_maintenance_mode',
  'bulk_disable_maintenance_mode',
]);

const LABELS = {
  wake: 'Wake',
  shutdown: 'Shutdown',
  restart: 'Restart',
  wake_relayed: 'Wake (relayed)',
  scheduled_wake: 'Scheduled Wake',
  scheduled_shutdown: 'Scheduled Shutdown',
  scheduled_restart: 'Scheduled Restart',
  bulk_exec_command: 'Bulk Command',
  bulk_import_devices: 'Bulk Import',
  bulk_agent_update_request: 'Agent Update',
  bulk_enable_maintenance_mode: 'Maintenance Enabled',
  bulk_disable_maintenance_mode: 'Maintenance Disabled',
};

// GET /api/jobs — folds recent audit_log rows into job-shaped groups.
// ?action=wake&result=failure&search=foo behave the same as on the Audit
// page, applied to the underlying rows before grouping.
router.get('/', async (req, res) => {
  try {
    const where = ['org_id = ?'];
    const params = [req.orgId];

    if (req.user.role !== 'admin') {
      where.push(`(
        user_id = ?
        OR target_id IN (SELECT group_id FROM user_group_access WHERE user_id = ?)
        OR target_id IN (
          SELECT d.id FROM devices d
          INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ?
        )
      )`);
      params.push(req.user.id, req.user.id, req.user.id);
    }

    if (req.query.action) { where.push('action = ?'); params.push(req.query.action); }
    if (req.query.result) { where.push('result = ?'); params.push(req.query.result); }
    if (req.query.search) {
      where.push('(username LIKE ? OR target_name LIKE ?)');
      params.push(`%${req.query.search}%`, `%${req.query.search}%`);
    }
    if (req.query.from) { where.push('timestamp >= ?'); params.push(parseInt(req.query.from)); }
    if (req.query.to)   { where.push('timestamp <= ?'); params.push(parseInt(req.query.to)); }

    const placeholders = Array.from(JOB_ACTIONS).map(() => '?').join(',');
    where.push(`action IN (${placeholders})`);
    params.push(...JOB_ACTIONS);

    const rows = await query(
      `SELECT id, timestamp, username, action, target_name, result, details
         FROM audit_log
        WHERE ${where.join(' AND ')}
        ORDER BY timestamp DESC
        LIMIT ${LOOKBACK_ROWS}`,
      params
    );

    // Fold consecutive (same username+action, timestamp within
    // BATCH_WINDOW_SEC of the running batch's start) rows into one job.
    // Rows arrive DESC; walk them in that order and close a batch as soon
    // as the gap widens or the key changes.
    const jobs = [];
    let current = null;

    for (const row of rows) {
      const isSingleRow = SINGLE_ROW_ACTIONS.has(row.action);
      const key = `${row.username}::${row.action}`;

      const fitsCurrent = current
        && !isSingleRow
        && current.key === key
        && (current.startedAt - row.timestamp) <= BATCH_WINDOW_SEC;

      if (fitsCurrent) {
        current.total++;
        if (row.result === 'success') current.success++;
        else if (row.result === 'failure') current.failure++;
        else current.skipped++;
        current.startedAt = row.timestamp; // extend the window backward as we walk older rows
        if (current.targets.length < 5) current.targets.push(row.target_name);
      } else {
        current = {
          id: row.id, // first-seen (most recent) row's id, stable enough for a React key
          key,
          action: row.action,
          label: LABELS[row.action] || row.action,
          username: row.username,
          finishedAt: row.timestamp, // most recent row in the batch, walked first since DESC
          startedAt: row.timestamp,
          total: 1,
          success: row.result === 'success' ? 1 : 0,
          failure: row.result === 'failure' ? 1 : 0,
          skipped: row.result === 'partial' ? 1 : 0,
          targets: [row.target_name].filter(Boolean),
          details: isSingleRow ? row.details : null,
        };
        jobs.push(current);
      }
    }

    // "partial" rows land in `skipped` above only for the rare per-device
    // 'partial' result; the common case (some devices ok, some failed) is
    // just a mix of success/failure rows within the same job, which the
    // client renders as its own partial state from success>0 && failure>0.
    res.json(jobs.map(({ key, ...j }) => j));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;