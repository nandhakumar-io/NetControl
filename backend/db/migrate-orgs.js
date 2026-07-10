// db/migrate-orgs.js — Multi-tenant (MSP) support + auto-remediation runbooks.
//
// Adds:
//   organizations   — one row per client/tenant
//   org_members     — many-to-many: which users can access which orgs, with
//                      a per-org role (an MSP tech can be 'operator' on one
//                      client and 'admin' on another)
//   users.active_org_id — which org the "switch client" dropdown is
//                      currently pointed at for this user (persisted so it
//                      survives login/reload)
//   org_id column added (nullable, backfilled) to: devices, groups,
//      schedules, alert_rules, runbook_actions, audit_log
//   runbook_actions — reusable named remediation scripts (e.g. "restart
//      nginx", "clear ARP cache") that alert rules can trigger automatically
//   alert_rules.runbook_action_ids — JSON array of runbook_actions.id to
//      run when the rule breaches, independent of the older fixed
//      wake/restart/shutdown actions list
//
// Safe to run repeatedly — every step checks for existence first. A single
// "Default Organization" is created and every pre-existing row is backfilled
// into it, so upgrading an existing single-tenant install is a no-op from
// the user's point of view (nothing becomes invisible or inaccessible).
'use strict';
const path = require('path');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

async function getConn() {
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

async function addColumnIfMissing(conn, table, col, ddl) {
  if (!(await colExists(conn, table, col))) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
    console.log(`  + ${table}.${col}`);
  }
}

async function migrateOrgs() {
  const conn = await getConn();
  try {
    console.log('Running org / multi-tenant migration...');

    // ── organizations ───────────────────────────────────────────────────────
    if (!(await tableExists(conn, 'organizations'))) {
      await conn.query(`
        CREATE TABLE organizations (
          id           CHAR(36)     PRIMARY KEY,
          name         VARCHAR(150) NOT NULL,
          slug         VARCHAR(100) UNIQUE NOT NULL,
          plan         VARCHAR(50)  NOT NULL DEFAULT 'trial',
          device_limit INT          NOT NULL DEFAULT 25,
          created_by   CHAR(36),
          created_at   INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
          suspended    TINYINT(1)   NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + organizations table created');
    }

    // ── org_members ─────────────────────────────────────────────────────────
    if (!(await tableExists(conn, 'org_members'))) {
      await conn.query(`
        CREATE TABLE org_members (
          id         CHAR(36)     PRIMARY KEY,
          org_id     CHAR(36)     NOT NULL,
          user_id    CHAR(36)     NOT NULL,
          org_role   VARCHAR(50)  NOT NULL DEFAULT 'operator',
          created_at INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
          UNIQUE KEY uniq_org_user (org_id, user_id),
          CONSTRAINT fk_orgmember_org  FOREIGN KEY (org_id)  REFERENCES organizations(id) ON DELETE CASCADE,
          CONSTRAINT fk_orgmember_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + org_members table created');
    }

    // ── runbook_actions (auto-remediation scripts) ───────────────────────────
    if (!(await tableExists(conn, 'runbook_actions'))) {
      await conn.query(`
        CREATE TABLE runbook_actions (
          id          CHAR(36)     PRIMARY KEY,
          org_id      CHAR(36)     DEFAULT NULL,
          name        VARCHAR(150) NOT NULL,
          description TEXT,
          os_type     ENUM('linux','windows','any') NOT NULL DEFAULT 'any',
          command     TEXT         NOT NULL,
          timeout_sec INT UNSIGNED NOT NULL DEFAULT 30,
          created_by  CHAR(36),
          created_at  INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
          INDEX idx_runbook_org (org_id),
          CONSTRAINT fk_runbook_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + runbook_actions table created');
    }

    // ── runbook_run_log (execution history / audit for auto-remediation) ────
    if (!(await tableExists(conn, 'runbook_run_log'))) {
      await conn.query(`
        CREATE TABLE runbook_run_log (
          id            CHAR(36)     PRIMARY KEY,
          runbook_id    CHAR(36)     NOT NULL,
          device_id     CHAR(36)     NOT NULL,
          rule_id       CHAR(36)     DEFAULT NULL,
          triggered_by  VARCHAR(100) NOT NULL,
          result        ENUM('success','failure') NOT NULL,
          output        TEXT,
          ran_at        INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
          INDEX idx_rrl_runbook (runbook_id),
          INDEX idx_rrl_device  (device_id),
          INDEX idx_rrl_ran_at  (ran_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + runbook_run_log table created');
    }

    // ── org_id columns on existing tenant-scoped tables ─────────────────────
    await addColumnIfMissing(conn, 'devices',     'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_devices_org (org_id)');
    await addColumnIfMissing(conn, 'groups',      'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_groups_org (org_id)');
    await addColumnIfMissing(conn, 'schedules',   'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_schedules_org (org_id)');
    await addColumnIfMissing(conn, 'audit_log',   'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_audit_org (org_id)');
    if (await tableExists(conn, 'alert_rules')) {
      await addColumnIfMissing(conn, 'alert_rules', 'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_alertrules_org (org_id)');
      await addColumnIfMissing(conn, 'alert_rules', 'runbook_action_ids', 'runbook_action_ids TEXT DEFAULT NULL');
    }

    // ── org_id on the routes just brought up to the same pattern (backup,
    //    discovery, process policies, and the two scheduled-job tables) ─────
    if (await tableExists(conn, 'backups')) {
      await addColumnIfMissing(conn, 'backups', 'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_backups_org (org_id)');
    }
    if (await tableExists(conn, 'backup_destinations')) {
      await addColumnIfMissing(conn, 'backup_destinations', 'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_backupdest_org (org_id)');
    }
    if (await tableExists(conn, 'discovery_scans')) {
      await addColumnIfMissing(conn, 'discovery_scans', 'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_discoveryscans_org (org_id)');
    }
    if (await tableExists(conn, 'process_policies')) {
      await addColumnIfMissing(conn, 'process_policies', 'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_processpolicies_org (org_id)');
    }
    if (await tableExists(conn, 'backup_schedules')) {
      await addColumnIfMissing(conn, 'backup_schedules', 'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_backupschedules_org (org_id)');
    }
    if (await tableExists(conn, 'log_export_schedules')) {
      await addColumnIfMissing(conn, 'log_export_schedules', 'org_id', 'org_id CHAR(36) DEFAULT NULL, ADD INDEX idx_logexportschedules_org (org_id)');
    }
    // compliance_config/snapshots/baselines/watched_files and process_violations
    // are intentionally NOT given their own org_id — they key off device_id,
    // and devices already carry org_id, so scoping happens via the device
    // join/lookup in routes/compliance.js and routes/processPolicies.js.

    // ── users.active_org_id — which org the UI's "switch client" dropdown
    //    is currently pointed at ────────────────────────────────────────────
    await addColumnIfMissing(conn, 'users', 'active_org_id', 'active_org_id CHAR(36) DEFAULT NULL');

    // ── Backfill: create a Default Organization (once) and attach every
    //    existing DATA row to it if it's still orgless ─────────────────────
    const [existingOrgs] = await conn.query('SELECT id FROM organizations LIMIT 1');
    let defaultOrgId;
    if (existingOrgs.length === 0) {
      defaultOrgId = uuidv4();
      await conn.query(
        `INSERT INTO organizations (id, name, slug, plan, device_limit, created_at) VALUES (?, ?, ?, 'trial', 100000, UNIX_TIMESTAMP())`,
        [defaultOrgId, 'Default Organization', 'default']
      );
      console.log(`  + Default Organization created (${defaultOrgId})`);

      await conn.query('UPDATE devices   SET org_id = ? WHERE org_id IS NULL', [defaultOrgId]);
      await conn.query('UPDATE `groups`  SET org_id = ? WHERE org_id IS NULL', [defaultOrgId]);
      await conn.query('UPDATE schedules SET org_id = ? WHERE org_id IS NULL', [defaultOrgId]);
      if (await tableExists(conn, 'alert_rules')) {
        await conn.query('UPDATE alert_rules SET org_id = ? WHERE org_id IS NULL', [defaultOrgId]);
      }
    } else {
      defaultOrgId = existingOrgs[0].id;
    }

    // Every-run backfill for data tables (unchanged behavior — covers tables
    // that may not have existed yet the first time this ran).
    for (const t of ['backups', 'backup_destinations', 'discovery_scans', 'process_policies', 'backup_schedules', 'log_export_schedules']) {
      if (await tableExists(conn, t)) {
        await conn.query(`UPDATE \`${t}\` SET org_id = ? WHERE org_id IS NULL`, [defaultOrgId]);
      }
    }

    // ── User <-> org backfill — SELF-HEALING, runs on EVERY migrate call ────
    // This used to run only inside the `existingOrgs.length === 0` branch —
    // meaning it fired exactly once, ever, on whichever install happened to
    // be the very first to pick up this migration. Any user created after
    // that moment (a fresh admin from re-running db/setup.js after wiping
    // the DB, a new operator/viewer added via POST /api/users, a restored
    // backup missing org_members rows) was silently left with no
    // organization membership at all — and middleware/tenant.js's
    // requireOrgContext hard-blocks every device/group/schedule/etc. request
    // with 400 NO_ACTIVE_ORG for such a user, with no way to self-recover
    // short of an admin manually fixing the DB.
    //
    // Fix: find every user who currently has zero rows in org_members (not
    // just users that existed the first time this migration ever ran), add
    // each to the default org, and set active_org_id if they don't already
    // have one. Safe to run every time — INSERT IGNORE + the NOT IN
    // subquery mean a user already in an org is left untouched.
    const [orphanedUsers] = await conn.query(`
      SELECT u.id, u.role FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = u.id)
    `);
    if (orphanedUsers.length > 0) {
      for (const u of orphanedUsers) {
        await conn.query(
          `INSERT IGNORE INTO org_members (id, org_id, user_id, org_role, created_at)
           VALUES (?, ?, ?, ?, UNIX_TIMESTAMP())`,
          [uuidv4(), defaultOrgId, u.id, u.role === 'admin' ? 'admin' : u.role]
        );
      }
      await conn.query(
        `UPDATE users SET active_org_id = ? WHERE active_org_id IS NULL AND id IN (${orphanedUsers.map(() => '?').join(',')})`,
        [defaultOrgId, ...orphanedUsers.map(u => u.id)]
      );
      console.log(`  + ${orphanedUsers.length} user(s) with no organization membership added to Default Organization`);
    }

    // Belt-and-suspenders: a user CAN be in org_members yet still have a
    // null active_org_id (e.g. their one membership row was inserted by some
    // other path that didn't set it) — that alone is enough to trigger
    // NO_ACTIVE_ORG, so heal that independently of the orphan check above.
    await conn.query(`
      UPDATE users u
      JOIN org_members m ON m.user_id = u.id
      SET u.active_org_id = m.org_id
      WHERE u.active_org_id IS NULL
    `);

    console.log('✅ Org / multi-tenant migration complete.');
    return defaultOrgId;
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateOrgs().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateOrgs };