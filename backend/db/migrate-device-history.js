// db/migrate-device-history.js — device_status_history table
// Records every online/offline/etc. transition detected by
// services/statusPoller.js so the Audit page can render a "Device Changes"
// timeline and diff device status between two points in time.
// Uses its own plain mysql2 connection (same pattern as migrate-snmp.js).
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

async function migrateDeviceHistoryTables() {
  const conn = await getConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS device_status_history (
        id          CHAR(36)     PRIMARY KEY,
        device_id   CHAR(36)     NOT NULL,
        device_name VARCHAR(100) NOT NULL,
        old_status  VARCHAR(20),
        new_status  VARCHAR(20)  NOT NULL,
        timestamp   INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        INDEX idx_dsh_device_ts (device_id, timestamp),
        INDEX idx_dsh_timestamp (timestamp),
        CONSTRAINT fk_dsh_device FOREIGN KEY (device_id)
          REFERENCES devices(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('[DB] ✅ Device history table ready (device_status_history)');
  } finally {
    try { await conn.end(); } catch {}
  }
}

module.exports = { migrateDeviceHistoryTables };