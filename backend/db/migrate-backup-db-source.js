// db/migrate-backup-db-source.js — Adds 'database' as a valid backups.source_type
//
// Lets the Backup page offer a one-click "Back up NetControl DB" option
// (routes/backup.js POST /database) alongside the existing file/folder
// sources, without touching the meaning of the existing 'file'/'folder'
// values used everywhere else in the backup UI and history list.
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

async function migrateBackupDbSource() {
  const conn = await getConn();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backups' AND COLUMN_NAME = 'source_type'`
    );
    const columnType = rows[0]?.COLUMN_TYPE || '';
    if (!columnType.includes("'database'")) {
      await conn.query(`ALTER TABLE backups MODIFY COLUMN source_type ENUM('file','folder','database') NOT NULL`);
    }
  } finally {
    await conn.end();
  }
}

module.exports = { migrateBackupDbSource };

if (require.main === module) {
  migrateBackupDbSource()
    .then(() => { console.log("✅ backups.source_type now allows 'database'"); process.exit(0); })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}