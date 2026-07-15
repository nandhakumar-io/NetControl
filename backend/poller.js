// poller.js — NetControl Poller process
//
// Runs status polling (statusPoller), cron-scheduled actions (scheduler),
// and compliance checks (complianceService) in ONE dedicated process,
// separate from the clustered web/API tier in server.js.
//
// WHY A SEPARATE PROCESS:
// server.js clusters into multiple workers for HTTP throughput. Before this
// split, every single worker independently called statusPoller.start(),
// loadAllSchedules(), and complianceService.start() — with N workers that
// meant N-fold duplicate device polling AND, more seriously, N-fold
// duplicate execution of scheduled actions (a "shutdown lab devices at
// 6pm" schedule would fire once per worker). Running exactly one poller
// process removes that bug entirely and also means a slow admin API
// request or a stuck SSH proxy call in the web tier can never delay the
// poll loop or a scheduled action.
//
// This process does NOT listen on any HTTP port — it only talks to
// MySQL directly and publishes device-status changes over the same Redis
// bus the web tier uses for metrics, so the web tier's local SSE clients
// see poller-driven status flips too (see services/bus.js).
//
// Run with: node poller.js  (see docker-compose.yaml `poller` service)

'use strict';
require('dotenv').config();

process.on('unhandledRejection', (err) => {
  console.error('[Poller/UnhandledRejection]', err);
});

const { loadAllSchedules } = require('./services/scheduler');
const statusPoller         = require('./services/statusPoller');
const complianceService    = require('./services/complianceService');
const metricsRollup        = require('./services/metricsRollup');
const scheduledJobs        = require('./services/scheduledJobs');
const digestService        = require('./services/digestService');
const syntheticCheckRunner = require('./services/syntheticCheckRunner');
const auditRetention       = require('./services/auditRetention');

console.log(`\n🛰️  NetControl poller process starting (pid ${process.pid})`);
console.log(`   Environment : ${process.env.NODE_ENV || 'development'}\n`);

loadAllSchedules();
statusPoller.start();
complianceService.start();
scheduledJobs.start();
digestService.start();
syntheticCheckRunner.start();

// ── metrics_history compaction + retention ────────────────────────────────────
// Raw 60s buckets are kept for METRICS_COMPRESS_AFTER_DAYS (default 35 —
// "at least a month"), then folded into one row/device/day in
// metrics_history_daily and deleted, where they're kept for
// METRICS_DAILY_RETENTION_DAYS (default 730) before finally being pruned.
// See services/metricsRollup.js for the full rationale.
metricsRollup.start();
console.log(`   Metrics retention: ${metricsRollup.COMPRESS_AFTER_DAYS}d raw -> compressed to daily -> kept ${metricsRollup.DAILY_RETENTION_DAYS}d total\n`);

// ── audit_log retention ─────────────────────────────────────────────────────
// See services/auditRetention.js — rows older than AUDIT_LOG_RETENTION_DAYS
// (default 365) are pruned daily. Set to 0 to keep audit_log forever.
auditRetention.start();
console.log(`   Audit log retention: ${auditRetention.RETENTION_DAYS ? auditRetention.RETENTION_DAYS + 'd' : 'disabled (kept forever)'}\n`);

// Keep the process alive; all the real work happens on setInterval timers
// inside the services above.
process.on('SIGTERM', () => {
  console.log('[Poller] SIGTERM received, shutting down');
  statusPoller.stop();
  scheduledJobs.stop();
  digestService.stop();
  syntheticCheckRunner.stop();
  auditRetention.stop();
  process.exit(0);
});