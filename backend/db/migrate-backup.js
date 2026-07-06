// db/migrate-backups.js — backups table
//
// Tracks every archive created by the file/folder backup feature
// (routes/backup.js + services/backupService.js). The actual archive bytes
// live on disk under BACKUP_STORE_DIR; this table is the durable index of
// what exists, who made it, from what source path, in what format, plus a
// sha256 checksum so a download can be verified for integrity later.
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

async function migrateBackupsTables() {
  const conn = await getConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS backups (
        id             CHAR(36)      NOT NULL PRIMARY KEY,
        source_path    VARCHAR(1000) NOT NULL COMMENT 'file/folder that was archived, relative to BACKUP_ROOT',
        source_type    ENUM('file','folder') NOT NULL,
        format         ENUM('zip','tar','tar.gz') NOT NULL,
        archive_name   VARCHAR(500)  NOT NULL COMMENT 'filename on disk under BACKUP_STORE_DIR',
        size_bytes     BIGINT UNSIGNED DEFAULT NULL,
        checksum_sha256 CHAR(64)     DEFAULT NULL,
        status         ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
        error_message  TEXT          DEFAULT NULL,
        created_by     CHAR(36)      DEFAULT NULL,
        created_by_name VARCHAR(100) DEFAULT NULL,
        created_at     INT UNSIGNED  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        completed_at   INT UNSIGNED  DEFAULT NULL,
        INDEX idx_backups_created   (created_at),
        INDEX idx_backups_status    (status),
        CONSTRAINT fk_backups_user FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    await conn.end();
  }
}

module.exports = { migrateBackupsTables };

if (require.main === module) {
  migrateBackupsTables()
    .then(() => { console.log('✅ backups table ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}