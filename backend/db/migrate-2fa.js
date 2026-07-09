// db/migrate-2fa.js — TOTP-based two-factor authentication for local accounts
//
// Adds:
//   users.totp_secret        — AES-256-GCM encrypted TOTP secret (services/crypto.js),
//                               same encrypt-at-rest treatment as device SSH/WinRM creds.
//                               Set as soon as setup starts; NOT proof 2FA is active —
//                               see totp_enabled for that.
//   users.totp_enabled       — 1 only once the user has confirmed a code against
//                               totp_secret. Login only requires a second factor
//                               when this is 1, so a half-finished setup can't
//                               accidentally lock anyone out.
//   users.totp_backup_codes — AES-256-GCM encrypted JSON array of bcrypt-hashed
//                               one-time backup codes (never stored/returned in
//                               plaintext after initial generation).
//   users.totp_confirmed_at  — when 2FA was turned on, for audit/support purposes.
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

async function migrateTwoFactor() {
  const conn = await getConn();
  try {
    if (!(await columnExists(conn, 'users', 'totp_secret'))) {
      await conn.query(`ALTER TABLE users ADD COLUMN totp_secret TEXT DEFAULT NULL COMMENT 'AES-256-GCM encrypted TOTP secret'`);
    }
    if (!(await columnExists(conn, 'users', 'totp_enabled'))) {
      await conn.query(`ALTER TABLE users ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0`);
    }
    if (!(await columnExists(conn, 'users', 'totp_backup_codes'))) {
      await conn.query(`ALTER TABLE users ADD COLUMN totp_backup_codes TEXT DEFAULT NULL COMMENT 'AES-256-GCM encrypted JSON array of bcrypt-hashed one-time codes'`);
    }
    if (!(await columnExists(conn, 'users', 'totp_confirmed_at'))) {
      await conn.query(`ALTER TABLE users ADD COLUMN totp_confirmed_at INT UNSIGNED DEFAULT NULL`);
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateTwoFactor };

if (require.main === module) {
  migrateTwoFactor()
    .then(() => { console.log('✅ users 2FA columns ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}