// db/migrate-sla-reports.js — SLA / uptime report storage
//
// Stores metadata + a pointer to the rendered PDF for every SLA report a
// user generates (or a monthly schedule generates automatically later).
// The underlying uptime math is computed on the fly from the existing
// device_status_history table (see services/slaReportService.js) — this
// table only remembers *that* a report was generated and where its PDF
// lives, so the report list/download/delete UI has something to query
// instead of re-rendering every time.
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

async function colExists(conn, table, col) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, col]
  );
  return r.length > 0;
}

async function migrateSlaReports() {
  const conn = await getConn();
  try {
    console.log('Running SLA report migration...');

    if (!(await tableExists(conn, 'sla_reports'))) {
      await conn.query(`
        CREATE TABLE sla_reports (
          id               CHAR(36)     PRIMARY KEY,
          org_id           CHAR(36)     DEFAULT NULL,
          scope_type       ENUM('org','group','device') NOT NULL DEFAULT 'org',
          scope_id         CHAR(36)     DEFAULT NULL,
          scope_name       VARCHAR(150) DEFAULT NULL,
          period_start     INT UNSIGNED NOT NULL,
          period_end       INT UNSIGNED NOT NULL,
          device_count     INT UNSIGNED NOT NULL DEFAULT 0,
          avg_uptime_pct   DECIMAL(6,3) DEFAULT NULL,
          file_name        VARCHAR(255) NOT NULL,
          generated_by     CHAR(36)     DEFAULT NULL,
          generated_by_name VARCHAR(100) DEFAULT NULL,
          created_at       INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
          INDEX idx_sla_org (org_id),
          INDEX idx_sla_period (period_start, period_end)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + sla_reports table created');
    } else if (!(await colExists(conn, 'sla_reports', 'org_id'))) {
      // Belt-and-suspenders in case this table pre-dates org-scoping.
      await conn.query('ALTER TABLE sla_reports ADD COLUMN org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_sla_org (org_id)');
      console.log('  + sla_reports.org_id');
    }

    console.log('✅ SLA report migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateSlaReports().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateSlaReports };