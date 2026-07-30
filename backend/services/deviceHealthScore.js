// services/deviceHealthScore.js — Composite per-device health score
//
// Rolls up four already-tracked signals into one 0-100 number per device, so
// triaging a big fleet doesn't mean cross-referencing the Alerts, Compliance,
// and Capacity Forecast pages by hand:
//   - Open alerts   (alert_state, joined to alert_rules for severity)
//   - Drift status  (compliance_snapshots, most recent row per device)
//   - Capacity runway (services/capacityForecast.js, disk metric — the one
//     that actually runs out; CPU/RAM don't "fill up" the same way)
//   - Uptime %      (services/slaReportService.js, trailing 7-day window)
//
// Deliberately simple and additive rather than a black box: each factor
// subtracts a bounded penalty from 100, so a device missing a signal (no
// compliance snapshot yet, no metrics history yet) just doesn't get
// penalized for that factor instead of failing the whole computation.
// Devices.jsx surfaces `breakdown` in a tooltip precisely so the number is
// never a mystery — it's exactly these four subtractions, shown.
'use strict';
const crypto = require('crypto');
const { query } = require('../db');
const capacityForecast = require('./capacityForecast');
const { computeDeviceUptime } = require('./slaReportService');

const UPTIME_WINDOW_DAYS = 7;
// How far back to look for the "previous" score when deciding trend, and
// how often a new history row is allowed to be written per device — a
// history row per page load would be far more granular than the signal
// actually needs, so writes are throttled to once per this interval.
const TREND_WINDOW_DAYS = 7;
const HISTORY_WRITE_THROTTLE_SECONDS = 3600;
// Score has to move by more than this to count as a real trend rather than
// noise from e.g. one alert clearing and another firing the same day.
const TREND_NOISE_THRESHOLD = 5;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Persists one row per device into device_health_score_history, throttled
// to at most once every HISTORY_WRITE_THROTTLE_SECONDS so repeated page
// loads (or the 5s status poll) don't spam the table — this is a trend
// signal, not a fine-grained metrics series. Best-effort: a failure here
// should never break the score computation itself.
async function recordHealthScoreHistory(scores) {
  const nowSec = Math.floor(Date.now() / 1000);
  const ids = Object.keys(scores);
  if (!ids.length) return;

  let recent = [];
  try {
    recent = await query(
      `SELECT device_id, MAX(recorded_at) AS last_ts FROM device_health_score_history
        WHERE device_id IN (${ids.map(() => '?').join(',')})
        GROUP BY device_id`,
      ids
    );
  } catch { return; }
  const lastByDevice = {};
  for (const r of recent) lastByDevice[r.device_id] = r.last_ts;

  for (const id of ids) {
    const last = lastByDevice[id];
    if (last && nowSec - last < HISTORY_WRITE_THROTTLE_SECONDS) continue;
    try {
      await query(
        `INSERT INTO device_health_score_history (id, device_id, score, recorded_at) VALUES (?, ?, ?, ?)`,
        [crypto.randomUUID(), id, scores[id].score, nowSec]
      );
    } catch { /* best-effort — a missed history write just delays the next trend point */ }
  }
}

// Compares each device's current score against its oldest score within the
// trailing TREND_WINDOW_DAYS (i.e. "where did you start the window"), which
// answers "worsening vs. stable vs. improving over about a week" rather
// than reacting to the very last data point. Devices with no history yet
// simply have no trend to show — not the same as "stable".
async function computeTrends(scores) {
  const ids = Object.keys(scores);
  if (!ids.length) return {};
  const fromSec = Math.floor(Date.now() / 1000) - TREND_WINDOW_DAYS * 86400;

  let rows = [];
  try {
    rows = await query(
      `SELECT h.device_id, h.score FROM device_health_score_history h
        INNER JOIN (
          SELECT device_id, MIN(recorded_at) AS min_ts FROM device_health_score_history
           WHERE device_id IN (${ids.map(() => '?').join(',')}) AND recorded_at >= ?
           GROUP BY device_id
        ) oldest ON oldest.device_id = h.device_id AND oldest.min_ts = h.recorded_at`,
      [...ids, fromSec]
    );
  } catch { return {}; }

  const baselineByDevice = {};
  for (const r of rows) baselineByDevice[r.device_id] = r.score;

  const trends = {};
  for (const id of ids) {
    const baseline = baselineByDevice[id];
    if (baseline == null) { trends[id] = null; continue; }
    const delta = scores[id].score - baseline;
    trends[id] = delta > TREND_NOISE_THRESHOLD ? 'improving'
      : delta < -TREND_NOISE_THRESHOLD ? 'worsening'
      : 'stable';
  }
  return trends;
}

async function computeHealthScores(orgId) {
  const devices = await query(
    `SELECT id, name, created_at FROM devices WHERE org_id = ?`,
    [orgId]
  );
  if (!devices.length) return {};

  // ── Open alerts, grouped by device + severity ───────────────────────────
  const alertRows = await query(
    `SELECT a.device_id, ar.severity, COUNT(*) AS cnt
       FROM alert_state a
       JOIN alert_rules ar ON ar.id = a.rule_id
      WHERE a.is_active = 1 AND ar.org_id = ?
      GROUP BY a.device_id, ar.severity`,
    [orgId]
  );
  const alertsByDevice = {};
  for (const row of alertRows) {
    (alertsByDevice[row.device_id] ||= []).push({ severity: row.severity, count: row.cnt });
  }

  // ── Latest compliance snapshot per device ───────────────────────────────
  const driftRows = await query(
    `SELECT cs.device_id, cs.status
       FROM compliance_snapshots cs
       INNER JOIN (
         SELECT device_id, MAX(taken_at) AS max_ts FROM compliance_snapshots GROUP BY device_id
       ) latest ON latest.device_id = cs.device_id AND latest.max_ts = cs.taken_at
       INNER JOIN devices d ON d.id = cs.device_id
      WHERE d.org_id = ?`,
    [orgId]
  );
  const driftByDevice = {};
  for (const row of driftRows) driftByDevice[row.device_id] = row.status;

  // ── Capacity forecast — disk runway, reuses the same computation the
  // Capacity Forecast page itself calls, so the two never disagree ────────
  const forecasts = await capacityForecast.computeAllForecasts('disk', 14, orgId).catch(() => []);
  const forecastByDevice = {};
  for (const f of forecasts) forecastByDevice[f.device_id] = f;
  const { warningDays, criticalDays } = capacityForecast.getThresholds();

  // ── Uptime over the trailing window ─────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - UPTIME_WINDOW_DAYS * 86400;

  const scores = {};
  for (const device of devices) {
    const breakdown = { alerts: 0, drift: 0, capacity: 0, uptime: 0 };

    // Alerts: critical costs more than warning/info, capped so a device
    // buried in alerts still reads as "bad" rather than going negative.
    const alerts = alertsByDevice[device.id] || [];
    let alertPenalty = 0;
    for (const a of alerts) {
      alertPenalty += a.count * (a.severity === 'critical' ? 15 : a.severity === 'warning' ? 7 : 3);
    }
    breakdown.alerts = -clamp(alertPenalty, 0, 50);

    // Drift: only penalize a confirmed drift — 'error' (probe failed) or no
    // snapshot yet isn't evidence of anything, so it costs nothing.
    const drift = driftByDevice[device.id];
    breakdown.drift = drift === 'drift' ? -20 : 0;

    // Capacity: only 'rising' has a days_to_full at all.
    const forecast = forecastByDevice[device.id];
    if (forecast?.status === 'rising' && typeof forecast.days_to_full === 'number') {
      breakdown.capacity = forecast.days_to_full <= criticalDays ? -20
        : forecast.days_to_full <= warningDays ? -10 : 0;
    }

    // Uptime: only meaningful once the device has existed for at least part
    // of the window — brand new devices don't get punished for a short history.
    let uptimePct = null;
    try {
      const u = await computeDeviceUptime(device, fromSec, nowSec);
      uptimePct = u.uptimePct;
    } catch { /* leave null — no penalty */ }
    if (uptimePct !== null) breakdown.uptime = -clamp((100 - uptimePct) * 0.5, 0, 20);

    const score = clamp(100 + breakdown.alerts + breakdown.drift + breakdown.capacity + breakdown.uptime, 0, 100);
    scores[device.id] = { score: Math.round(score), breakdown, uptime_pct: uptimePct, drift_status: drift || null, days_to_full: forecast?.days_to_full ?? null };
  }

  // Best-effort: persist a throttled history point per device, then fold in
  // the resulting trend (worsening/stable/improving) — see
  // recordHealthScoreHistory/computeTrends above. Neither step should ever
  // cause the whole scores response to fail.
  try {
    await recordHealthScoreHistory(scores);
    const trends = await computeTrends(scores);
    for (const id of Object.keys(scores)) scores[id].trend = trends[id] ?? null;
  } catch {
    for (const id of Object.keys(scores)) scores[id].trend = null;
  }

  return scores;
}

module.exports = { computeHealthScores };