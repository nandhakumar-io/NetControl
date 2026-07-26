// db/migrate-sessions.js — session visibility + revocation
//
// refresh_tokens already IS the session store (one row per browser/device
// that's logged in), but it was write-only: nothing recorded where a
// session came from or when it was last active, and there was no way for
// a user to see or end their own sessions, or for an admin to kill every
// session belonging to a user they suspect is compromised.
//
// Adds:
//   refresh_tokens.ip_address   — IP the session was created from
//   refresh_tokens.user_agent   — raw UA string; the frontend renders a
//                                  friendly "Chrome on macOS" label from
//                                  this rather than parsing it server-side,
//                                  so improving device detection is a
//                                  frontend-only change later.
//   refresh_tokens.last_used_at — bumped on every successful /auth/refresh,
//                                  so "last active" reflects real usage,
//                                  not just when the session was created.
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
    multipleStatements: true,
    timezone: '+00:00',
  });
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].c > 0;
}

async function indexExists(conn, table, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName]
  );
  return rows[0].c > 0;
}

async function migrateSessions() {
  const conn = await getConn();
  try {
    if (!(await columnExists(conn, 'refresh_tokens', 'ip_address'))) {
      await conn.query(`ALTER TABLE refresh_tokens ADD COLUMN ip_address VARCHAR(45) DEFAULT NULL`);
    }
    if (!(await columnExists(conn, 'refresh_tokens', 'user_agent'))) {
      await conn.query(`ALTER TABLE refresh_tokens ADD COLUMN user_agent VARCHAR(255) DEFAULT NULL`);
    }
    if (!(await columnExists(conn, 'refresh_tokens', 'last_used_at'))) {
      await conn.query(`ALTER TABLE refresh_tokens ADD COLUMN last_used_at INT UNSIGNED DEFAULT NULL`);
    }
    if (!(await indexExists(conn, 'refresh_tokens', 'idx_rt_user'))) {
      await conn.query(`ALTER TABLE refresh_tokens ADD INDEX idx_rt_user (user_id, revoked)`);
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateSessions };

if (require.main === module) {
  migrateSessions()
    .then(() => { console.log('✅ refresh_tokens session columns ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}