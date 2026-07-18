// db/migrate-bulk-command-schedules.js — Scheduled (cron) bulk command runs.
//
// Unifies the previously-separate "run a command across N devices"
// (services/bulkCommand.js, interactive only) and "run this on a cron"
// (services/scheduledJobs.js / services/scheduler.js, backups/exports/
// device-power-actions only) systems: a saved bulk command can now also be
// registered on a cron schedule. Each scheduled firing reuses
// services/bulkCommand.js's startRun() exactly the way a human clicking
// "Run" does — same SSH/WinRM execution path, same per-device audit log,
// same maintenance-mode skip — just triggered by cron and attributed to
// 'scheduler' instead of a user. See services/bulkCommandScheduler.js.
//
// device_ids is a frozen snapshot captured at schedule-creation/edit time
// (JSON array), not a live group reference — consistent with how
// BulkCommandPage.jsx already expands a group selection into concrete
// deviceIds before POST /bulk-command/run. A device removed after the
// schedule was created just shows up as "skipped: not found" on the next
// run rather than silently resizing the fleet the schedule targets.
//
// Safe to run repeatedly — CREATE TABLE IF NOT EXISTS.
'use strict';
const path  = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

async function getConn() {
  return mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'netcontrol',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'netcontrol',
    timezone: '+00:00',
  });
}

async function migrateBulkCommandSchedules() {
  const conn = await getConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS bulk_command_schedules (
        id                    CHAR(36)      NOT NULL PRIMARY KEY,
        org_id                CHAR(36)      NOT NULL,
        name                  VARCHAR(100)  NOT NULL,
        command               TEXT          NOT NULL,
        device_ids            LONGTEXT      NOT NULL COMMENT 'JSON array of device UUIDs, snapshotted at save time',
        cron_expr             VARCHAR(100)  NOT NULL,
        timeout_sec           SMALLINT UNSIGNED NOT NULL DEFAULT 30,
        enabled               TINYINT(1)    NOT NULL DEFAULT 1,
        created_by            CHAR(36)      DEFAULT NULL,
        created_by_username   VARCHAR(100)  DEFAULT NULL,
        created_at            INT UNSIGNED  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        last_run              INT UNSIGNED  DEFAULT NULL,
        last_status           ENUM('success','partial','failure') DEFAULT NULL,
        last_error            TEXT          DEFAULT NULL,
        last_run_id           CHAR(36)      DEFAULT NULL COMMENT 'services/bulkCommand.js runId, so results can be reviewed the same way an interactive run is',
        consecutive_failures  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        INDEX idx_bcs_org     (org_id),
        INDEX idx_bcs_enabled (enabled),
        CONSTRAINT fk_bcs_user FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    await conn.end();
  }
}

module.exports = { migrateBulkCommandSchedules };

if (require.main === module) {
  migrateBulkCommandSchedules()
    .then(() => { console.log('✅ bulk_command_schedules table ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}