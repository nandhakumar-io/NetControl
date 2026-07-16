// db/migrate-group-device-snapshots.js — daily per-group device-count
// snapshots, so the Groups page can show "+3 since yesterday" instead of
// just a static online/total count. Populated once a day by
// services/scheduledJobs.js's snapshotGroupDeviceCounts(); read by
// routes/groups.js's GET / to compute the delta against the current count.
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

async function tableExists(conn, table) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1`,
    [table]
  );
  return r.length > 0;
}

async function migrateGroupDeviceSnapshots() {
  const conn = await getConn();
  try {
    console.log('Running group device-count snapshot migration...');
    if (!(await tableExists(conn, 'group_device_count_snapshots'))) {
      await conn.query(`
        CREATE TABLE group_device_count_snapshots (
          group_id      VARCHAR(36)  NOT NULL,
          snapshot_date DATE         NOT NULL,
          device_count  INT          NOT NULL DEFAULT 0,
          PRIMARY KEY (group_id, snapshot_date),
          INDEX idx_group_date (group_id, snapshot_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('  + group_device_count_snapshots table');
    }
    console.log('✅ Group device-count snapshot migration complete.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateGroupDeviceSnapshots().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateGroupDeviceSnapshots };