// db/migrate-backup-verify.js — Restore/integrity verification for backup archives
//
// Adds columns to `backups` so every archive's read-back-and-check result is
// recorded, not just the write-time checksum:
//   verify_status      — 'unverified' | 'passed' | 'failed'. Set to
//                         'unverified' the moment a backup completes; flipped
//                         by services/backupVerify.js after it reads the
//                         archive back from wherever it was written (local
//                         disk, S3, Azure Blob, or the remote SFTP folder)
//                         and (a) recomputes a sha256 over the stored bytes
//                         and compares it to checksum_sha256, and (b) does a
//                         structural read-through of the archive itself
//                         (zip central directory / tar header walk, through
//                         the decrypt stream if encrypted) to catch silent
//                         corruption a checksum match alone wouldn't — e.g.
//                         the checksum was computed correctly at write time
//                         but the destination silently truncated or altered
//                         the object afterward in a way that also breaks the
//                         archive format, not just the byte-for-byte digest.
//   verified_at         — when the last verification run finished.
//   verify_error        — human-readable reason for a 'failed' result.
//   verify_checksum     — the sha256 actually read back, for support/debugging
//                         (compare directly against checksum_sha256).
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

async function migrateBackupVerify() {
  const conn = await getConn();
  try {
    if (!(await columnExists(conn, 'backups', 'verify_status'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN verify_status ENUM('unverified','passed','failed') NOT NULL DEFAULT 'unverified' AFTER encrypted`);
    }
    if (!(await columnExists(conn, 'backups', 'verified_at'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN verified_at INT UNSIGNED DEFAULT NULL AFTER verify_status`);
    }
    if (!(await columnExists(conn, 'backups', 'verify_error'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN verify_error TEXT DEFAULT NULL AFTER verified_at`);
    }
    if (!(await columnExists(conn, 'backups', 'verify_checksum'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN verify_checksum CHAR(64) DEFAULT NULL AFTER verify_error`);
    }
    const hasIdx = await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backups' AND INDEX_NAME = 'idx_backups_verify_status'`
    );
    if (hasIdx[0][0].c === 0) {
      await conn.query(`ALTER TABLE backups ADD INDEX idx_backups_verify_status (verify_status)`);
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateBackupVerify };

if (require.main === module) {
  migrateBackupVerify()
    .then(() => { console.log('✅ backups verify columns ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}