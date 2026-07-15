// db/migrate-saved-views.js — named, reusable filter combos ("saved
// views") for list-style pages. Same shape as bulk_command_history's
// favorites pattern (org-scoped, not per-user) — for an MSP running one
// org per client, a saved view like "Client X — offline Windows boxes" or
// "Failed logins, last 7 days" is exactly the kind of thing every operator
// on the team should see, not just whoever created it.
//
// Generic across pages via a `page` column + a JSON `filters` blob (each
// page owns its own filter shape — see routes/savedViews.js) rather than
// one table per page, so adding saved views to a future list page is a
// route addition, not another migration.
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

async function migrateSavedViews() {
  const conn = await getConn();
  try {
    console.log('Running saved-views migration...');

    if (!(await tableExists(conn, 'saved_views'))) {
      await conn.query(`
        CREATE TABLE saved_views (
          id                   CHAR(36)     NOT NULL PRIMARY KEY,
          org_id               CHAR(36)     NOT NULL,
          page                 VARCHAR(32)  NOT NULL,   -- 'devices' | 'audit'
          name                 VARCHAR(100) NOT NULL,
          filters              JSON         NOT NULL,
          created_by           CHAR(36)     DEFAULT NULL,
          created_by_username  VARCHAR(255) DEFAULT NULL,
          created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_org_page_name (org_id, page, name),
          INDEX idx_org_page (org_id, page, last_used_at),
          FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('  + saved_views');
    }

    console.log('✅ Saved-views migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateSavedViews().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateSavedViews };