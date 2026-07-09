// db/migrate-poller-heartbeat.js
//
// WHY THIS EXISTS:
// Device status polling, scheduled backups, scheduled log exports, and
// digests all run exclusively inside the dedicated `poller` process (see
// poller.js / server.js's PROCESS_ROLE split) — never in the web tier. If
// that process isn't running (crashed, never started, OOM-killed, wrong
// PROCESS_ROLE, etc.), every one of those features goes quiet at once with
// NO error anywhere in the web tier, because from the web tier's point of
// view nothing is wrong — it's just a dead process that was supposed to be
// updating rows nobody's watching. That silently looks like: devices stuck
// on "unknown" forever, scheduled log exports/backups showing "Never run",
// digests never arriving — three unrelated-looking symptoms with one cause.
//
// This gives that failure mode a heartbeat: the poller writes one row here
// every successful poll cycle (~5s), and GET /api/health/full reports it as
// stale (and therefore the whole poller as dead) if too much time has
// passed — turning "why is everything silently broken" into an actual,
// checkable fact instead of a guess.
'use strict';
const { getPool } = require('../db');

async function migratePollerHeartbeat() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS poller_heartbeat (
      id              TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
      last_run_at     INT UNSIGNED NOT NULL,
      devices_polled  INT UNSIGNED NOT NULL DEFAULT 0,
      cycle_ms        INT UNSIGNED NOT NULL DEFAULT 0,
      pid             INT UNSIGNED DEFAULT NULL,
      CONSTRAINT chk_poller_heartbeat_singleton CHECK (id = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

module.exports = { migratePollerHeartbeat };