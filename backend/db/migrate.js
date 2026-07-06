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
        must_change_password TINYINT(1) NOT NULL DEFAULT 0,
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

  {
    id: '004_google_auth',
    sql: `
      ALTER TABLE users
        ADD COLUMN email        VARCHAR(255) DEFAULT NULL,
        ADD COLUMN google_id    VARCHAR(255) DEFAULT NULL,
        ADD COLUMN has_password TINYINT(1)   NOT NULL DEFAULT 1;

      ALTER TABLE users ADD UNIQUE INDEX uq_users_email     (email);
      ALTER TABLE users ADD UNIQUE INDEX uq_users_google_id (google_id);
    `,
  },

  // BUG FIX: routes/devices.js (PUT /:id and POST /:id/approve-registration)
  // reads and writes `updated_at` and `last_approved_at` on the devices
  // table, and routes/metrics.js's agent-registration flow relies on the
  // approval workflow those columns support — but no migration ever added
  // them, so both endpoints failed at runtime with
  // "Unknown column 'updated_at' in 'field list'".
  {
    id: '005_device_approval_workflow',
    sql: `
      ALTER TABLE devices
        ADD COLUMN updated_at       INT UNSIGNED DEFAULT NULL,
        ADD COLUMN last_approved_at INT UNSIGNED DEFAULT NULL;
    `,
  },

  // BUG FIX: on any DB that already had a `devices` table before
  // agent_key_hash/agent_registered_at existed (created via the old
  // db/setup.js schema), migration 001's `CREATE TABLE IF NOT EXISTS`
  // is a no-op on an existing table, so the column was never added.
  // That caused every poller cycle to fail with "Unknown column
  // 'agent_key_hash' in 'field list'" (statusPoller.js, routes/metrics.js,
  // routes/devices.js, services/webTerminal.js all depend on it).
  {
    id: '006_agent_key_hash_backfill',
    sql: `
      SET @col_exists = (
        SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'agent_key_hash'
      );
      SET @sql = IF(@col_exists = 0,
        'ALTER TABLE devices ADD COLUMN agent_key_hash CHAR(64) DEFAULT NULL, ADD COLUMN agent_registered_at INT UNSIGNED DEFAULT NULL, ADD INDEX idx_devices_agent_key (agent_key_hash)',
        'SELECT 1');
      PREPARE stmt FROM @sql;
      EXECUTE stmt;
      DEALLOCATE PREPARE stmt;
    `,
  },

  // BUG FIX: same class of issue as 006, but for `users`. Migration 001's
  // `CREATE TABLE IF NOT EXISTS users` declares enabled/permissions/
  // display_name, but on any DB where `users` already existed (old
  // db/setup.js schema, which only had id/username/password/role/
  // created_at/last_login), those columns were never added — only
  // must_change_password was patched in separately by setup.js. Every
  // query in routes/users.js and routes/auth.js that reads/writes
  // enabled/permissions/display_name fails with
  // "Unknown column 'enabled' in 'field list'" (etc.) until this runs.
  {
    id: '007_users_enabled_permissions_backfill',
    sql: `
      SET @c1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'enabled');
      SET @sql1 = IF(@c1 = 0,
        'ALTER TABLE users ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1',
        'SELECT 1');
      PREPARE stmt1 FROM @sql1; EXECUTE stmt1; DEALLOCATE PREPARE stmt1;

      SET @c2 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'permissions');
      SET @sql2 = IF(@c2 = 0,
        'ALTER TABLE users ADD COLUMN permissions INT UNSIGNED NOT NULL DEFAULT 255',
        'SELECT 1');
      PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

      SET @c3 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'display_name');
      SET @sql3 = IF(@c3 = 0,
        'ALTER TABLE users ADD COLUMN display_name VARCHAR(100) DEFAULT NULL',
        'SELECT 1');
      PREPARE stmt3 FROM @sql3; EXECUTE stmt3; DEALLOCATE PREPARE stmt3;
    `,
  },

  // BUG FIX: same class of issue as 006/007, but for the remaining `devices`
  // columns from migration 001 (os_version, arch, ssh_port, winrm_*) that
  // never got backfilled onto pre-existing installs. Causes
  // "Unknown column 'os_version' in 'field list'" (and friends) in
  // routes/metrics.js, routes/actions.js, routes/discovery.js,
  // routes/filePush.js, services/scheduler.js, services/scpPush.js,
  // services/ssh.js, services/sshProxy.js.
  {
    id: '008_devices_columns_backfill',
    sql: `
      SET @d1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'os_version');
      SET @sqld1 = IF(@d1 = 0, 'ALTER TABLE devices ADD COLUMN os_version VARCHAR(100) DEFAULT NULL', 'SELECT 1');
      PREPARE stmtd1 FROM @sqld1; EXECUTE stmtd1; DEALLOCATE PREPARE stmtd1;

      SET @d2 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'arch');
      SET @sqld2 = IF(@d2 = 0, 'ALTER TABLE devices ADD COLUMN arch VARCHAR(20) DEFAULT NULL', 'SELECT 1');
      PREPARE stmtd2 FROM @sqld2; EXECUTE stmtd2; DEALLOCATE PREPARE stmtd2;

      SET @d3 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'ssh_port');
      SET @sqld3 = IF(@d3 = 0, 'ALTER TABLE devices ADD COLUMN ssh_port SMALLINT UNSIGNED DEFAULT 22', 'SELECT 1');
      PREPARE stmtd3 FROM @sqld3; EXECUTE stmtd3; DEALLOCATE PREPARE stmtd3;

      SET @d4 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'winrm_username');
      SET @sqld4 = IF(@d4 = 0, 'ALTER TABLE devices ADD COLUMN winrm_username VARCHAR(100) DEFAULT NULL', 'SELECT 1');
      PREPARE stmtd4 FROM @sqld4; EXECUTE stmtd4; DEALLOCATE PREPARE stmtd4;

      SET @d5 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'winrm_password');
      SET @sqld5 = IF(@d5 = 0, 'ALTER TABLE devices ADD COLUMN winrm_password TEXT DEFAULT NULL', 'SELECT 1');
      PREPARE stmtd5 FROM @sqld5; EXECUTE stmtd5; DEALLOCATE PREPARE stmtd5;

      SET @d6 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'winrm_port');
      SET @sqld6 = IF(@d6 = 0, 'ALTER TABLE devices ADD COLUMN winrm_port SMALLINT UNSIGNED DEFAULT 5985', 'SELECT 1');
      PREPARE stmtd6 FROM @sqld6; EXECUTE stmtd6; DEALLOCATE PREPARE stmtd6;
    `,
  },

  // FEATURE: Maintenance mode — lets an operator mark a device as "under
  // maintenance" so status-change alerts and webhooks (device.offline/online,
  // alert.*, ssh.failure, etc.) are suppressed for it until it's marked ok
  // again. See services/webhook.js (fire) and routes/alerts.js (evaluateAlerts)
  // for the enforcement side.
  {
    id: '009_devices_maintenance_mode',
    sql: `
      SET @m1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'maintenance_mode');
      SET @sqlm1 = IF(@m1 = 0, 'ALTER TABLE devices ADD COLUMN maintenance_mode TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
      PREPARE stmtm1 FROM @sqlm1; EXECUTE stmtm1; DEALLOCATE PREPARE stmtm1;

      SET @m2 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'maintenance_note');
      SET @sqlm2 = IF(@m2 = 0, 'ALTER TABLE devices ADD COLUMN maintenance_note VARCHAR(255) DEFAULT NULL', 'SELECT 1');
      PREPARE stmtm2 FROM @sqlm2; EXECUTE stmtm2; DEALLOCATE PREPARE stmtm2;

      SET @m3 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'maintenance_since');
      SET @sqlm3 = IF(@m3 = 0, 'ALTER TABLE devices ADD COLUMN maintenance_since INT UNSIGNED DEFAULT NULL', 'SELECT 1');
      PREPARE stmtm3 FROM @sqlm3; EXECUTE stmtm3; DEALLOCATE PREPARE stmtm3;

      SET @m4 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'maintenance_by');
      SET @sqlm4 = IF(@m4 = 0, 'ALTER TABLE devices ADD COLUMN maintenance_by CHAR(36) DEFAULT NULL', 'SELECT 1');
      PREPARE stmtm4 FROM @sqlm4; EXECUTE stmtm4; DEALLOCATE PREPARE stmtm4;

      SET @m5 = (SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'idx_devices_maintenance');
      SET @sqlm5 = IF(@m5 = 0, 'ALTER TABLE devices ADD INDEX idx_devices_maintenance (maintenance_mode)', 'SELECT 1');
      PREPARE stmtm5 FROM @sqlm5; EXECUTE stmtm5; DEALLOCATE PREPARE stmtm5;
    `,
  },

  // FEATURE: Maintenance auto-expiry — an optional maintenance_until
  // timestamp so a maintenance window clears itself instead of silently
  // suppressing real alerts forever if someone forgets to mark a device ok.
  // Enforced by services/statusPoller.js (clearExpiredMaintenance), which
  // runs every poll tick.
  {
    id: '010_devices_maintenance_until',
    sql: `
      SET @u1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'maintenance_until');
      SET @sqlu1 = IF(@u1 = 0, 'ALTER TABLE devices ADD COLUMN maintenance_until INT UNSIGNED DEFAULT NULL', 'SELECT 1');
      PREPARE stmtu1 FROM @sqlu1; EXECUTE stmtu1; DEALLOCATE PREPARE stmtu1;

      SET @u2 = (SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'idx_devices_maintenance_until');
      SET @sqlu2 = IF(@u2 = 0, 'ALTER TABLE devices ADD INDEX idx_devices_maintenance_until (maintenance_mode, maintenance_until)', 'SELECT 1');
      PREPARE stmtu2 FROM @sqlu2; EXECUTE stmtu2; DEALLOCATE PREPARE stmtu2;
    `,
  },

  // FEATURE: Process restriction policies — lets an admin block/alert on
  // specific programs/processes running on agents (global, per-group, or
  // per-device), and a log of every time an agent detected/enforced one.
  // Enforced by the agent (netcontrol-agent.js), reported via
  // POST /api/metrics/violation, defined via /api/process-policies.
  {
    id: '011_process_policies',
    sql: `
      CREATE TABLE IF NOT EXISTS process_policies (
        id            CHAR(36)     NOT NULL PRIMARY KEY,
        device_id     CHAR(36)     DEFAULT NULL COMMENT 'NULL = not device-specific',
        group_id      CHAR(36)     DEFAULT NULL COMMENT 'NULL = not group-specific; both NULL = global',
        process_name  VARCHAR(255) NOT NULL,
        match_type    VARCHAR(10)  NOT NULL DEFAULT 'contains' COMMENT 'exact|contains',
        action        VARCHAR(10)  NOT NULL DEFAULT 'alert' COMMENT 'alert|kill',
        os_type       VARCHAR(10)  DEFAULT NULL COMMENT 'NULL = any, linux|windows',
        enabled       TINYINT(1)   NOT NULL DEFAULT 1,
        created_by    CHAR(36)     DEFAULT NULL,
        created_at    INT UNSIGNED NOT NULL,
        INDEX idx_pp_device  (device_id),
        INDEX idx_pp_group   (group_id),
        INDEX idx_pp_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      CREATE TABLE IF NOT EXISTS process_violations (
        id            CHAR(36)     NOT NULL PRIMARY KEY,
        device_id     CHAR(36)     NOT NULL,
        policy_id     CHAR(36)     DEFAULT NULL,
        process_name  VARCHAR(255) NOT NULL,
        pid           INT          DEFAULT NULL,
        action_taken  VARCHAR(10)  NOT NULL DEFAULT 'alert' COMMENT 'alert|kill',
        kill_result   VARCHAR(20)  DEFAULT NULL COMMENT 'killed|failed|not_attempted',
        detected_at   INT UNSIGNED NOT NULL,
        INDEX idx_pv_device (device_id),
        INDEX idx_pv_time   (detected_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
  },

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

run()
  .then(async () => {
    // Run security tables (ip_allowlist, webhooks) using a plain connection
    try {
      const { migrateSecurityTables } = require('./migrate-security');
      await migrateSecurityTables();
      console.log('  ✓ security_tables (ip_allowlist, webhooks)');
    } catch (e) {
      console.warn('  ⚠  security_tables:', e.message);
    }
    try {
      const { migrateDiscoveryTables } = require('./migrate-discovery');
      await migrateDiscoveryTables();
      console.log('  ✓ discovery_tables (discovery_scans, discovery_results)');
    } catch (e) {
      console.warn('  ⚠  discovery_tables:', e.message);
    }
    try {
      const { migrateBruteForceTables } = require('./migrate-bruteforce');
      await migrateBruteForceTables();
      console.log('  ✓ bruteforce_tables (ip_bans, ip_ban_log)');
    } catch (e) {
      console.warn('  ⚠  bruteforce_tables:', e.message);
    }
    try {
      const { migrateSnmpTables } = require('./migrate-snmp');
      await migrateSnmpTables();
      console.log('  ✓ snmp_tables (system_settings, audit_log.snmp_synced)');
    } catch (e) {
      console.warn('  ⚠  snmp_tables:', e.message);
    }
    try {
      const { migrateDeviceHistoryTables } = require('./migrate-device-history');
      await migrateDeviceHistoryTables();
      console.log('  ✓ device_history (device_status_history)');
    } catch (e) {
      console.warn('  ⚠  device_history:', e.message);
    }
    try {
      const { migrateComplianceTables } = require('./migrate-compliance');
      await migrateComplianceTables();
    } catch (e) {
      console.warn('  ⚠  compliance_tables:', e.message);
    }
    try {
      const { migrateMetricsHistoryTables } = require('./migrate-metrics-history');
      await migrateMetricsHistoryTables();
      console.log('  ✓ metrics_history (long-term metrics for the Monitoring History page)');
    } catch (e) {
      console.warn('  ⚠  metrics_history:', e.message);
    }
    try {
      const { migrateBackupsTables } = require('./migrate-backup');
      await migrateBackupsTables();
      console.log('  ✓ backups (file/folder backup archive index)');
    } catch (e) {
      console.warn('  ⚠  backups:', e.message);
    }
    console.log('\n✅ All done.\n');
  })
  .then(() => process.exit(0))  // Always exit — don't let pool timers hang node
  .catch(err => {
    console.error('\n❌ Migration failed:', err.message, '\n');
    process.exit(1);
  });