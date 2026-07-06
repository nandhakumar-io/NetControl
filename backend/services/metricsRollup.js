// services/metricsRollup.js — metrics_history compaction + retention
//
// The Monitoring History page needs two things that pull in opposite
// directions: fine detail for "what happened this week" and a long lookback
// for "how does this month compare to three months ago". Keeping every 60s
// bucket forever solves the second problem by brute force (huge table,
// slow GROUP BYs at scale) — so instead we run this job to fold the past
// into a smaller shape as it ages, without ever throwing the *history* away:
//
//   0 .. METRICS_COMPRESS_AFTER_DAYS days old   → raw 60s buckets (metrics_history)
//   METRICS_COMPRESS_AFTER_DAYS .. RETAIN_DAYS  → 1 row/device/day (metrics_history_daily)
//   older than RETAIN_DAYS                      → pruned
//
// METRICS_COMPRESS_AFTER_DAYS defaults to 35 (a little past a month, per
// the "keep at least a month of full detail" requirement — a device that
// runs one "last calendar month vs this one" comparison on the 1st still
// gets raw-resolution data for both sides for a few days after rollover).
//
// Compaction is a rollup, not a resample: it sums the existing sum/n and
// takes the max of the existing max for every 1-min bucket that falls on a
// given UTC day, so the daily row's weighted average is identical to what
// you'd get averaging the raw buckets directly — nothing is lossy except
// the ability to zoom back into that specific day at minute resolution.
'use strict';
const { query, execute } = require('../db');

const COMPRESS_AFTER_DAYS = parseInt(process.env.METRICS_COMPRESS_AFTER_DAYS) || 35;
const DAILY_RETENTION_DAYS = parseInt(process.env.METRICS_DAILY_RETENTION_DAYS) || 730; // ~2 years
const RAW_HARD_CAP_DAYS = parseInt(process.env.METRICS_RETENTION_DAYS) || 395; // safety net if compaction ever falls behind

const DAY = 86400;

// Rolls every metrics_history row older than the compaction cutoff into
// metrics_history_daily, one calendar day at a time (oldest first) so a
// job that gets interrupted mid-run has already made real progress and
// simply picks the next day up on its next tick.
async function compressAgedBuckets() {
  const cutoffDayTs = Math.floor((Math.floor(Date.now() / 1000) - COMPRESS_AFTER_DAYS * DAY) / DAY) * DAY;

  // Find the oldest days that still have raw data waiting to be compacted.
  const pending = await query(
    `SELECT DISTINCT FLOOR(bucket_ts / ?) * ? AS day_ts
     FROM metrics_history
     WHERE bucket_ts < ?
     ORDER BY day_ts ASC
     LIMIT 30`, // cap per tick so one poller loop can't get stuck rolling up years of backlog
    [DAY, DAY, cutoffDayTs]
  );
  if (!pending.length) return;

  let compactedDays = 0;
  for (const { day_ts } of pending) {
    const dayStart = day_ts;
    const dayEnd = day_ts + DAY;

    await execute(
      `INSERT INTO metrics_history_daily
         (device_id, day_ts, cpu_sum, cpu_max, cpu_n, ram_pct_sum, ram_pct_max, ram_n,
          disk_pct_sum, disk_pct_max, disk_n, net_rx_sum, net_tx_sum, net_n)
       SELECT device_id, ?,
              SUM(cpu_sum), MAX(cpu_max), SUM(cpu_n),
              SUM(ram_pct_sum), MAX(ram_pct_max), SUM(ram_n),
              SUM(disk_pct_sum), MAX(disk_pct_max), SUM(disk_n),
              SUM(net_rx_sum), SUM(net_tx_sum), SUM(net_n)
       FROM metrics_history
       WHERE bucket_ts >= ? AND bucket_ts < ?
       GROUP BY device_id
       ON DUPLICATE KEY UPDATE
         cpu_sum      = cpu_sum      + VALUES(cpu_sum),
         cpu_max      = GREATEST(cpu_max, VALUES(cpu_max)),
         cpu_n        = cpu_n        + VALUES(cpu_n),
         ram_pct_sum  = ram_pct_sum  + VALUES(ram_pct_sum),
         ram_pct_max  = GREATEST(ram_pct_max, VALUES(ram_pct_max)),
         ram_n        = ram_n        + VALUES(ram_n),
         disk_pct_sum = disk_pct_sum + VALUES(disk_pct_sum),
         disk_pct_max = GREATEST(disk_pct_max, VALUES(disk_pct_max)),
         disk_n       = disk_n       + VALUES(disk_n),
         net_rx_sum   = net_rx_sum   + VALUES(net_rx_sum),
         net_tx_sum   = net_tx_sum   + VALUES(net_tx_sum),
         net_n        = net_n        + VALUES(net_n)`,
      [dayStart, dayStart, dayEnd]
    );

    // Only delete what was just folded in — never a moving "older than X"
    // window — so a day can't be deleted before its rollup is committed.
    await execute(
      'DELETE FROM metrics_history WHERE bucket_ts >= ? AND bucket_ts < ?',
      [dayStart, dayEnd]
    );
    compactedDays++;
  }
  if (compactedDays) {
    console.log(`[MetricsRollup] Compressed ${compactedDays} day(s) of metrics_history into metrics_history_daily`);
  }
}

// Belt-and-suspenders prune in case compaction ever falls behind (e.g. the
// poller was down for a long stretch) — never let raw buckets outlive
// RAW_HARD_CAP_DAYS even if they haven't been rolled up yet.
async function pruneUncompactedRaw() {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - RAW_HARD_CAP_DAYS * DAY;
    const result = await execute('DELETE FROM metrics_history WHERE bucket_ts < ? LIMIT 50000', [cutoff]);
    if (result.affectedRows) console.log(`[MetricsRollup] Hard-cap pruned ${result.affectedRows} raw metrics_history rows`);
  } catch (e) {
    console.error('[MetricsRollup] raw hard-cap prune failed:', e.message);
  }
}

async function pruneOldDailyRollups() {
  try {
    const cutoffDayTs = Math.floor((Math.floor(Date.now() / 1000) - DAILY_RETENTION_DAYS * DAY) / DAY) * DAY;
    const result = await execute('DELETE FROM metrics_history_daily WHERE day_ts < ? LIMIT 50000', [cutoffDayTs]);
    if (result.affectedRows) console.log(`[MetricsRollup] Pruned ${result.affectedRows} old metrics_history_daily rows`);
  } catch (e) {
    console.error('[MetricsRollup] daily prune failed:', e.message);
  }
}

async function runOnce() {
  try { await compressAgedBuckets(); } catch (e) { console.error('[MetricsRollup] compaction failed:', e.message); }
  await pruneUncompactedRaw();
  await pruneOldDailyRollups();
}

let timer = null;
function start() {
  runOnce();
  // Every 6h: frequent enough that a device that just crossed the
  // compaction cutoff doesn't sit around bloating metrics_history for a
  // full day, cheap enough (LIMIT 30 days/tick, indexed deletes) not to
  // matter on the poller's own schedule.
  timer = setInterval(runOnce, 6 * 60 * 60 * 1000);
}
function stop() {
  if (timer) clearInterval(timer);
}

module.exports = { start, stop, runOnce, COMPRESS_AFTER_DAYS, DAILY_RETENTION_DAYS };