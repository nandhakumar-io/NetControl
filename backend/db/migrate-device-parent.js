// db/migrate-device-parent.js — adds devices.parent_device_id
//
// WHY: When an upstream device (a switch, router, AP) goes down, every
// downstream device behind it also flips to offline within the same poll
// cycle — today that's one "offline" alert notification per device, so a
// single switch failure floods the bell/webhooks/push with N noisy alerts
// that all have the same root cause. There was no way to say "these devices
// sit behind that one" at all.
//
// FIX: a simple self-referencing parent_device_id column — the same
// relationship shape as `groups`, just one level, device-to-device instead
// of device-to-group. If a device's parent is currently offline/unreachable,
// the device's own offline alert is suppressed (logged, but not notified/
// webhooked) since the parent going down is almost certainly the real cause.
// The child's own status still flips to 'offline' in the UI as normal —
// only the alert *noise* is suppressed, not the status itself.
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

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].c > 0;
}

async function indexExists(conn, table, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName]
  );
  return rows[0].c > 0;
}

async function migrateDeviceParent() {
  const conn = await getConn();
  try {
    if (!(await columnExists(conn, 'devices', 'parent_device_id'))) {
      // No FK constraint on purpose (same reasoning as group_id elsewhere in
      // this schema) — devices can be deleted independently and a dangling
      // parent reference should just be treated as "no parent" by the app,
      // not block the delete or cascade unexpectedly.
      await conn.query(
        `ALTER TABLE devices ADD COLUMN parent_device_id CHAR(36) DEFAULT NULL AFTER group_id`
      );
      console.log('[Migrate] Added devices.parent_device_id');
    } else {
      console.log('[Migrate] devices.parent_device_id already exists — skipping add');
    }

    if (!(await indexExists(conn, 'devices', 'idx_devices_parent_device_id'))) {
      await conn.query(
        `ALTER TABLE devices ADD INDEX idx_devices_parent_device_id (parent_device_id)`
      );
      console.log('[Migrate] Added index on devices.parent_device_id');
    }
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateDeviceParent()
    .then(() => { console.log('[Migrate] devices.parent_device_id migration complete'); process.exit(0); })
    .catch(e => { console.error('[Migrate] Failed:', e.message); process.exit(1); });
}

module.exports = { migrateDeviceParent };