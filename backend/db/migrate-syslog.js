// db/migrate-syslog.js — system_settings table + audit_log syslog-sync
// columns. Replaces the earlier migrate-snmp.js now that audit-event
// forwarding uses syslog instead of SNMP traps. Uses its own plain mysql2
// connection so it can be called from migrate.js without spinning up the
// full 100-connection pool (same pattern as migrate-security.js /
// migrate-discovery.js / migrate-bruteforce.js).
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

async function migrateSyslogTables() {
  const conn = await getConn();
  try {
    // ── Generic key/value settings store ─────────────────────────────────────
    // Used today for syslog forwarder config (host/port/protocol/enabled),
    // editable from the Audit Log → Syslog Settings modal without a
    // redeploy. Generic enough to reuse for future admin-configurable
    // settings. (Same table previously used for SNMP config — kept as-is
    // so any other settings already stored here are unaffected.)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        \`key\`      VARCHAR(100) NOT NULL PRIMARY KEY,
        value        TEXT         DEFAULT NULL,
        updated_by   CHAR(36)     DEFAULT NULL,
        updated_at   INT UNSIGNED NOT NULL,
        CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Syslog sync tracking columns on audit_log ────────────────────────────
    // syslog_synced:    NULL = never attempted, 0 = attempted & failed, 1 = ok
    // syslog_synced_at: epoch seconds of the last forward attempt
    if (!(await colExists(conn, 'audit_log', 'syslog_synced'))) {
      await conn.query(`ALTER TABLE audit_log ADD COLUMN syslog_synced TINYINT(1) DEFAULT NULL`);
    }
    if (!(await colExists(conn, 'audit_log', 'syslog_synced_at'))) {
      await conn.query(`ALTER TABLE audit_log ADD COLUMN syslog_synced_at INT UNSIGNED DEFAULT NULL`);
    }
    const [idx] = await conn.query(
      `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='audit_log' AND INDEX_NAME='idx_audit_syslog_synced' LIMIT 1`
    );
    if (idx.length === 0) {
      await conn.query(`ALTER TABLE audit_log ADD INDEX idx_audit_syslog_synced (syslog_synced)`);
    }

    console.log('[DB] ✅ Syslog tables ready (system_settings, audit_log.syslog_synced)');
  } finally {
    try { await conn.end(); } catch {}
  }
}

module.exports = { migrateSyslogTables };