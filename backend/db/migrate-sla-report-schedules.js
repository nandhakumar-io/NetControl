// db/migrate-sla-report-schedules.js — automatic monthly SLA report generation.
//
// Mirrors backup_schedules/log_export_schedules exactly (see
// db/migrate-scheduled-jobs.js) — cron-driven, one row per configured
// schedule, org-scoped since this app is multi-tenant (routes/slaReports.js
// requires an org context for every operation). period_mode determines what
// window each run covers relative to when it fires:
//   'previous_calendar_month' — the default: a schedule set to run on the
//      1st of every month at 00:00 reports on the FULL month that just
//      ended, which is what "monthly SLA report" means to virtually every
//      MSP/client relationship. Computed at run time, not stored, so the
//      same schedule row correctly covers a different month every time it
//      fires without needing updating.
//   'trailing_days' — rolling N-day window ending "now" (mirrors
//      digest_schedules.period_days) for anyone who wants e.g. a rolling
//      30-day report instead of calendar-month boundaries.
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

async function tableExists(conn, name) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1`,
    [name]
  );
  return r.length > 0;
}

async function migrateSlaReportSchedules() {
  const conn = await getConn();
  try {
    if (!(await tableExists(conn, 'sla_report_schedules'))) {
      await conn.query(`
        CREATE TABLE sla_report_schedules (
          id                CHAR(36)      NOT NULL PRIMARY KEY,
          org_id            CHAR(36)      NOT NULL,
          name              VARCHAR(100)  NOT NULL,
          cron_expr         VARCHAR(100)  NOT NULL DEFAULT '0 6 1 * *' COMMENT 'default: 1st of month, 06:00',
          enabled           TINYINT(1)    NOT NULL DEFAULT 1,
          scope_type        ENUM('org','group','device') NOT NULL DEFAULT 'org',
          scope_id          CHAR(36)      DEFAULT NULL,
          period_mode       ENUM('previous_calendar_month','trailing_days') NOT NULL DEFAULT 'previous_calendar_month',
          period_days       SMALLINT UNSIGNED DEFAULT NULL COMMENT 'used only when period_mode = trailing_days',
          email_recipients  TEXT          DEFAULT NULL COMMENT 'comma-separated; NULL/empty = report is generated and stored but not emailed',
          created_by        CHAR(36)      DEFAULT NULL,
          created_by_name   VARCHAR(100)  DEFAULT NULL,
          created_at        INT UNSIGNED  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
          last_run          INT UNSIGNED  DEFAULT NULL,
          last_status       ENUM('success','failure') DEFAULT NULL,
          last_error        TEXT          DEFAULT NULL,
          last_report_id    CHAR(36)      DEFAULT NULL,
          consecutive_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0,
          INDEX idx_sla_sched_org (org_id),
          INDEX idx_sla_sched_enabled (enabled),
          CONSTRAINT fk_sla_sched_org FOREIGN KEY (org_id)
            REFERENCES organizations(id) ON DELETE CASCADE,
          CONSTRAINT fk_sla_sched_user FOREIGN KEY (created_by)
            REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + sla_report_schedules table created');
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateSlaReportSchedules };

if (require.main === module) {
  migrateSlaReportSchedules().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}