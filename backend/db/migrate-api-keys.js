// db/migrate-api-keys.js — Long-lived API keys for scripts/Terraform/CI
//
// Adds:
//   api_keys — a key belongs to a user (for audit trail + revocation) but is
//              NOT a session: it never rotates, has no refresh token, and
//              carries its own permissions bitmask (defaults to the owning
//              user's permissions at creation time, but can be narrowed —
//              e.g. a CI key that can only run actions, not manage users).
//              Only the SHA-256 hash is stored, same as agent_key_hash and
//              refresh_tokens — the raw key is shown exactly once at
//              creation and can never be retrieved again.
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

async function migrateApiKeys() {
  const conn = await getConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id           CHAR(36)     PRIMARY KEY,
        user_id      CHAR(36)     NOT NULL,
        name         VARCHAR(100) NOT NULL,
        key_prefix   VARCHAR(12)  NOT NULL,
        key_hash     CHAR(64)     NOT NULL,
        permissions  INT UNSIGNED NOT NULL DEFAULT 0,
        created_at   INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        expires_at   INT UNSIGNED DEFAULT NULL,
        last_used_at INT UNSIGNED DEFAULT NULL,
        last_used_ip VARCHAR(45)  DEFAULT NULL,
        revoked      TINYINT(1)   NOT NULL DEFAULT 0,
        revoked_at   INT UNSIGNED DEFAULT NULL,
        INDEX idx_api_keys_hash (key_hash),
        INDEX idx_api_keys_user (user_id),
        CONSTRAINT fk_api_keys_user FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    await conn.end();
  }
}

module.exports = { migrateApiKeys };

if (require.main === module) {
  migrateApiKeys()
    .then(() => { console.log('✅ api_keys table ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}