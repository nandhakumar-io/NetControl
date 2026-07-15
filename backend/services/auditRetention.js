// services/auditRetention.js — audit_log retention/pruning
//
// Unlike backups (services/backupService.js's pruneOldArchives, capped by
// count via BACKUP_RETENTION_COUNT) or metrics (services/metricsRollup.js,
// compacted then capped by age), audit_log had no cap at all — every one of
// the ~90 call sites across the app (routes/*.js, services/scheduledJobs.js,
// services/complianceService.js, etc.) inserts a row that lived forever.
// For a table written on nearly every admin action, that grows unbounded
// and eventually slows down the audit page's list/export/tally queries
// (routes/audit.js), which all scan/aggregate the whole table per request.
//
// This deletes rows older than AUDIT_LOG_RETENTION_DAYS (default 365 — long
// enough to cover a full annual compliance/security review cycle). Rows are
// never modified before deletion, and syslog forwarding
// (services/syslogForwarder.js) already happens synchronously at write
// time, so nothing here can cause a gap in what's been relayed off-box —
// pruning only removes NetControl's own local copy once it's aged out.
//
// Set AUDIT_LOG_RETENTION_DAYS=0 to disable pruning entirely (keep audit_log
// forever, e.g. if an external process already archives it on its own
// schedule).
'use strict';
const { execute } = require('../db');

const RETENTION_DAYS = process.env.AUDIT_LOG_RETENTION_DAYS !== undefined
  ? parseInt(process.env.AUDIT_LOG_RETENTION_DAYS) : 365;

const DAY = 86400;

// Batched + capped per tick (same reasoning as metricsRollup's LIMIT 50000):
// a poller that was down for months shouldn't come back and try to delete
// years of backlog in one lock-holding statement. It just picks up the next
// batch on the next tick until it's caught up.
async function pruneOldEntries() {
  if (!RETENTION_DAYS) return; // 0/unset-to-disabled — explicit opt-out

  try {
    const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * DAY;
    const result = await execute('DELETE FROM audit_log WHERE timestamp < ? LIMIT 50000', [cutoff]);
    if (result.affectedRows) {
      console.log(`[AuditRetention] Pruned ${result.affectedRows} audit_log row(s) older than ${RETENTION_DAYS}d`);
    }
  } catch (e) {
    console.error('[AuditRetention] prune failed:', e.message);
  }
}

let timer = null;
function start() {
  if (!RETENTION_DAYS) {
    console.log('[AuditRetention] AUDIT_LOG_RETENTION_DAYS=0 — audit log pruning disabled');
    return;
  }
  pruneOldEntries();
  // Once a day: audit_log growth is slow relative to metrics_history, and
  // retention here is measured in months/years, not hours — no benefit to
  // metricsRollup's 6h cadence, and this keeps it off the hot path.
  timer = setInterval(pruneOldEntries, 24 * 60 * 60 * 1000);
}
function stop() {
  if (timer) clearInterval(timer);
}

module.exports = { start, stop, pruneOldEntries, RETENTION_DAYS };