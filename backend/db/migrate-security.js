// db/migrate-security.js — IP allowlist + webhook tables
// Uses its own plain mysql2 connection so it can be called from migrate.js
// without spinning up the full 100-connection pool.
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

async function exists(conn, table) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1`,
    [table]
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

async function migrateSecurityTables() {
  const conn = await getConn();
  try {
    // ── IP Allowlist ──────────────────────────────────────────────────────────
    // Stores CIDR ranges or exact IPs per user (null user_id = global rule)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ip_allowlist (
        id          CHAR(36)     NOT NULL PRIMARY KEY,
        user_id     CHAR(36)     DEFAULT NULL COMMENT 'NULL = global rule for all users',
        role        VARCHAR(20)  DEFAULT NULL COMMENT 'NULL = applies to specific user only',
        cidr        VARCHAR(50)  NOT NULL     COMMENT 'CIDR range or exact IP, e.g. 192.168.1.0/24',
        label       VARCHAR(100) DEFAULT NULL COMMENT 'Human-readable description',
        enabled     TINYINT(1)   NOT NULL DEFAULT 1,
        created_by  CHAR(36)     DEFAULT NULL,
        created_at  INT UNSIGNED NOT NULL,
        INDEX idx_ipal_user   (user_id),
        INDEX idx_ipal_role   (role),
        INDEX idx_ipal_enabled(enabled),
        CONSTRAINT fk_ipal_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Track failed IP attempts for security alerting
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ip_block_log (
        id          CHAR(36)     NOT NULL PRIMARY KEY,
        username    VARCHAR(100) DEFAULT NULL,
        ip          VARCHAR(50)  NOT NULL,
        reason      VARCHAR(200) NOT NULL,
        blocked_at  INT UNSIGNED NOT NULL,
        INDEX idx_ibl_ip   (ip),
        INDEX idx_ibl_time (blocked_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Webhooks ──────────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id          CHAR(36)     NOT NULL PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        url         VARCHAR(500) NOT NULL,
        provider    VARCHAR(30)  NOT NULL DEFAULT 'generic' COMMENT 'slack|teams|email|generic',
        secret      VARCHAR(200) DEFAULT NULL COMMENT 'Optional HMAC signing secret',
        events      TEXT         NOT NULL COMMENT 'JSON array of event names',
        enabled     TINYINT(1)   NOT NULL DEFAULT 1,
        last_status SMALLINT     DEFAULT NULL COMMENT 'Last HTTP response status',
        last_fired  INT UNSIGNED DEFAULT NULL,
        fail_count  SMALLINT     NOT NULL DEFAULT 0,
        created_by  CHAR(36)     DEFAULT NULL,
        created_at  INT UNSIGNED NOT NULL,
        INDEX idx_wh_enabled(enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Webhook delivery log — for debugging failed deliveries
    await conn.query(`
      CREATE TABLE IF NOT EXISTS webhook_log (
        id          CHAR(36)     NOT NULL PRIMARY KEY,
        webhook_id  CHAR(36)     NOT NULL,
        event       VARCHAR(100) NOT NULL,
        status      SMALLINT     NOT NULL,
        duration_ms SMALLINT     DEFAULT NULL,
        error       TEXT         DEFAULT NULL,
        fired_at    INT UNSIGNED NOT NULL,
        INDEX idx_whl_webhook(webhook_id),
        INDEX idx_whl_time  (fired_at),
        CONSTRAINT fk_whl_wh FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('[DB] ✅ Security tables (ip_allowlist, webhooks) ready');
  } finally {
    try { await conn.end(); } catch {}
  }
}

module.exports = { migrateSecurityTables };
