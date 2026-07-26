// db/migrate-2fa-grace.js — grace period for admin-mandated 2FA
//
// Before this, flipping users.totp_required to 1 (Users page → "Require
// 2FA") blocked the user's VERY NEXT login until they finished enrollment
// mid-login — no warning beforehand, no way to enroll on their own time.
// For a team that just turned on org-wide enforcement, that's every
// affected user hitting a surprise wall simultaneously, and it shows up
// as a support ticket flood ("why can't I log in").
//
// Adds:
//   users.totp_required_at — when an admin turned totp_required on for
//                             this account (NULL if never / not required).
//                             Set once on the 0→1 transition, cleared back
//                             to NULL if an admin turns the requirement
//                             back off — so re-enabling later starts a
//                             fresh grace period rather than reusing a
//                             stale timestamp from months ago.
//   system_settings row 'totp_grace_period_days' — org-configurable grace
//                             length (default 7). Reuses the existing
//                             generic system_settings table rather than a
//                             new column, matching the syslog-config
//                             pattern already there.
//
// During the grace window, login succeeds normally (a banner nags the
// user to enroll — see routes/auth.js / TwoFactorModal.jsx); once the
// window elapses, login behaves as before: password-correct but
// unenrolled accounts are routed to forced enrollment before a session is
// issued.
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

async function migrateTwoFactorGrace() {
  const conn = await getConn();
  try {
    if (!(await columnExists(conn, 'users', 'totp_required_at'))) {
      await conn.query(
        `ALTER TABLE users ADD COLUMN totp_required_at INT UNSIGNED DEFAULT NULL
         COMMENT 'When admin turned on totp_required — start of the enrollment grace period'`
      );
      // Existing accounts that already had totp_required=1 before this
      // migration ran get no grace period (they've had it mandated for a
      // while already) — set them to 0 (epoch) rather than NULL so they
      // read as "grace already elapsed" instead of "never required".
      await conn.query(
        `UPDATE users SET totp_required_at = 0 WHERE totp_required = 1 AND totp_enabled = 0`
      );
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateTwoFactorGrace };

if (require.main === module) {
  migrateTwoFactorGrace()
    .then(() => { console.log('✅ users.totp_required_at ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}