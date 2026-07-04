// db/migrate-compliance.js — Config drift / compliance snapshot tables
// Uses its own plain mysql2 connection so it can be called from migrate.js
// without spinning up the full 100-connection pool. Mirrors migrate-discovery.js.
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

async function migrateComplianceTables() {
  const conn = await getConn();
  try {
    // ── Per-device compliance settings ────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS compliance_config (
        device_id           CHAR(36)     NOT NULL PRIMARY KEY,
        enabled             TINYINT(1)   NOT NULL DEFAULT 0,
        check_interval_hours INT UNSIGNED NOT NULL DEFAULT 24,
        last_checked_at     INT UNSIGNED DEFAULT NULL,
        updated_at          INT UNSIGNED NOT NULL,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Baseline: the "known good" snapshot each device is diffed against ────
    // One active baseline per device — re-baselining overwrites the row
    // rather than accumulating (history isn't needed for a baseline, only
    // for snapshots below).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS compliance_baselines (
        device_id       CHAR(36)     NOT NULL PRIMARY KEY,
        packages        LONGTEXT     COMMENT 'Newline-separated installed-package list',
        services        LONGTEXT     COMMENT 'Newline-separated running-service list',
        firewall_rules  LONGTEXT     COMMENT 'Newline-separated firewall rule list',
        raw_hash        CHAR(64)     NOT NULL COMMENT 'sha256 over the three lists combined',
        set_by          CHAR(36)     DEFAULT NULL,
        created_at      INT UNSIGNED NOT NULL,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        FOREIGN KEY (set_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Snapshot history — one row per check, kept for trend/audit purposes ──
    await conn.query(`
      CREATE TABLE IF NOT EXISTS compliance_snapshots (
        id              CHAR(36)     NOT NULL PRIMARY KEY,
        device_id       CHAR(36)     NOT NULL,
        packages        LONGTEXT,
        services        LONGTEXT,
        firewall_rules  LONGTEXT,
        raw_hash        CHAR(64)     DEFAULT NULL,
        status          VARCHAR(20)  NOT NULL COMMENT 'clean|drift|error',
        diff            LONGTEXT     COMMENT 'JSON: {packages:{added,removed}, services:{...}, firewall_rules:{...}}',
        error           TEXT         DEFAULT NULL,
        taken_at        INT UNSIGNED NOT NULL,
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        INDEX idx_device_taken (device_id, taken_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('  ✓ compliance_tables (compliance_config, compliance_baselines, compliance_snapshots)');
  } finally {
    await conn.end();
  }
}

module.exports = { migrateComplianceTables };

if (require.main === module) {
  migrateComplianceTables()
    .then(() => process.exit(0))
    .catch(err => { console.error('❌', err.message); process.exit(1); });
}