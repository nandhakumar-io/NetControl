// db/migrate-seb-quit.js — Safe Exam Browser (SEB Server 2.2) quit runs.
//
// WHY: NetControl orchestrates "quit SEB on these endpoints, wait until each
// endpoint confirms SEB has exited, THEN shut the PC down". That is
// asynchronous and per-device, so it needs durable state: a run row (who asked,
// which exam, which scope, whether to power off afterwards) plus one item row
// per device tracking its own progress through the state machine in
// services/sebQuit.js. Kept in MySQL (not Redis) so run history survives a
// restart and the poller can sweep runs whose worker died mid-flight.
//
// Safe to run repeatedly — every step checks for existence first.
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

async function tableExists(conn, table) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1`,
    [table]
  );
  return r.length > 0;
}

async function migrateSebQuit() {
  const conn = await getConn();
  try {
    console.log('Running SEB quit migration...');

    if (!(await tableExists(conn, 'seb_quit_runs'))) {
      await conn.query(`
        CREATE TABLE seb_quit_runs (
          id                   CHAR(36)     NOT NULL PRIMARY KEY,
          org_id               CHAR(36)     NOT NULL,
          exam_id              VARCHAR(64)  NOT NULL,
          scope_type           ENUM('device','devices','group') NOT NULL,
          scope_id             CHAR(36)     DEFAULT NULL,
          scope_name           VARCHAR(255) DEFAULT NULL,
          shutdown_after       TINYINT(1)   NOT NULL DEFAULT 0,
          timeout_sec          SMALLINT UNSIGNED NOT NULL DEFAULT 120,
          status               ENUM('running','completed','partial','failed','cancelled') NOT NULL DEFAULT 'running',
          created_by           CHAR(36)     DEFAULT NULL,
          created_by_username  VARCHAR(255) DEFAULT NULL,
          created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          heartbeat_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          finished_at          DATETIME     DEFAULT NULL,
          INDEX idx_seb_runs_org_created (org_id, created_at),
          INDEX idx_seb_runs_status_hb   (status, heartbeat_at),
          FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('  + seb_quit_runs');
    }

    if (!(await tableExists(conn, 'seb_quit_items'))) {
      await conn.query(`
        CREATE TABLE seb_quit_items (
          id                   CHAR(36)     NOT NULL PRIMARY KEY,
          run_id               CHAR(36)     NOT NULL,
          device_id            CHAR(36)     NOT NULL,
          device_name          VARCHAR(100) DEFAULT NULL,
          ip_address           VARCHAR(45)  DEFAULT NULL,
          connection_token     VARCHAR(255) DEFAULT NULL,
          state                VARCHAR(24)  NOT NULL DEFAULT 'queued',
          seb_status           VARCHAR(40)  DEFAULT NULL,
          details              VARCHAR(500) DEFAULT NULL,
          instruction_sent_at  DATETIME     DEFAULT NULL,
          exited_at            DATETIME     DEFAULT NULL,
          shutdown_at          DATETIME     DEFAULT NULL,
          updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_seb_items_run    (run_id),
          INDEX idx_seb_items_device (device_id, state),
          FOREIGN KEY (run_id) REFERENCES seb_quit_runs(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('  + seb_quit_items');
    }

    console.log('✅ SEB quit migration complete.');
  } finally {
    await conn.end();
  }
}

module.exports = { migrateSebQuit };

if (require.main === module) {
  migrateSebQuit().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}