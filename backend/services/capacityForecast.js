// services/capacityForecast.js — "this disk will hit 100% in ~9 days"
//
// Uses the metrics_history table (60s buckets, kept for
// METRICS_COMPRESS_AFTER_DAYS — see services/metricsRollup.js) as the trend
// source: group into daily averages, fit a simple ordinary-least-squares
// line through them, and project forward to 100%. Deliberately simple (no
// external stats library) — a straight-line trend is exactly what "at
// current growth rate" means, and it's cheap enough to run against every
// device on a timer without a monitoring pipeline of its own.
'use strict';
const { v4: uuidv4 } = require('uuid');
const { query, execute } = require('../db');

const DAY = 86400;
const MIN_DAYS_FOR_TREND = 3;       // need at least this many distinct days of data to fit a line
const RISING_SLOPE_FLOOR = 0.05;    // ignore noise — a trend under 0.05%/day isn't "filling up"
const DEFAULT_WARNING_DAYS = parseInt(process.env.CAPACITY_WARNING_DAYS) || 7;
const RENOTIFY_COOLDOWN_SEC = parseInt(process.env.CAPACITY_RENOTIFY_HOURS || 24) * 3600;
const TICK_MS = 6 * 3600 * 1000; // trend moves slowly — checking every 6h is plenty

const METRIC_COLUMNS = {
  disk: { sum: 'disk_pct_sum', n: 'disk_n' },
  ram:  { sum: 'ram_pct_sum',  n: 'ram_n'  },
};

// ── Core regression ─────────────────────────────────────────────────────────
// Ordinary least squares on (dayIndex, avgPct) pairs. Returns null if there
// isn't enough data to say anything meaningful.
function fitLine(points) {
  const n = points.length;
  if (n < MIN_DAYS_FOR_TREND) return null;

  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const [x, y] of points) { sumX += x; sumY += y; sumXY += x * y; sumXX += x * x; }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null; // all same day index — shouldn't happen, but guard anyway

  const slope     = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R² — how well the straight line actually explains the data, so the UI
  // can show "rough guess" vs "very consistent trend" instead of a bare
  // number that implies false precision.
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (const [x, y] of points) {
    const predicted = slope * x + intercept;
    ssRes += (y - predicted) ** 2;
    ssTot += (y - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  return { slope, intercept, r2 };
}

// ── Forecast for one device/metric ──────────────────────────────────────────
async function computeForecast(deviceId, metric = 'disk', lookbackDays = 14) {
  const cols = METRIC_COLUMNS[metric];
  if (!cols) throw new Error(`Unknown metric: ${metric}`);

  const since = Math.floor(Date.now() / 1000) - lookbackDays * DAY;
  const rows = await query(
    `SELECT FLOOR(bucket_ts / ${DAY}) AS day_idx, SUM(${cols.sum}) AS s, SUM(${cols.n}) AS n
     FROM metrics_history
     WHERE device_id = ? AND bucket_ts >= ?
     GROUP BY day_idx
     ORDER BY day_idx ASC`,
    [deviceId, since]
  );

  const points = rows.filter(r => r.n > 0).map(r => [Number(r.day_idx), r.s / r.n]);
  if (!points.length) return { status: 'no_data' };

  const currentPct = points[points.length - 1][1];
  const fit = fitLine(points);
  const history = points.map(([dayIdx, pct]) => ({ ts: dayIdx * DAY, pct: Math.round(pct * 10) / 10 }));

  if (!fit) {
    return { status: 'insufficient_data', current_pct: round1(currentPct), history, sample_days: points.length };
  }

  if (fit.slope < RISING_SLOPE_FLOOR) {
    return {
      status: fit.slope < -RISING_SLOPE_FLOOR ? 'falling' : 'stable',
      current_pct: round1(currentPct), slope_per_day: round2(fit.slope),
      r2: round2(fit.r2), history, sample_days: points.length,
    };
  }

  const daysToFull = Math.max(0, (100 - currentPct) / fit.slope);
  const projectedFullAt = Math.floor(Date.now() / 1000) + Math.round(daysToFull * DAY);

  return {
    status: 'rising',
    current_pct: round1(currentPct),
    slope_per_day: round2(fit.slope),
    r2: round2(fit.r2),
    days_to_full: round1(daysToFull),
    projected_full_at: projectedFullAt,
    history,
    sample_days: points.length,
  };
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

// ── All devices (for the list view + the periodic warning check) ───────────
async function computeAllForecasts(metric = 'disk', lookbackDays = 14, orgId = null) {
  const devices = await query(
    orgId
      ? `SELECT id, name, ip_address FROM devices WHERE org_id = ? OR org_id IS NULL`
      : `SELECT id, name, ip_address FROM devices`,
    orgId ? [orgId] : []
  );

  const results = [];
  for (const device of devices) {
    const forecast = await computeForecast(device.id, metric, lookbackDays).catch(() => ({ status: 'error' }));
    results.push({ device_id: device.id, device_name: device.name, device_ip: device.ip_address, metric, ...forecast });
  }

  // Soonest-to-fill first; anything without a real projection sinks to the bottom.
  results.sort((a, b) => (a.days_to_full ?? Infinity) - (b.days_to_full ?? Infinity));
  return results;
}

// ── Periodic warning notifications ──────────────────────────────────────────
// Reuses the exact same in-app bell + web push pipeline as regular alerts
// (routes/alerts.js), so a capacity warning shows up right alongside device
// alerts instead of being a second, separate notification system.
async function checkAndNotify() {
  const { pushNotification } = require('../routes/alerts');
  const webPush = require('./webPush');

  for (const metric of Object.keys(METRIC_COLUMNS)) {
    const forecasts = await computeAllForecasts(metric, 14, null);
    const atRisk = forecasts.filter(f => f.status === 'rising' && f.days_to_full <= DEFAULT_WARNING_DAYS);

    for (const f of atRisk) {
      const prior = await query(
        'SELECT last_notified_at, days_to_full FROM capacity_forecast_notices WHERE device_id = ? AND metric = ?',
        [f.device_id, metric]
      );
      const now = Math.floor(Date.now() / 1000);
      const last = prior[0];
      // Re-notify if we've never warned about this device/metric, the
      // cooldown window has passed, or the forecast got meaningfully worse
      // (at least a day sooner) since the last warning — otherwise a
      // slowly-filling disk would just re-page every single tick forever.
      const worseByADay = last && (last.days_to_full - f.days_to_full) >= 1;
      const cooldownExpired = !last || (now - last.last_notified_at) >= RENOTIFY_COOLDOWN_SEC;
      if (last && !cooldownExpired && !worseByADay) continue;

      const admins = await query('SELECT id FROM users WHERE role = ? AND enabled = 1', ['admin']);
      const message = `${f.device_name}: ${metric === 'disk' ? 'disk' : 'RAM'} usage at ${f.current_pct}% and rising ~${f.slope_per_day}%/day — projected full in ~${Math.round(f.days_to_full)} day${Math.round(f.days_to_full) === 1 ? '' : 's'}`;

      pushNotification(admins.map(a => a.id), {
        type: 'capacity', severity: f.days_to_full <= 2 ? 'critical' : 'warning',
        rule_name: `Capacity forecast (${metric})`, device_id: f.device_id,
        device_name: f.device_name, metric, message, triggered_at: now,
      });
      webPush.sendToUsers(admins.map(a => a.id), {
        title: `📈 ${f.device_name} filling up`,
        body: message,
        tag: `nc-capacity-${f.device_id}-${metric}`,
        data: { type: 'capacity', deviceId: f.device_id, metric, url: '/capacity' },
      }).catch(() => {});

      await execute(
        `INSERT INTO capacity_forecast_notices (device_id, metric, last_notified_at, days_to_full)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE last_notified_at = VALUES(last_notified_at), days_to_full = VALUES(days_to_full)`,
        [f.device_id, metric, now, f.days_to_full]
      );
    }

    // Clear the notice once a device is no longer at risk, so if it fills
    // up again later (new growth after cleanup, etc.) it's treated as a
    // fresh warning rather than being stuck on the old cooldown.
    const stillAtRiskIds = atRisk.map(f => f.device_id);
    await execute(
      `DELETE FROM capacity_forecast_notices WHERE metric = ? AND device_id NOT IN (${
        stillAtRiskIds.length ? stillAtRiskIds.map(() => '?').join(',') : 'NULL'
      })`,
      [metric, ...stillAtRiskIds]
    ).catch(() => {});
  }
}

let timer = null;
function start() {
  if (timer) return;
  checkAndNotify().catch(e => console.error('[CapacityForecast] initial check failed:', e.message));
  timer = setInterval(() => {
    checkAndNotify().catch(e => console.error('[CapacityForecast] check failed:', e.message));
  }, TICK_MS);
  console.log(`[CapacityForecast] runner started (checking every ${TICK_MS / 3600000}h, warning threshold ${DEFAULT_WARNING_DAYS}d)`);
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { computeForecast, computeAllForecasts, checkAndNotify, start, stop };