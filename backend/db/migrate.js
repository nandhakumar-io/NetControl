#!/usr/bin/env node
// db/migrate.js — Versioned migration runner
// Run manually: node db/migrate.js
// Never called from server.js — migrations are a deploy step, not a boot step.
//
// Each migration is numbered and tracked in a schema_migrations table.
// Already-applied migrations are skipped. New ones run in order.
// Safe to run multiple times.

'use strict';
const path = require('path');
// Always load .env from the backend root, regardless of where this script is invoked from.
// Works whether you run:  node db/migrate.js   (from backend/)
//                    or:  node migrate.js       (from backend/db/)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const mysql  = require('mysql2/promise');
const crypto = require('crypto');

// ── Connection ────────────────────────────────────────────────────────────────
async function connect() {
  return mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'netcontrol',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME     || 'netcontrol',
    multipleStatements: true,
    timezone: '+00:00',
  });
}

// ── Migration list — ADD NEW ONES AT THE BOTTOM ONLY ─────────────────────────
const MIGRATIONS = [

  {
    id: '001_initial_schema',
    sql: `
      SET FOREIGN_KEY_CHECKS = 0;

      CREATE TABLE IF NOT EXISTS users (
        id          CHAR(36)     PRIMARY KEY,
        username    VARCHAR(100) UNIQUE NOT NULL,
        password    VARCHAR(255) NOT NULL,
        role        VARCHAR(50)  NOT NULL DEFAULT 'admin',
        enabled     TINYINT(1)   NOT NULL DEFAULT 1,
        permissions INT UNSIGNED NOT NULL DEFAULT 255,
        display_name VARCHAR(100) DEFAULT NULL,
        created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        last_login  INT UNSIGNED
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS \`groups\` (
        id          CHAR(36)     PRIMARY KEY,
        name        VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP())
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS devices (
        id                  CHAR(36)      PRIMARY KEY,
        name                VARCHAR(100)  NOT NULL,
        ip_address          VARCHAR(45)   NOT NULL,
        mac_address         VARCHAR(17)   NOT NULL,
        os_type             ENUM('windows','linux') NOT NULL,
        os_version          VARCHAR(100)  DEFAULT NULL,
        arch                VARCHAR(20)   DEFAULT NULL,
        group_id            CHAR(36)      DEFAULT NULL,
        ssh_username        VARCHAR(100)  DEFAULT NULL,
        ssh_password        TEXT          DEFAULT NULL,
        ssh_key             MEDIUMTEXT    DEFAULT NULL,
        ssh_port            SMALLINT UNSIGNED DEFAULT 22,
        rpc_username        VARCHAR(100)  DEFAULT NULL,
        rpc_password        TEXT          DEFAULT NULL,
        winrm_username      VARCHAR(100)  DEFAULT NULL,
        winrm_password      TEXT          DEFAULT NULL,
        winrm_port          SMALLINT UNSIGNED DEFAULT 5985,
        agent_key_hash      CHAR(64)      DEFAULT NULL,
        agent_registered_at INT UNSIGNED  DEFAULT NULL,
        status              VARCHAR(20)   DEFAULT 'unknown',
        last_seen           INT UNSIGNED  DEFAULT NULL,
        created_at          INT UNSIGNED  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        INDEX idx_devices_group     (group_id),
        INDEX idx_devices_agent_key (agent_key_hash),
        INDEX idx_devices_status    (status),
        CONSTRAINT fk_device_group FOREIGN KEY (group_id)
          REFERENCES \`groups\`(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS schedules (
        id          CHAR(36)     PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        action      ENUM('wake','shutdown','restart') NOT NULL,
        cron_expr   VARCHAR(100) NOT NULL,
        target_type ENUM('device','group') NOT NULL,
        target_id   CHAR(36)     NOT NULL,
        enabled     TINYINT(1)   NOT NULL DEFAULT 1,
        created_by  CHAR(36)     DEFAULT NULL,
        created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        last_run    INT UNSIGNED DEFAULT NULL,
        next_run    INT UNSIGNED DEFAULT NULL,
        CONSTRAINT fk_schedule_user FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS audit_log (
        id          CHAR(36)     PRIMARY KEY,
        timestamp   INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        user_id     CHAR(36)     DEFAULT NULL,
        username    VARCHAR(100) NOT NULL,
        action      VARCHAR(100) NOT NULL,
        target_type VARCHAR(50)  DEFAULT NULL,
        target_id   CHAR(36)     DEFAULT NULL,
        target_name VARCHAR(100) DEFAULT NULL,
        ip_source   VARCHAR(45)  DEFAULT NULL,
        result      ENUM('success','failure','partial') NOT NULL,
        details     TEXT         DEFAULT NULL,
        INDEX idx_audit_timestamp (timestamp),
        INDEX idx_audit_action    (action),
        INDEX idx_audit_user      (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          CHAR(36)     PRIMARY KEY,
        user_id     CHAR(36)     NOT NULL,
        token_hash  CHAR(64)     NOT NULL,
        expires_at  INT UNSIGNED NOT NULL,
        created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        revoked     TINYINT(1)   NOT NULL DEFAULT 0,
        UNIQUE KEY uq_rt_hash (token_hash),
        CONSTRAINT fk_refresh_user FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      SET FOREIGN_KEY_CHECKS = 1;
    `,
  },

  {
    id: '002_alert_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS alert_rules (
        id            CHAR(36)      NOT NULL PRIMARY KEY,
        name          VARCHAR(200)  NOT NULL,
        metric        VARCHAR(50)   NOT NULL,
        operator      VARCHAR(10)   NOT NULL DEFAULT 'gt',
        threshold     FLOAT         NOT NULL DEFAULT 90,
        severity      VARCHAR(20)   NOT NULL DEFAULT 'warning',
        device_id     CHAR(36)      DEFAULT NULL,
        actions       TEXT          NOT NULL,
        notify_admins TINYINT(1)    NOT NULL DEFAULT 1,
        cooldown_sec  INT UNSIGNED  NOT NULL DEFAULT 300,
        enabled       TINYINT(1)    NOT NULL DEFAULT 1,
        created_by    CHAR(36)      DEFAULT NULL,
        created_at    INT UNSIGNED  NOT NULL,
        INDEX idx_ar_device  (device_id),
        INDEX idx_ar_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS alert_triggered_log (
        id            CHAR(36)     NOT NULL PRIMARY KEY,
        rule_id       CHAR(36)     NOT NULL,
        device_id     CHAR(36)     DEFAULT NULL,
        triggered_at  INT UNSIGNED NOT NULL,
        severity      VARCHAR(20)  NOT NULL DEFAULT 'warning',
        details       TEXT         DEFAULT NULL,
        actions_taken TEXT         DEFAULT NULL,
        resolved_at   INT UNSIGNED DEFAULT NULL,
        INDEX idx_atl_rule   (rule_id),
        INDEX idx_atl_device (device_id),
        INDEX idx_atl_time   (triggered_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS alert_notifications (
        id            CHAR(36)     NOT NULL PRIMARY KEY,
        user_id       CHAR(36)     NOT NULL,
        rule_id       CHAR(36)     DEFAULT NULL,
        device_id     CHAR(36)     DEFAULT NULL,
        severity      VARCHAR(20)  NOT NULL DEFAULT 'warning',
        message       TEXT         NOT NULL,
        triggered_at  INT UNSIGNED NOT NULL,
        read_at       INT UNSIGNED DEFAULT NULL,
        INDEX idx_an_user   (user_id),
        INDEX idx_an_time   (triggered_at),
        INDEX idx_an_unread (user_id, read_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
  },

  // ── ADD NEW MIGRATIONS HERE ─────────────────────────────────────────────────

  {
    id: '003_user_group_access',
    sql: `
      CREATE TABLE IF NOT EXISTS user_group_access (
        user_id    CHAR(36)     NOT NULL,
        group_id   CHAR(36)     NOT NULL,
        granted_by CHAR(36)     DEFAULT NULL,
        granted_at INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        PRIMARY KEY (user_id, group_id),
        INDEX idx_uga_user  (user_id),
        INDEX idx_uga_group (group_id),
        CONSTRAINT fk_uga_user  FOREIGN KEY (user_id)    REFERENCES users(id)     ON DELETE CASCADE,
        CONSTRAINT fk_uga_group FOREIGN KEY (group_id)   REFERENCES \`groups\`(id) ON DELETE CASCADE,
        CONSTRAINT fk_uga_grntd FOREIGN KEY (granted_by) REFERENCES users(id)     ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },

  // {
  //   id: '004_your_migration_name',
  //   sql: \`ALTER TABLE ... ;\`,
  // },

];

// ── Runner ────────────────────────────────────────────────────────────────────
async function run() {
  const conn = await connect();
  console.log('\n🔌 Connected to database\n');

  try {
    // Create tracking table if it doesn't exist
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         VARCHAR(200) PRIMARY KEY,
        applied_at INT UNSIGNED NOT NULL,
        checksum   CHAR(64)     NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Load already-applied migrations
    const [applied] = await conn.query('SELECT id FROM schema_migrations');
    const appliedSet = new Set(applied.map(r => r.id));

    let ran = 0;
    for (const migration of MIGRATIONS) {
      if (appliedSet.has(migration.id)) {
        console.log(`  ✓ ${migration.id} (already applied)`);
        continue;
      }

      process.stdout.write(`  ⟳ ${migration.id} … `);
      const checksum = crypto.createHash('sha256').update(migration.sql).digest('hex');

      await conn.query(migration.sql);
      await conn.query(
        'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)',
        [migration.id, Math.floor(Date.now() / 1000), checksum]
      );

      console.log('✅');
      ran++;
    }

    if (ran === 0) {
      console.log('\n✅ Database is up to date — nothing to apply.\n');
    } else {
      console.log(`\n✅ Applied ${ran} migration${ran > 1 ? 's' : ''}.\n`);
    }

  } finally {
    await conn.end();
  }
}

run().catch(err => {
  console.error('\n❌ Migration failed:', err.message, '\n');
  process.exit(1);
});
