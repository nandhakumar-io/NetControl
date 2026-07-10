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

  // FEATURE: Alert noise control + escalation + Telegram notifications.
  //
  // Why: the old cooldown logic lived entirely in an in-memory JS Map inside
  // routes/alerts.js (see git history). That worked when everything ran in
  // one process, but routes/metrics.js — which is what actually calls
  // evaluateAlerts() for cpu/ram/disk breaches — runs inside the clustered
  // web tier, not the single dedicated poller. Each clustered worker has its
  // own copy of that Map, so the "same" rule+device breach got tracked
  // separately per worker: an agent's metric POSTs land on whichever worker
  // the load balancer picks, so cooldown_sec was only ever enforced within
  // a single worker's slice of traffic — the real world-visible cooldown
  // could be far shorter than configured, spiking notification volume
  // instead of controlling it. Moving this state into the database (a
  // couple of extra queries per rule check, negligible next to a poll
  // interval measured in tens of seconds) makes it correct across every
  // worker and across poller/server restarts.
  //
  // alert_state also tracks flapping (a rule that keeps flipping
  // breached/resolved gets ONE "unstable" notice instead of one per flip)
  // and enables escalation (an unresolved/unacknowledged breach open past
  // escalate_after_sec gets re-notified, optionally at a higher severity
  // and/or via a separate escalation channel — e.g. warn on Slack, escalate
  // to Telegram if nobody's dealt with it in 15 minutes).
  {
    id: '012_alert_escalation_noise_control',
    sql: `
      CREATE TABLE IF NOT EXISTS alert_state (
        rule_id            CHAR(36)     NOT NULL,
        device_id          CHAR(36)     NOT NULL,
        is_active          TINYINT(1)   NOT NULL DEFAULT 0,
        first_breached_at  INT UNSIGNED DEFAULT NULL,
        last_notified_at   INT UNSIGNED DEFAULT NULL,
        notify_count       INT UNSIGNED NOT NULL DEFAULT 0,
        last_log_id        CHAR(36)     DEFAULT NULL COMMENT 'most recent alert_triggered_log row, so ack status can be checked before escalating',
        flap_count         INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'breached/resolved transitions seen within the current flap window',
        flap_window_start  INT UNSIGNED DEFAULT NULL,
        flapping           TINYINT(1)   NOT NULL DEFAULT 0,
        last_transition_at INT UNSIGNED DEFAULT NULL,
        PRIMARY KEY (rule_id, device_id),
        INDEX idx_as_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

      SET @e1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND COLUMN_NAME = 'escalate_after_sec');
      SET @sqle1 = IF(@e1 = 0, 'ALTER TABLE alert_rules ADD COLUMN escalate_after_sec INT UNSIGNED DEFAULT NULL COMMENT ''seconds a breach can stay open/un-acked before escalating; NULL = never''', 'SELECT 1');
      PREPARE stmte1 FROM @sqle1; EXECUTE stmte1; DEALLOCATE PREPARE stmte1;

      SET @e2 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND COLUMN_NAME = 'escalate_severity');
      SET @sqle2 = IF(@e2 = 0, 'ALTER TABLE alert_rules ADD COLUMN escalate_severity VARCHAR(20) NOT NULL DEFAULT ''critical''', 'SELECT 1');
      PREPARE stmte2 FROM @sqle2; EXECUTE stmte2; DEALLOCATE PREPARE stmte2;

      SET @e3 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules' AND COLUMN_NAME = 'escalate_webhook_ids');
      SET @sqle3 = IF(@e3 = 0, 'ALTER TABLE alert_rules ADD COLUMN escalate_webhook_ids TEXT DEFAULT NULL COMMENT ''JSON array of webhook ids to notify on escalation; NULL = use the rule''''s normal webhook routing''', 'SELECT 1');
      PREPARE stmte3 FROM @sqle3; EXECUTE stmte3; DEALLOCATE PREPARE stmte3;

      SET @a1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_triggered_log' AND COLUMN_NAME = 'acknowledged_at');
      SET @sqla1 = IF(@a1 = 0, 'ALTER TABLE alert_triggered_log ADD COLUMN acknowledged_at INT UNSIGNED DEFAULT NULL', 'SELECT 1');
      PREPARE stmta1 FROM @sqla1; EXECUTE stmta1; DEALLOCATE PREPARE stmta1;

      SET @a2 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_triggered_log' AND COLUMN_NAME = 'acknowledged_by');
      SET @sqla2 = IF(@a2 = 0, 'ALTER TABLE alert_triggered_log ADD COLUMN acknowledged_by CHAR(36) DEFAULT NULL', 'SELECT 1');
      PREPARE stmta2 FROM @sqla2; EXECUTE stmta2; DEALLOCATE PREPARE stmta2;
    `,
  },

  // NOTE: the webhooks.chat_id / webhooks.min_severity columns that used to
  // be added here have been moved out — see migrateWebhookNoiseColumns()
  // below, invoked in the post-run chain *after* migrateSecurityTables().
  // Reason: `webhooks` is created by migrate-security.js, which (like
  // migrate-scheduled-jobs.js) runs *after* this whole MIGRATIONS array, in
  // the .then() chain at the bottom of this file. The info_schema guard here
  // only checks whether the *column* exists, not the table, so on any DB
  // where `webhooks` didn't already exist this ALTER failed outright with
  // "Table 'webhooks' doesn't exist" and aborted the whole migration run —
  // same bug as the old 013 migration, fixed the same way.

  // NOTE: what was previously "013_schedule_consecutive_failures" has been
  // moved out of this versioned array — see migrateConsecutiveFailures()
  // below, invoked in the post-run chain *after* migrateScheduledJobs().
  // Reason: this migration ALTERs backup_schedules / log_export_schedules,
  // but those tables are only created by migrateScheduledJobs(), which used
  // to run *after* this whole MIGRATIONS array (in the .then() chain at the
  // bottom of this file). On any DB where those tables didn't already
  // exist, this ALTER failed with "Table 'backup_schedules' doesn't exist"
  // (the info_schema guard only checks for the *column*, not the table),
  // which threw and aborted the entire migration run. Running it after
  // migrateScheduledJobs() instead guarantees the tables exist first.

  // ── 014: webhook_log.response_body backfill ────────────────────────────
  // BUG FIX: services/webhook.js previously tried to backfill this column
  // with a bare "ALTER TABLE ... ADD COLUMN IF NOT EXISTS", which isn't
  // reliably supported across MySQL/MariaDB versions. On any install where
  // webhook_log already existed without this column, that ALTER silently
  // failed every time (caught by .catch(() => {})), so the column was
  // never added — and every delivery-log INSERT (which always references
  // response_body) then failed too, leaving the delivery log permanently
  // empty even though deliveries themselves were succeeding. Formalized
  // here using the same info_schema-gated pattern as every other ALTER in
  // this file, which is known to work everywhere this app runs.
  // NOTE: what was previously "014_webhook_log_response_body" has been
  // folded into migrateWebhookNoiseColumns() below — same root cause
  // (webhook_log is also only created by migrateSecurityTables(), which
  // runs after this array), so it's fixed the same way, in the same call.

];

// ── Post-hoc: webhooks noise-control columns (chat_id, min_severity) ──────
// Must run *after* migrateSecurityTables() has created `webhooks` — see
// NOTE above where this used to live inside versioned migration 012.
async function migrateWebhookNoiseColumns() {
  const conn = await connect();
  try {
    await conn.query(`
      SET @w1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'chat_id');
      SET @sqlw1 = IF(@w1 = 0, 'ALTER TABLE webhooks ADD COLUMN chat_id VARCHAR(100) DEFAULT NULL COMMENT ''Telegram chat/channel id — unused by other providers''', 'SELECT 1');
      PREPARE stmtw1 FROM @sqlw1; EXECUTE stmtw1; DEALLOCATE PREPARE stmtw1;

      SET @w2 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhooks' AND COLUMN_NAME = 'min_severity');
      SET @sqlw2 = IF(@w2 = 0, 'ALTER TABLE webhooks ADD COLUMN min_severity VARCHAR(20) NOT NULL DEFAULT ''info'' COMMENT ''only deliver events at or above this severity: info < warning < critical''', 'SELECT 1');
      PREPARE stmtw2 FROM @sqlw2; EXECUTE stmtw2; DEALLOCATE PREPARE stmtw2;

      SET @rb1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'webhook_log' AND COLUMN_NAME = 'response_body');
      SET @sqlrb1 = IF(@rb1 = 0, 'ALTER TABLE webhook_log ADD COLUMN response_body TEXT DEFAULT NULL', 'SELECT 1');
      PREPARE stmtrb1 FROM @sqlrb1; EXECUTE stmtrb1; DEALLOCATE PREPARE stmtrb1;
    `);
  } finally {
    await conn.end();
  }
}

// ── Post-hoc: consecutive_failures counters for backup + log-export schedules ──
// Lets the backup.failed / log_export.failed webhook events escalate their
// severity from 'warning' to 'critical' after N runs in a row have failed
// (same "don't page on a single blip, but do page on a pattern" idea as
// alert-rule escalation). Must run *after* migrateScheduledJobs() has
// created backup_schedules / log_export_schedules — see NOTE above where
// this used to live as versioned migration 013.
async function migrateConsecutiveFailures() {
  const conn = await connect();
  try {
    await conn.query(`
      SET @cf1 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_schedules' AND COLUMN_NAME = 'consecutive_failures');
      SET @sqlcf1 = IF(@cf1 = 0, 'ALTER TABLE backup_schedules ADD COLUMN consecutive_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
      PREPARE stmtcf1 FROM @sqlcf1; EXECUTE stmtcf1; DEALLOCATE PREPARE stmtcf1;

      SET @cf2 = (SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'log_export_schedules' AND COLUMN_NAME = 'consecutive_failures');
      SET @sqlcf2 = IF(@cf2 = 0, 'ALTER TABLE log_export_schedules ADD COLUMN consecutive_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
      PREPARE stmtcf2 FROM @sqlcf2; EXECUTE stmtcf2; DEALLOCATE PREPARE stmtcf2;
    `);
  } finally {
    await conn.end();
  }
}

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
      await migrateWebhookNoiseColumns();
      console.log('  ✓ webhook_noise_columns (webhooks.chat_id, webhooks.min_severity)');
    } catch (e) {
      console.warn('  ⚠  webhook_noise_columns:', e.message);
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
      const { migrateSyslogTables } = require('./migrate-syslog');
      await migrateSyslogTables();
      console.log('  ✓ syslog_tables (system_settings, audit_log.syslog_synced)');
    } catch (e) {
      console.warn('  ⚠  syslog_tables:', e.message);
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
    try {
      const { migrateBackupDestinations } = require('./migrate-backup-destinations');
      await migrateBackupDestinations();
      console.log('  ✓ backup_destinations (S3 / remote-folder targets)');
    } catch (e) {
      console.warn('  ⚠  backup_destinations:', e.message);
    }
    try {
      const { migrateScheduledJobs } = require('./migrate-scheduled-jobs');
      await migrateScheduledJobs();
      console.log('  ✓ scheduled_jobs (backup_schedules, log_export_schedules)');
    } catch (e) {
      console.warn('  ⚠  scheduled_jobs:', e.message);
    }
    try {
      await migrateConsecutiveFailures();
      console.log('  ✓ schedule_consecutive_failures (backup_schedules/log_export_schedules.consecutive_failures)');
    } catch (e) {
      console.warn('  ⚠  schedule_consecutive_failures:', e.message);
    }
    try {
      const { migrateLogExportTarget } = require('./migrate-log-export-target');
      await migrateLogExportTarget();
      console.log('  ✓ log_export_schedules.export_target (file/syslog)');
    } catch (e) {
      console.warn('  ⚠  log_export_schedules.export_target:', e.message);
    }
    try {
      const { migrateTwoFactor } = require('./migrate-2fa');
      await migrateTwoFactor();
      console.log('  ✓ two_factor (users.totp_secret/totp_enabled/totp_backup_codes)');
    } catch (e) {
      console.warn('  ⚠  two_factor:', e.message);
    }
    try {
      const { migrateBackupVerify } = require('./migrate-backup-verify');
      await migrateBackupVerify();
      console.log('  ✓ backup_verify (backups.verify_status/verified_at/verify_error/verify_checksum)');
    } catch (e) {
      console.warn('  ⚠  backup_verify:', e.message);
    }
    try {
      const { migrateDigestTables } = require('./migrate-digest');
      await migrateDigestTables();
      console.log('  ✓ digest_tables (digest_schedules, digest_log)');
    } catch (e) {
      console.warn('  ⚠  digest_tables:', e.message);
    }
    try {
      const { migratePollerHeartbeat } = require('./migrate-poller-heartbeat');
      await migratePollerHeartbeat();
      console.log('  ✓ poller_heartbeat (lets /api/health/full detect a dead poller process)');
    } catch (e) {
      console.warn('  ⚠  poller_heartbeat:', e.message);
    }
    try {
      const { migrateApiKeys } = require('./migrate-api-keys');
      await migrateApiKeys();
      console.log('  ✓ api_keys (long-lived scoped keys for scripts/Terraform/CI)');
    } catch (e) {
      console.warn('  ⚠  api_keys:', e.message);
    }
    try {
      const { migrateOrgs } = require('./migrate-orgs');
      await migrateOrgs();
      console.log('  ✓ orgs (multi-tenant/MSP client isolation + auto-remediation runbooks)');
    } catch (e) {
      console.warn('  ⚠  orgs:', e.message);
    }
    try {
      const { migrateSlaReports } = require('./migrate-sla-reports');
      await migrateSlaReports();
      console.log('  ✓ sla_reports (uptime/SLA PDF report storage)');
    } catch (e) {
      console.warn('  ⚠  sla_reports:', e.message);
    }
    try {
      const { migrateSlaReportSchedules } = require('./migrate-sla-report-schedules');
      await migrateSlaReportSchedules();
      console.log('  ✓ sla_report_schedules (monthly automatic SLA report generation)');
    } catch (e) {
      console.warn('  ⚠  sla_report_schedules:', e.message);
    }
    try {
      const { migrateDeviceHostname } = require('./migrate-device-hostname');
      await migrateDeviceHostname();
      console.log('  ✓ devices.hostname (immutable OS hostname, separate from the editable display name)');
    } catch (e) {
      console.warn('  ⚠  devices.hostname:', e.message);
    }
    try {
      const { migrateLabLayout } = require('./migrate-lab-layout');
      await migrateLabLayout();
      console.log('  ✓ lab_layout (theater-style seat layout for lab groups)');
    } catch (e) {
      console.warn('  ⚠  lab_layout:', e.message);
    }
    try {
      const { migrateAgentEnrollment } = require('./migrate-agent-enrollment');
      await migrateAgentEnrollment();
      console.log('  ✓ agent enrollment tokens (per-org, fixes agent devices never getting org_id set)');
    } catch (e) {
      console.warn('  ⚠  agent enrollment tokens:', e.message);
    }
    console.log('\n✅ All done.\n');
  })
  .then(() => process.exit(0))  // Always exit — don't let pool timers hang node
  .catch(err => {
    console.error('\n❌ Migration failed:', err.message, '\n');
    process.exit(1);
  });