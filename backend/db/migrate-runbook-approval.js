// db/migrate-runbook-approval.js — Approval gate for auto-remediation runbooks.
//
// Today (routes/alerts.js performAlertActions) any runbook listed in
// alert_rules.runbook_action_ids fires immediately and unattended the
// moment a rule breaches. That's fine for read-only/low-risk commands
// ("clear ARP cache") but risky for anything destructive ("restart nginx"
// on a shared box at 3am). This adds an opt-in per-runbook flag: if
// runbook_actions.require_approval = 1, an alert breach creates a row in
// runbook_pending_approvals instead of running the command, notifies
// admins/operators the same way alert notifications already do, and an
// admin approves or rejects it from the UI (or it auto-expires).
//
// Safe to run repeatedly — every step checks for existence first.
'use strict';
const path = require('path');
const mysql = require('mysql2/promise');
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

async function migrateRunbookApproval() {
  const conn = await getConn();
  try {
    console.log('Running runbook approval-gate migration...');

    // ── runbook_actions.require_approval ──────────────────────────────────
    if (!(await colExists(conn, 'runbook_actions', 'require_approval'))) {
      await conn.query(`
        ALTER TABLE runbook_actions
        ADD COLUMN require_approval TINYINT(1) NOT NULL DEFAULT 0
          COMMENT 'if 1, an alert-triggered run is queued for approval instead of executed immediately'
      `);
      console.log('  + runbook_actions.require_approval');
    }

    // ── runbook_pending_approvals ──────────────────────────────────────────
    if (!(await tableExists(conn, 'runbook_pending_approvals'))) {
      await conn.query(`
        CREATE TABLE runbook_pending_approvals (
          id            CHAR(36)     PRIMARY KEY,
          org_id        CHAR(36)     DEFAULT NULL,
          runbook_id    CHAR(36)     NOT NULL,
          device_id     CHAR(36)     NOT NULL,
          rule_id       CHAR(36)     DEFAULT NULL,
          triggered_by  VARCHAR(100) NOT NULL COMMENT 'e.g. "alert rule: High CPU"',
          status        ENUM('pending','approved','rejected','expired') NOT NULL DEFAULT 'pending',
          decided_by    CHAR(36)     DEFAULT NULL,
          decided_at    INT UNSIGNED DEFAULT NULL,
          run_result    VARCHAR(10)  DEFAULT NULL COMMENT 'result of the run once executed, if approved',
          run_output    TEXT         DEFAULT NULL,
          expires_at    INT UNSIGNED NOT NULL COMMENT 'auto-expires so a stale approval cannot fire a remediation against a since-changed situation',
          created_at    INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
          INDEX idx_rpa_status (status),
          INDEX idx_rpa_org (org_id),
          INDEX idx_rpa_device (device_id),
          CONSTRAINT fk_rpa_runbook FOREIGN KEY (runbook_id) REFERENCES runbook_actions(id) ON DELETE CASCADE,
          CONSTRAINT fk_rpa_device  FOREIGN KEY (device_id)  REFERENCES devices(id) ON DELETE CASCADE,
          CONSTRAINT fk_rpa_decider FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('  + runbook_pending_approvals table created');
    }

    console.log('Runbook approval-gate migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateRunbookApproval().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { migrateRunbookApproval };