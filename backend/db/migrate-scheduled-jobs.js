// db/migrate-scheduled-jobs.js — scheduled backups + scheduled log exports
//
// Two new tables, deliberately kept separate from the existing `schedules`
// table (device wake/shutdown/restart) because their config shape is
// completely different (backup source/destination vs. audit-log filters)
// and coupling them would mean a nullable-everything mega-table. Both are
// driven by services/scheduledJobs.js the same way `schedules` is driven by
// services/scheduler.js — load-on-boot + node-cron, one process only (the
// poller), never the clustered web workers.
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

async function migrateScheduledJobs() {
  const conn = await getConn();
  try {
    // ── Scheduled backups ───────────────────────────────────────────────────
    // Mirrors the shape of a POST /api/backup body (source + format +
    // destination) plus cron/enabled/bookkeeping columns. device_id/mount
    // are nullable because the source may be the local server.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS backup_schedules (
        id                CHAR(36)      NOT NULL PRIMARY KEY,
        name              VARCHAR(100)  NOT NULL,
        cron_expr         VARCHAR(100)  NOT NULL,
        enabled           TINYINT(1)    NOT NULL DEFAULT 1,
        source_device_id  CHAR(36)      DEFAULT NULL COMMENT 'NULL = local server',
        mount             VARCHAR(500)  DEFAULT NULL COMMENT 'required when source_device_id is set',
        source_path       VARCHAR(1000) NOT NULL,
        format            ENUM('zip','tar','tar.gz') NOT NULL DEFAULT 'zip',
        label             VARCHAR(80)   DEFAULT NULL,
        destination_id    CHAR(36)      DEFAULT NULL COMMENT 'NULL = local backup store',
        created_by        CHAR(36)      DEFAULT NULL,
        created_by_name   VARCHAR(100)  DEFAULT NULL,
        created_at        INT UNSIGNED  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        last_run          INT UNSIGNED  DEFAULT NULL,
        last_status       ENUM('success','failure') DEFAULT NULL,
        last_error        TEXT          DEFAULT NULL,
        INDEX idx_backup_schedules_enabled (enabled),
        CONSTRAINT fk_backup_sched_user FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_backup_sched_dest FOREIGN KEY (destination_id)
          REFERENCES backup_destinations(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // ── Scheduled log (audit) exports ───────────────────────────────────────
    // filters is the same query shape buildAuditQuery() in routes/audit.js
    // accepts (action/result/search/from/to), stored as JSON so new filters
    // don't need a schema change. destination reuses backup_destinations —
    // a scheduled export is really just "run the CSV export, then hand the
    // bytes to a destination" instead of streaming to an HTTP response.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS log_export_schedules (
        id                CHAR(36)      NOT NULL PRIMARY KEY,
        name              VARCHAR(100)  NOT NULL,
        cron_expr         VARCHAR(100)  NOT NULL,
        enabled           TINYINT(1)    NOT NULL DEFAULT 1,
        format            ENUM('csv','txt') NOT NULL DEFAULT 'csv',
        filters           JSON          DEFAULT NULL,
        destination_id    CHAR(36)      DEFAULT NULL COMMENT 'NULL = local backup store',
        created_by        CHAR(36)      DEFAULT NULL,
        created_by_name   VARCHAR(100)  DEFAULT NULL,
        created_at        INT UNSIGNED  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        last_run          INT UNSIGNED  DEFAULT NULL,
        last_status       ENUM('success','failure') DEFAULT NULL,
        last_error        TEXT          DEFAULT NULL,
        INDEX idx_log_export_schedules_enabled (enabled),
        CONSTRAINT fk_log_export_sched_user FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_log_export_sched_dest FOREIGN KEY (destination_id)
          REFERENCES backup_destinations(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    await conn.end();
  }
}

module.exports = { migrateScheduledJobs };

if (require.main === module) {
  migrateScheduledJobs()
    .then(() => { console.log('✅ backup_schedules + log_export_schedules tables ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}