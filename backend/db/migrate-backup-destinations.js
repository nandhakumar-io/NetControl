// db/migrate-backup-destinations.js — Multi-device sources + pluggable destinations for backups
//
// Adds:
//   - backup_destinations: saved destinations a backup can be written to
//     (S3 bucket or a folder on another registered device, reached over SFTP).
//     Credentials/config are stored encrypted (services/crypto.js) the same
//     way device SSH/WinRM credentials already are.
//   - backups.device_id / device_name: which device the source file/folder was
//     browsed from. NULL = the NetControl server itself (the only source that
//     existed before this migration — backfilled as NULL, meaning "local").
//   - backups.destination_id / destination_name / destination_type: where the
//     finished archive was written. NULL destination_id + type 'local' =
//     the original BACKUP_STORE_DIR behavior, so existing rows keep working
//     unchanged.
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

async function migrateBackupDestinations() {
  const conn = await getConn();
  try {
    // ── Saved destinations ──────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS backup_destinations (
        id          CHAR(36)      NOT NULL PRIMARY KEY,
        name        VARCHAR(100)  NOT NULL,
        type        ENUM('s3','azure_blob','remote_folder') NOT NULL,
        config      TEXT          NOT NULL COMMENT 'AES-256-GCM encrypted JSON blob — bucket/region/keys for s3, account/container/keys for azure_blob, deviceId/remotePath for remote_folder',
        created_by  CHAR(36)      DEFAULT NULL,
        created_at  INT UNSIGNED  NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        CONSTRAINT fk_backup_destinations_user FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Widen the type ENUM for installs that already had this table from
    // before azure_blob existed.
    await conn.query(`ALTER TABLE backup_destinations MODIFY COLUMN type ENUM('s3','azure_blob','remote_folder') NOT NULL`);

    // ── backups: source device (NULL = local server) ───────────────────────
    if (!(await columnExists(conn, 'backups', 'device_id'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN device_id CHAR(36) DEFAULT NULL COMMENT 'source device the file/folder was browsed from; NULL = the NetControl server itself' AFTER source_path`);
    }
    if (!(await columnExists(conn, 'backups', 'device_name'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN device_name VARCHAR(100) DEFAULT NULL COMMENT 'denormalized so history still shows a name if the device is later removed' AFTER device_id`);
    }

    // ── backups: destination (NULL id + type 'local' = original behavior) ──
    if (!(await columnExists(conn, 'backups', 'destination_id'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN destination_id CHAR(36) DEFAULT NULL COMMENT 'FK-ish ref to backup_destinations; NULL = local BACKUP_STORE_DIR' AFTER format`);
    }
    if (!(await columnExists(conn, 'backups', 'destination_name'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN destination_name VARCHAR(100) DEFAULT NULL AFTER destination_id`);
    }
    if (!(await columnExists(conn, 'backups', 'destination_type'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN destination_type ENUM('local','s3','azure_blob','remote_folder') NOT NULL DEFAULT 'local' AFTER destination_name`);
    } else {
      // Widen for installs migrated before azure_blob existed.
      await conn.query(`ALTER TABLE backups MODIFY COLUMN destination_type ENUM('local','s3','azure_blob','remote_folder') NOT NULL DEFAULT 'local'`);
    }

    // ── backups: was the stored archive encrypted at rest? ─────────────────
    // Set per-row at write time (services/backupDestinations.js
    // shouldEncrypt()) so a later download knows whether to run it back
    // through AES-256-GCM decryption before serving it.
    if (!(await columnExists(conn, 'backups', 'encrypted'))) {
      await conn.query(`ALTER TABLE backups ADD COLUMN encrypted TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'archive bytes at the destination are AES-256-GCM encrypted' AFTER checksum_sha256`);
    }

    // Existing rows already default to device_id=NULL, destination_type='local'
    // via the ALTER defaults above, so no backfill UPDATE is needed.
  } finally {
    await conn.end();
  }
}

module.exports = { migrateBackupDestinations };

if (require.main === module) {
  migrateBackupDestinations()
    .then(() => { console.log('✅ backup_destinations table + backups source/destination columns ready'); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}1