// db/migrate-bulk-command-history.js — org-scoped recent/favorite command
// list for the Bulk Command console, so the textarea doesn't start blank
// every time for routine ops commands (uptime checks, patch commands, etc).
//
// One row per distinct command text *within an org* (deduped via a SHA-256
// hash — command bodies can be arbitrarily long/multi-line, too big to
// reliably use as a UNIQUE key directly). Every successful POST
// /bulk-command/run upserts: increments run_count and bumps last_used_at.
// is_favorite is a separate user-toggleable pin so a rarely-run but
// important command (e.g. a maintenance-mode drain script) doesn't get
// pushed out of the recent list by routine one-offs.
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

async function tableExists(conn, table) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1`,
    [table]
  );
  return r.length > 0;
}

async function migrateBulkCommandHistory() {
  const conn = await getConn();
  try {
    console.log('Running bulk-command-history migration...');

    if (!(await tableExists(conn, 'bulk_command_history'))) {
      await conn.query(`
        CREATE TABLE bulk_command_history (
          id            CHAR(36)     NOT NULL PRIMARY KEY,
          org_id        CHAR(36)     NOT NULL,
          command       TEXT         NOT NULL,
          command_hash  CHAR(64)     NOT NULL,
          run_count     INT          NOT NULL DEFAULT 1,
          is_favorite   TINYINT(1)   NOT NULL DEFAULT 0,
          created_by    CHAR(36)     DEFAULT NULL,
          created_by_username VARCHAR(255) DEFAULT NULL,
          created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_org_command (org_id, command_hash),
          INDEX idx_org_favorite_lastused (org_id, is_favorite, last_used_at),
          FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('  + bulk_command_history');
    }

    console.log('✅ Bulk-command-history migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateBulkCommandHistory().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateBulkCommandHistory };