// db/migrate-device-hostname.js — adds devices.hostname
//
// WHY: routes/metrics.js's /register fallback dedup match was
// `WHERE ip_address = ? AND name = ?` — but `name` is the user-editable
// display name (PUT /api/devices/:id lets an admin rename it), while the
// agent always sends its raw OS hostname in the same field it registered
// with originally. There is no column preserving that original value.
//
// The moment a device is renamed in the UI, the fallback match breaks
// permanently (it can never match `name` again). If MAC matching also
// misses (e.g. empty/zeroed MAC on some Windows adapters), the next
// re-registration (service restart, 403 -> reRegister(), reboot) creates a
// brand new device row with a new id, silently orphaning the one the
// dashboard/browser has been targeting — including HTTP relay terminal
// sessions, which key everything off device id (browser opens a session for
// the old id via POST /api/terminal/open/:deviceId, the agent polls
// GET /api/terminal/device/:deviceId/pending under its NEW id — the pending
// queue for the old id never gets consumed, so the relay hangs at
// "Waiting for agent to connect..." forever, exactly matching "clicked try
// via HTTP relay and it does not work").
//
// FIX: add a real `hostname` column, set once at registration and never
// touched by the rename endpoint, and match against it instead of `name`.
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

async function migrateDeviceHostname() {
  const conn = await getConn();
  try {
    if (!(await columnExists(conn, 'devices', 'hostname'))) {
      await conn.query(
        `ALTER TABLE devices ADD COLUMN hostname VARCHAR(255) DEFAULT NULL AFTER name`
      );
      console.log('[Migrate] Added devices.hostname');
    } else {
      console.log('[Migrate] devices.hostname already exists — skipping add');
    }

    // Backfill: for every existing row that has never had hostname set,
    // best-effort seed it from the current `name`. This won't be correct
    // for rows that were already renamed before this migration ran (the
    // original hostname is gone — there's nothing to recover it from), but
    // it re-enables matching going forward for anything not yet renamed,
    // and re-registration (agent sends its real hostname again) will
    // self-heal the rest on next check-in via the updated /register logic.
    const [result] = await conn.query(
      `UPDATE devices SET hostname = name WHERE hostname IS NULL`
    );
    console.log(`[Migrate] Backfilled hostname for ${result.affectedRows} existing device(s)`);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrateDeviceHostname()
    .then(() => { console.log('[Migrate] devices.hostname migration complete'); process.exit(0); })
    .catch(e => { console.error('[Migrate] Failed:', e.message); process.exit(1); });
}

module.exports = { migrateDeviceHostname };