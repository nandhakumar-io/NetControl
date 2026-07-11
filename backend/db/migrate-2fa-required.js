// db/migrate-2fa-required.js — admin-mandated 2FA
//
// totp_enabled (from migrate-2fa.js) reflects whether the USER has turned
// 2FA on for their own account — fully self-service, no admin involvement.
// This adds a separate flag an ADMIN controls: totp_required. When set, the
// account must have 2FA enabled to keep using the app; if the user hasn't
// enrolled yet, login stops short of issuing a session and instead forces
// them through enrollment (see routes/auth.js's /2fa/enroll/* endpoints)
// before completing the login. Deliberately a separate column from
// totp_enabled rather than reusing it — an admin turning this ON must not
// silently flip a user's own already-configured secret/backup codes, and a
// user who already had totp_enabled=1 voluntarily is simply already
// compliant with totp_required=1 with no extra step.
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

async function migrateTwoFactorRequired() {
  const conn = await getConn();
  try {
    if (!(await columnExists(conn, 'users', 'totp_required'))) {
      await conn.query(
        `ALTER TABLE users ADD COLUMN totp_required TINYINT(1) NOT NULL DEFAULT 0
         COMMENT 'Set by an admin — account must complete 2FA enrollment to log in'`
      );
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateTwoFactorRequired };

if (require.main === module) {
  migrateTwoFactorRequired()
    .then(() => { console.log('✅ users.totp_required ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}