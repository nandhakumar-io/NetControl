// db/migrate-bulk-command-session.js — "which run was I last watching" per
// user, so the Bulk Command console can resume it from ANY browser/device
// the user logs in from — not just the one that started the run.
//
// Previously this pointer lived in localStorage (nc_bulk_command_last_run_id)
// — purely client-side, so switching browsers (or even a different profile
// on the same machine) meant the console always came up blank even while
// the run itself was still live and fully tracked server-side (Redis, via
// services/bulkCommand.js). This table is the durable, cross-browser
// equivalent: one row per user, updated every time they start a run, read
// back by GET /api/bulk-command/active on page load.
//
// One row per user (not per org) is intentional — a user only ever
// realistically watches one run at a time, and the pointer is just a
// resume convenience, not run storage itself (the run's actual state
// still lives in Redis with its own TTL — see services/bulkCommand.js).
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

async function migrateBulkCommandSession() {
  const conn = await getConn();
  try {
    console.log('Running bulk-command-session migration...');

    if (!(await tableExists(conn, 'user_last_bulk_run'))) {
      await conn.query(`
        CREATE TABLE user_last_bulk_run (
          user_id     CHAR(36)  NOT NULL PRIMARY KEY,
          run_id      CHAR(36)  NOT NULL,
          org_id      CHAR(36)  NOT NULL,
          updated_at  DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('  + user_last_bulk_run');
    }

    console.log('✅ Bulk-command-session migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateBulkCommandSession().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateBulkCommandSession };