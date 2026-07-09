// services/digestService.js — Scheduled digest reports
//
// Compiles a summary of device health, alert activity, compliance drift, and
// backup status/verification over a lookback window, then delivers it
// through webhook.fire('digest.weekly', ...) — reusing the exact same
// subscription/severity/retry machinery every other event already goes
// through — and optionally by email if SMTP is configured
// (services/mailer.js). Mirrors services/scheduledJobs.js: load-on-boot +
// node-cron, one process only (the poller).
'use strict';
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const { query, queryOne, execute } = require('../db');
const audit = require('./audit');
const webhook = require('./webhook');
const mailer = require('./mailer');

const tasks = new Map(); // schedule.id -> cron task
const TIMEZONE = 'Asia/Kolkata'; // matches services/scheduler.js, services/scheduledJobs.js

// ── Data collection ───────────────────────────────────────────────────────────
async function collectDeviceHealth(periodStart) {
  const totals = await queryOne(`
    SELECT COUNT(*) AS total,
           SUM(status = 'online')  AS online,
           SUM(status = 'offline') AS offline,
           SUM(status NOT IN ('online','offline')) AS unknown,
           SUM(maintenance_mode = 1) AS in_maintenance
    FROM devices
  `);

  // Devices that flapped (any status transition) or went offline during the
  // window — the count that actually matters week-to-week, not just a
  // snapshot of current state.
  const wentOffline = await query(`
    SELECT DISTINCT device_id, device_name
    FROM device_status_history
    WHERE new_status = 'offline' AND timestamp >= ?
  `, [periodStart]);

  const flapping = await query(`
    SELECT device_id, device_name, COUNT(*) AS transitions
    FROM device_status_history
    WHERE timestamp >= ?
    GROUP BY device_id, device_name
    HAVING COUNT(*) >= 4
    ORDER BY transitions DESC
    LIMIT 10
  `, [periodStart]);

  return {
    total: Number(totals.total) || 0,
    online: Number(totals.online) || 0,
    offline: Number(totals.offline) || 0,
    unknown: Number(totals.unknown) || 0,
    inMaintenance: Number(totals.in_maintenance) || 0,
    newlyOfflineCount: wentOffline.length,
    newlyOffline: wentOffline.slice(0, 10).map(r => r.device_name),
    flapping: flapping.map(r => ({ name: r.device_name, transitions: r.transitions })),
  };
}

async function collectAlerts(periodStart) {
  const bySeverity = await query(`
    SELECT severity, COUNT(*) AS count
    FROM alert_triggered_log
    WHERE triggered_at >= ?
    GROUP BY severity
  `, [periodStart]);

  const unresolved = await queryOne(`
    SELECT COUNT(*) AS c FROM alert_triggered_log WHERE resolved_at IS NULL
  `);
  const unacknowledged = await queryOne(`
    SELECT COUNT(*) AS c FROM alert_triggered_log WHERE resolved_at IS NULL AND acknowledged_at IS NULL
  `);

  const topRules = await query(`
    SELECT ar.name, COUNT(*) AS count
    FROM alert_triggered_log atl
    JOIN alert_rules ar ON ar.id = atl.rule_id
    WHERE atl.triggered_at >= ?
    GROUP BY ar.id, ar.name
    ORDER BY count DESC
    LIMIT 5
  `, [periodStart]);

  const counts = { info: 0, warning: 0, critical: 0 };
  for (const row of bySeverity) counts[row.severity] = Number(row.count);

  return {
    total: counts.info + counts.warning + counts.critical,
    bySeverity: counts,
    currentlyUnresolved: Number(unresolved.c) || 0,
    currentlyUnacknowledged: Number(unacknowledged.c) || 0,
    topRules: topRules.map(r => ({ name: r.name, count: r.count })),
  };
}

async function collectCompliance() {
  // Compliance snapshots don't carry a "current status" flag on the device
  // itself — status lives per-snapshot, so "currently drifted" means each
  // device's most recent snapshot says drift.
  const rows = await query(`
    SELECT cs.device_id, cs.status
    FROM compliance_snapshots cs
    INNER JOIN (
      SELECT device_id, MAX(taken_at) AS max_taken
      FROM compliance_snapshots
      GROUP BY device_id
    ) latest ON latest.device_id = cs.device_id AND latest.max_taken = cs.taken_at
  `);

  const driftDeviceIds = rows.filter(r => r.status === 'drift').map(r => r.device_id);
  let driftedDevices = [];
  if (driftDeviceIds.length) {
    const placeholders = driftDeviceIds.map(() => '?').join(',');
    driftedDevices = await query(`SELECT name FROM devices WHERE id IN (${placeholders})`, driftDeviceIds);
  }

  return {
    devicesChecked: rows.length,
    clean: rows.filter(r => r.status === 'clean').length,
    drifted: driftDeviceIds.length,
    errored: rows.filter(r => r.status === 'error').length,
    driftedDevices: driftedDevices.map(d => d.name).slice(0, 10),
  };
}

async function collectBackups(periodStart) {
  const rows = await query(`
    SELECT status, verify_status, COUNT(*) AS count
    FROM backups
    WHERE created_at >= ?
    GROUP BY status, verify_status
  `, [periodStart]);

  const summary = { completed: 0, failed: 0, verifyPassed: 0, verifyFailed: 0, unverified: 0 };
  for (const r of rows) {
    const n = Number(r.count);
    if (r.status === 'completed') summary.completed += n;
    if (r.status === 'failed') summary.failed += n;
    if (r.verify_status === 'passed') summary.verifyPassed += n;
    if (r.verify_status === 'failed') summary.verifyFailed += n;
    if (r.verify_status === 'unverified') summary.unverified += n;
  }

  const failedVerifications = await query(`
    SELECT archive_name, verify_error FROM backups
    WHERE created_at >= ? AND verify_status = 'failed'
    ORDER BY verified_at DESC LIMIT 5
  `, [periodStart]);

  return { ...summary, failedVerifications };
}

async function buildDigest(periodDays = 7) {
  const periodEnd = Math.floor(Date.now() / 1000);
  const periodStart = periodEnd - periodDays * 86400;

  const [devices, alerts, compliance, backups] = await Promise.all([
    collectDeviceHealth(periodStart),
    collectAlerts(periodStart),
    collectCompliance(),
    collectBackups(periodStart),
  ]);

  return { periodStart, periodEnd, periodDays, devices, alerts, compliance, backups };
}

// ── Rendering ──────────────────────────────────────────────────────────────────
function renderText(digest) {
  const { devices, alerts, compliance, backups, periodDays } = digest;
  const lines = [
    `NetControl Weekly Digest — last ${periodDays} day${periodDays === 1 ? '' : 's'}`,
    ``,
    `DEVICES`,
    `  ${devices.online}/${devices.total} online, ${devices.offline} offline, ${devices.unknown} unknown, ${devices.inMaintenance} in maintenance`,
    `  ${devices.newlyOfflineCount} device(s) went offline this period`,
    devices.flapping.length ? `  Flapping: ${devices.flapping.map(f => `${f.name} (${f.transitions}x)`).join(', ')}` : null,
    ``,
    `ALERTS`,
    `  ${alerts.total} triggered (${alerts.bySeverity.critical} critical, ${alerts.bySeverity.warning} warning, ${alerts.bySeverity.info} info)`,
    `  ${alerts.currentlyUnresolved} currently unresolved, ${alerts.currentlyUnacknowledged} unacknowledged`,
    alerts.topRules.length ? `  Noisiest rules: ${alerts.topRules.map(r => `${r.name} (${r.count})`).join(', ')}` : null,
    ``,
    `COMPLIANCE`,
    `  ${compliance.clean} clean, ${compliance.drifted} drifted, ${compliance.errored} errored (of ${compliance.devicesChecked} checked)`,
    compliance.driftedDevices.length ? `  Drifted: ${compliance.driftedDevices.join(', ')}` : null,
    ``,
    `BACKUPS`,
    `  ${backups.completed} completed, ${backups.failed} failed`,
    `  Verification: ${backups.verifyPassed} passed, ${backups.verifyFailed} failed, ${backups.unverified} unverified`,
  ].filter(Boolean);
  return lines.join('\n');
}

function renderHtml(digest) {
  const { devices, alerts, compliance, backups, periodDays } = digest;
  const row = (label, value) => `<tr><td style="padding:4px 12px 4px 0;color:#94a3b8">${label}</td><td style="padding:4px 0;font-weight:600;color:#e2e8f0">${value}</td></tr>`;
  const section = (title, rowsHtml) => `
    <h3 style="color:#e2e8f0;font-family:sans-serif;margin:20px 0 8px">${title}</h3>
    <table style="font-family:sans-serif;font-size:13px;border-collapse:collapse">${rowsHtml}</table>`;

  return `
    <div style="background:#0f172a;padding:24px;border-radius:12px">
      <h2 style="color:#fff;font-family:sans-serif;margin:0">NetControl Weekly Digest</h2>
      <p style="color:#94a3b8;font-family:sans-serif;font-size:13px">Last ${periodDays} day${periodDays === 1 ? '' : 's'}</p>
      ${section('Devices', [
        row('Online', `${devices.online} / ${devices.total}`),
        row('Offline', devices.offline),
        row('Unknown', devices.unknown),
        row('In maintenance', devices.inMaintenance),
        row('Went offline this period', devices.newlyOfflineCount),
      ].join(''))}
      ${section('Alerts', [
        row('Triggered', alerts.total),
        row('Critical', alerts.bySeverity.critical),
        row('Warning', alerts.bySeverity.warning),
        row('Currently unresolved', alerts.currentlyUnresolved),
        row('Currently unacknowledged', alerts.currentlyUnacknowledged),
      ].join(''))}
      ${section('Compliance', [
        row('Clean', compliance.clean),
        row('Drifted', compliance.drifted),
        row('Errored', compliance.errored),
      ].join(''))}
      ${section('Backups', [
        row('Completed', backups.completed),
        row('Failed', backups.failed),
        row('Verify passed', backups.verifyPassed),
        row('Verify failed', backups.verifyFailed),
        row('Unverified', backups.unverified),
      ].join(''))}
    </div>`;
}

// ── Run + deliver ──────────────────────────────────────────────────────────────
async function runDigest(schedule) {
  const isScheduled = !!schedule?.id;
  try {
    const digest = await buildDigest(schedule?.period_days || 7);
    const text = renderText(digest);
    const html = renderHtml(digest);

    const overallSeverity = digest.alerts.bySeverity.critical > 0 || digest.compliance.drifted > 0 || digest.backups.failed > 0
      ? 'warning' : 'info';

    const webhookResults = await webhook.fire('digest.weekly', {
      period_days: digest.periodDays,
      devices_online: `${digest.devices.online}/${digest.devices.total}`,
      devices_offline: digest.devices.offline,
      alerts_triggered: digest.alerts.total,
      alerts_critical: digest.alerts.bySeverity.critical,
      compliance_drifted: digest.compliance.drifted,
      backups_completed: digest.backups.completed,
      backups_failed: digest.backups.failed,
      message: text, severity: overallSeverity,
    }).catch(() => []);

    let emailResult = { sent: false, reason: 'No recipients configured' };
    if (schedule?.email_recipients) {
      emailResult = await mailer.sendMail({
        to: schedule.email_recipients,
        subject: `NetControl Weekly Digest — ${new Date().toISOString().slice(0, 10)}`,
        text, html,
      });
    }

    const logId = uuidv4();
    await execute(
      `INSERT INTO digest_log (id, schedule_id, schedule_name, period_start, period_end, summary, webhook_sent, email_sent, email_error, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [logId, schedule?.id || null, schedule?.name || 'Manual run', digest.periodStart, digest.periodEnd,
       JSON.stringify(digest), webhookResults.length > 0 ? 1 : 0, emailResult.sent ? 1 : 0,
       emailResult.sent ? null : emailResult.reason, Math.floor(Date.now() / 1000)]
    );

    if (isScheduled) {
      await execute(
        `UPDATE digest_schedules SET last_run = ?, last_status = 'success', last_error = NULL, consecutive_failures = 0 WHERE id = ?`,
        [Math.floor(Date.now() / 1000), schedule.id]
      );
      await audit.log({
        username: 'scheduler', action: 'digest_schedule_run', targetType: 'digest_schedule',
        targetId: schedule.id, targetName: schedule.name, ipSource: 'scheduler', result: 'success',
        details: `${webhookResults.length} webhook(s), email ${emailResult.sent ? 'sent' : 'skipped'}`,
      });
    }

    return { logId, digest, webhookResults, emailResult };
  } catch (e) {
    if (isScheduled) {
      await execute(
        `UPDATE digest_schedules SET last_run = ?, last_status = 'failure', last_error = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
        [Math.floor(Date.now() / 1000), e.message.slice(0, 1000), schedule.id]
      ).catch(() => {});
      await audit.log({
        username: 'scheduler', action: 'digest_schedule_run', targetType: 'digest_schedule',
        targetId: schedule.id, targetName: schedule.name, ipSource: 'scheduler', result: 'failure',
        details: e.message,
      }).catch(() => {});
    }
    throw e;
  }
}

// ── Cron registration ──────────────────────────────────────────────────────────
function registerSchedule(schedule) {
  if (!cron.validate(schedule.cron_expr)) {
    console.warn(`[DigestService] Invalid cron for digest schedule "${schedule.name}": ${schedule.cron_expr}`);
    return false;
  }
  if (tasks.has(schedule.id)) {
    tasks.get(schedule.id).stop();
    tasks.delete(schedule.id);
  }
  if (!schedule.enabled) return true;

  const task = cron.schedule(schedule.cron_expr, () => {
    runDigest(schedule).catch(err => console.error(`[DigestService] Run failed for "${schedule.name}":`, err.message));
  }, { timezone: TIMEZONE });

  tasks.set(schedule.id, task);
  return true;
}

function unregisterSchedule(id) {
  if (tasks.has(id)) {
    tasks.get(id).stop();
    tasks.delete(id);
  }
}

async function start() {
  try {
    const rows = await query('SELECT * FROM digest_schedules WHERE enabled = 1');
    let registered = 0;
    for (const s of rows) if (registerSchedule(s)) registered++;
    console.log(`✅ DigestService: loaded ${registered} active digest schedule(s)`);
  } catch (e) {
    console.error('[DigestService] Failed to load digest schedules — will not retry until restart:', e.message);
  }
}

function stop() {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
}

module.exports = {
  start, stop, registerSchedule, unregisterSchedule, runDigest, buildDigest, renderText, renderHtml,
};