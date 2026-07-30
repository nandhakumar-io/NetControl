// db/migrate-health-score-history.js — device_health_score_history table
// Records each computed composite health score (services/deviceHealthScore.js)
// per device over time so the Devices page can sort/filter by *trend*
// (worsening vs. stable vs. improving) instead of just the point-in-time
// number. Writes are throttled in deviceHealthScore.js (at most one row per
// device per hour) so this stays small — it's a trend signal, not a metrics
// time series.
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

async function migrateHealthScoreHistoryTables() {
  const conn = await getConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS device_health_score_history (
        id          CHAR(36)     PRIMARY KEY,
        device_id   CHAR(36)     NOT NULL,
        score       TINYINT      UNSIGNED NOT NULL,
        recorded_at INT UNSIGNED NOT NULL DEFAULT (UNIX_TIMESTAMP()),
        INDEX idx_dhsh_device_ts (device_id, recorded_at),
        CONSTRAINT fk_dhsh_device FOREIGN KEY (device_id)
          REFERENCES devices(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('[DB] ✅ Health score history table ready (device_health_score_history)');
  } finally {
    try { await conn.end(); } catch {}
  }
}

module.exports = { migrateHealthScoreHistoryTables };