// db/migrate-log-export-target.js — adds export_target to log_export_schedules
// so a scheduled export can go to a file destination (existing behavior) OR
// stream straight to the configured syslog server. Split out from
// migrate-scheduled-jobs.js since it must run strictly after that table
// exists, and kept as its own small, idempotent migration in the same style
// as migrate-device-history.js / migrate-bruteforce.js.
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

async function colExists(conn, table, col) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, col]
  );
  return r.length > 0;
}

async function migrateLogExportTarget() {
  const conn = await getConn();
  try {
    // export_target: 'file' (existing behavior — render + write to a
    // backup_destinations row, or local store when destination_id is NULL)
    // or 'syslog' (stream each matching audit row to the configured syslog
    // server instead of producing a file at all).
    if (!(await colExists(conn, 'log_export_schedules', 'export_target'))) {
      await conn.query(
        `ALTER TABLE log_export_schedules
         ADD COLUMN export_target ENUM('file','syslog') NOT NULL DEFAULT 'file' AFTER format`
      );
    }
    console.log('[DB] ✅ log_export_schedules.export_target ready');
  } finally {
    try { await conn.end(); } catch {}
  }
}

module.exports = { migrateLogExportTarget };

if (require.main === module) {
  migrateLogExportTarget()
    .then(() => process.exit(0))
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}