// db/migrate-metrics-history.js — metrics_history table
//
// routes/metrics.js's in-memory `store` only keeps ~300 samples (~25 min at
// 5s intervals) per device and is wiped on every process restart — great
// for the live Monitoring page's sparklines, useless for "compare this
// month vs last month" style questions. This table is the durable side:
// one row per device per 60-second bucket, written incrementally on every
// agent POST via ON DUPLICATE KEY UPDATE (see routes/metrics.js
// recordHistoryBucket()) so there's no read-modify-write and no extra
// round trip on the ingest hot path.
//
// Storing sum/max/n instead of a plain average lets the write be a single
// atomic UPSERT regardless of how many samples land in that minute, and
// lets the read side recompute a true weighted average when it merges
// multiple 1-minute buckets into a coarser one (e.g. 1h buckets for a
// 30-day view) without needing a second table per granularity.
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

async function migrateMetricsHistoryTables() {
  const conn = await getConn();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS metrics_history (
        device_id     CHAR(36)     NOT NULL,
        bucket_ts     INT UNSIGNED NOT NULL,  -- floor(unix_ts / 60) * 60
        cpu_sum       DOUBLE       NOT NULL DEFAULT 0,
        cpu_max       DOUBLE       NOT NULL DEFAULT 0,
        cpu_n         INT UNSIGNED NOT NULL DEFAULT 0,
        ram_pct_sum   DOUBLE       NOT NULL DEFAULT 0,
        ram_pct_max   DOUBLE       NOT NULL DEFAULT 0,
        ram_n         INT UNSIGNED NOT NULL DEFAULT 0,
        disk_pct_sum  DOUBLE       NOT NULL DEFAULT 0,
        disk_pct_max  DOUBLE       NOT NULL DEFAULT 0,
        disk_n        INT UNSIGNED NOT NULL DEFAULT 0,
        net_rx_sum    DOUBLE       NOT NULL DEFAULT 0,
        net_tx_sum    DOUBLE       NOT NULL DEFAULT 0,
        net_n         INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, bucket_ts),
        INDEX idx_mh_ts (bucket_ts),
        CONSTRAINT fk_mh_device FOREIGN KEY (device_id)
          REFERENCES devices(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // metrics_history_daily — the compressed long-term tier.
    //
    // metrics_history above is intentionally fine-grained (60s buckets) so
    // recent history/comparisons stay precise — but at 800 agents that's
    // roughly 800 rows/minute, ~1.15M rows/device/year if kept forever.
    // Once a day's worth of 1-min buckets is older than
    // METRICS_COMPRESS_AFTER_DAYS (see services/metricsRollup.js), it gets
    // collapsed into exactly ONE row per device per calendar day here, and
    // the raw buckets are deleted. Same sum/max/n shape as metrics_history
    // (not a plain average) so re-aggregating across multiple days into a
    // week/month/year view is still a correct weighted average, and so a
    // day that's only partially rolled up (rollup ran mid-day) can be
    // safely re-upserted later without double counting.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS metrics_history_daily (
        device_id     CHAR(36)     NOT NULL,
        day_ts        INT UNSIGNED NOT NULL,  -- floor(unix_ts / 86400) * 86400 (UTC midnight)
        cpu_sum       DOUBLE       NOT NULL DEFAULT 0,
        cpu_max       DOUBLE       NOT NULL DEFAULT 0,
        cpu_n         INT UNSIGNED NOT NULL DEFAULT 0,
        ram_pct_sum   DOUBLE       NOT NULL DEFAULT 0,
        ram_pct_max   DOUBLE       NOT NULL DEFAULT 0,
        ram_n         INT UNSIGNED NOT NULL DEFAULT 0,
        disk_pct_sum  DOUBLE       NOT NULL DEFAULT 0,
        disk_pct_max  DOUBLE       NOT NULL DEFAULT 0,
        disk_n        INT UNSIGNED NOT NULL DEFAULT 0,
        net_rx_sum    DOUBLE       NOT NULL DEFAULT 0,
        net_tx_sum    DOUBLE       NOT NULL DEFAULT 0,
        net_n         INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, day_ts),
        INDEX idx_mhd_ts (day_ts),
        CONSTRAINT fk_mhd_device FOREIGN KEY (device_id)
          REFERENCES devices(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('[DB] ✅ Metrics history tables ready (metrics_history, metrics_history_daily)');
  } finally {
    try { await conn.end(); } catch {}
  }
}

module.exports = { migrateMetricsHistoryTables };