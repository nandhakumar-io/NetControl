// services/scheduledJobs.js — cron engine for scheduled backups + scheduled
// log (audit) exports.
//
// Mirrors services/scheduler.js (device wake/shutdown/restart schedules):
// load-on-boot + node-cron, register/unregister per row, one process only
// (the poller — see poller.js / server.js PROCESS_ROLE=all dev path), so a
// clustered web tier never fires the same job N times.
//
// Each run re-executes the same logic the interactive routes use
// (POST /api/backup and GET /api/audit/export) so a scheduled run behaves
// identically to a human clicking the button — just triggered by cron and
// attributed to "scheduler" in the audit log instead of a user.
'use strict';

const { Readable } = require('stream');
const cron = require('node-cron');
const path = require('path');

const { query, queryOne, execute } = require('../db');
const { decrypt } = require('../services/crypto');
const audit = require('../services/audit');
const webhook = require('../services/webhook');
const backupService = require('../services/backupService');
const remoteBrowse = require('../services/remoteBrowse');
const destinations = require('../services/backupDestinations');
const slaReportService = require('../services/slaReportService');
const mailer = require('../services/mailer');

const backupTasks = new Map();     // schedule.id -> cron task
const logExportTasks = new Map();  // schedule.id -> cron task
const slaReportTasks = new Map();  // schedule.id -> cron task

const LOCAL_DEVICE_ID = 'local';
const TIMEZONE = 'Asia/Kolkata'; // matches services/scheduler.js

// ── Shared helpers ───────────────────────────────────────────────────────────
async function loadDeviceWithCreds(deviceId) {
  const d = await queryOne('SELECT * FROM devices WHERE id = ?', [deviceId]);
  if (!d) return null;
  return {
    ...d,
    _ssh_password: decrypt(d.ssh_password),
    _ssh_key: decrypt(d.ssh_key),
  };
}

function bufferToStream(buf) {
  return Readable.from([Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8')]);
}

// ── Backup schedules ─────────────────────────────────────────────────────────
// Reimplements POST /api/backup's body, minus req/res, so it can be driven
// by cron. Writes a row to `backups` the same way a manual run does, so
// scheduled backups show up in the same list/history/retention pruning as
// on-demand ones — the schedule is just what created them.
async function runBackupSchedule(schedule) {
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  const nowSec = Math.floor(Date.now() / 1000);
  const isRemoteSource = !!schedule.source_device_id;
  const format = schedule.format || 'zip';

  let sourceDeviceName = null;
  let destination = { type: 'local', config: {} };
  let destinationName = null;

  try {
    if (isRemoteSource) {
      const d = await queryOne('SELECT name FROM devices WHERE id = ?', [schedule.source_device_id]);
      if (!d) throw new Error('Source device for this schedule no longer exists');
      sourceDeviceName = d.name;
    }

    if (schedule.destination_id) {
      const destRow = await queryOne('SELECT * FROM backup_destinations WHERE id = ?', [schedule.destination_id]);
      if (!destRow) throw new Error('Destination for this schedule no longer exists');
      const config = destinations.decryptConfig(destRow.config);
      destinationName = destRow.name;
      if (destRow.type === 'remote_folder') {
        const destDevice = await loadDeviceWithCreds(config.deviceId);
        if (!destDevice) throw new Error('Destination device no longer exists');
        destination = { type: 'remote_folder', config, device: destDevice };
      } else {
        destination = { type: destRow.type, config };
      }
    }

    await execute(
      `INSERT INTO backups (id, source_path, device_id, device_name, source_type, format,
              destination_id, destination_name, destination_type, archive_name, status,
              created_by, created_by_name, created_at, org_id)
       VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, '', 'pending', ?, ?, ?, ?)`,
      [id, schedule.source_path, isRemoteSource ? schedule.source_device_id : null, sourceDeviceName, format,
       schedule.destination_id || null, destinationName, destination.type,
       null, `schedule:${schedule.name}`, nowSec, schedule.org_id]
    );

    const cfg = backupService.FORMAT_CONFIG[format];
    const baseName = (schedule.label || path.basename(schedule.source_path) || 'backup')
      .replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80) || 'backup';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `${baseName}-${stamp}.${cfg.ext}`;

    let stream, sourceType;
    if (isRemoteSource) {
      const device = await loadDeviceWithCreds(schedule.source_device_id);
      const archiveResult = await remoteBrowse.archiveStream(device, schedule.mount, schedule.source_path, format);
      stream = archiveResult.stream;
      const st = await remoteBrowse.statAbs(device, schedule.mount, schedule.source_path);
      sourceType = st.isDirectory ? 'folder' : 'file';
    } else {
      const built = backupService.buildLocalArchiveStream({ sourcePath: schedule.source_path, format });
      stream = built.stream;
      sourceType = built.sourceType;
    }

    const result = await destinations.writeToDestination(stream, archiveName, destination, backupService.BACKUP_STORE_DIR);

    await execute(
      `UPDATE backups SET source_type = ?, archive_name = ?, size_bytes = ?, checksum_sha256 = ?, encrypted = ?,
              status = 'completed', completed_at = ? WHERE id = ?`,
      [sourceType, archiveName, result.bytes, result.checksum, result.encrypted ? 1 : 0, Math.floor(Date.now() / 1000), id]
    );

    if (destination.type === 'local') {
      const rowsNewestFirst = await query(
        `SELECT id, archive_name FROM backups WHERE status = 'completed' AND destination_type = 'local' AND org_id = ? ORDER BY created_at DESC`,
        [schedule.org_id]
      );
      const removedIds = await backupService.pruneOldArchives(rowsNewestFirst);
      if (removedIds.length) {
        const placeholders = removedIds.map(() => '?').join(',');
        await execute(`DELETE FROM backups WHERE id IN (${placeholders})`, removedIds);
      }
    }

    await execute(
      `UPDATE backup_schedules SET last_run = ?, last_status = 'success', last_error = NULL, consecutive_failures = 0 WHERE id = ?`,
      [Math.floor(Date.now() / 1000), schedule.id]
    );

    await audit.log({
      username: 'scheduler',
      action: 'backup_schedule_run',
      orgId: schedule.org_id,
      targetType: 'backup_schedule',
      targetId: schedule.id,
      targetName: schedule.name,
      ipSource: 'scheduler',
      result: 'success',
      details: `${sourceType} ${schedule.source_path}${sourceDeviceName ? ` on ${sourceDeviceName}` : ''} → ${destinationName || 'local'}/${archiveName} (${format}, ${result.bytes} bytes)`,
    });

    webhook.fire('backup.created', {
      id, source_path: schedule.source_path, device: sourceDeviceName, format, archive_name: archiveName,
      destination: destinationName || 'local', bytes: result.bytes, created_by: `schedule:${schedule.name}`,
      severity: 'info',
      message: `Scheduled backup "${schedule.name}" ran → ${destinationName || 'local'}/${archiveName}`,
    }).catch(() => {});
  } catch (e) {
    await execute(`UPDATE backups SET status = 'failed', error_message = ? WHERE id = ?`, [e.message, id]).catch(() => {});
    await execute(
      `UPDATE backup_schedules SET last_run = ?, last_status = 'failure', last_error = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
      [Math.floor(Date.now() / 1000), e.message.slice(0, 1000), schedule.id]
    ).catch(() => {});
    const streak = await queryOne('SELECT consecutive_failures FROM backup_schedules WHERE id = ?', [schedule.id]).catch(() => null);
    await audit.log({
      username: 'scheduler',
      action: 'backup_schedule_run',
      orgId: schedule.org_id,
      targetType: 'backup_schedule',
      targetId: schedule.id,
      targetName: schedule.name,
      ipSource: 'scheduler',
      result: 'failure',
      details: e.message,
    }).catch(() => {});
    // Tweak: escalate to 'critical' once 3+ runs in a row have failed —
    // a single failed backup is a warning, a backup that's been silently
    // broken for days is a much bigger deal and shouldn't look identical
    // in a Telegram/Slack feed.
    const n = streak?.consecutive_failures || 1;
    webhook.fire('backup.failed', {
      schedule: schedule.name, error: e.message, consecutive_failures: n,
      severity: n >= 3 ? 'critical' : 'warning',
      message: `Scheduled backup "${schedule.name}" failed${n > 1 ? ` (${n} runs in a row)` : ''}: ${e.message}`,
    }).catch(() => {});
  }
}

function registerBackupSchedule(schedule) {
  if (!cron.validate(schedule.cron_expr)) {
    console.warn(`[ScheduledJobs] Invalid cron for backup schedule "${schedule.name}": ${schedule.cron_expr}`);
    return false;
  }
  if (backupTasks.has(schedule.id)) {
    backupTasks.get(schedule.id).stop();
    backupTasks.delete(schedule.id);
  }
  if (!schedule.enabled) return true;

  const task = cron.schedule(schedule.cron_expr, () => {
    runBackupSchedule(schedule).catch(console.error);
  }, { timezone: TIMEZONE });

  backupTasks.set(schedule.id, task);
  return true;
}

function unregisterBackupSchedule(id) {
  if (backupTasks.has(id)) {
    backupTasks.get(id).stop();
    backupTasks.delete(id);
  }
}

// ── Log export schedules ─────────────────────────────────────────────────────
// Reuses routes/audit.js's own export renderer so a scheduled export is
// byte-for-byte what a human would get clicking "Export" with the same
// filters — then hands the bytes to a destination (or the local backup
// store) exactly like a backup archive would be.
async function runLogExportSchedule(schedule) {
  const { generateAuditExport, queryAuditRows } = require('../routes/audit');
  try {
    const filters = typeof schedule.filters === 'string' ? JSON.parse(schedule.filters || '{}') : (schedule.filters || {});
    const exportTarget = schedule.export_target || 'file';

    // ── Syslog target: no file at all, just stream each matching audit
    //    row to the configured syslog server as its own message. ───────────
    if (exportTarget === 'syslog') {
      const syslogForwarder = require('../services/syslogForwarder');
      const rows = await queryAuditRows(filters);
      const { sent, failed, total } = await syslogForwarder.exportEntries(rows);

      await execute(
        `UPDATE log_export_schedules SET last_run = ?, last_status = 'success', last_error = NULL, consecutive_failures = 0 WHERE id = ?`,
        [Math.floor(Date.now() / 1000), schedule.id]
      );

      await audit.log({
        username: 'scheduler',
        action: 'log_export_schedule_run',
        orgId: schedule.org_id,
        targetType: 'log_export_schedule',
        targetId: schedule.id,
        targetName: schedule.name,
        ipSource: 'scheduler',
        result: failed > 0 ? 'partial' : 'success',
        details: `${sent}/${total} rows sent to syslog server${failed ? `, ${failed} failed` : ''}`,
      });
      webhook.fire('log_export.succeeded', {
        schedule: schedule.name, target: 'syslog', sent, total, failed,
        severity: failed > 0 ? 'warning' : 'info',
        message: `Scheduled log export "${schedule.name}" sent ${sent}/${total} rows to syslog${failed ? ` (${failed} failed)` : ''}`,
      }).catch(() => {});
      return;
    }

    // ── File target (existing behavior): render + write to a
    //    backup_destinations row, or the local store when destination_id
    //    is NULL. ─────────────────────────────────────────────────────────
    const format = schedule.format || 'csv';
    const { body, filename } = await generateAuditExport(filters, format);

    let destination = { type: 'local', config: {} };
    let destinationName = null;
    if (schedule.destination_id) {
      const destRow = await queryOne('SELECT * FROM backup_destinations WHERE id = ?', [schedule.destination_id]);
      if (!destRow) throw new Error('Destination for this schedule no longer exists');
      const config = destinations.decryptConfig(destRow.config);
      destinationName = destRow.name;
      if (destRow.type === 'remote_folder') {
        const destDevice = await loadDeviceWithCreds(config.deviceId);
        if (!destDevice) throw new Error('Destination device no longer exists');
        destination = { type: 'remote_folder', config, device: destDevice };
      } else {
        destination = { type: destRow.type, config };
      }
    }

    const result = await destinations.writeToDestination(bufferToStream(body), filename, destination, backupService.BACKUP_STORE_DIR);

    await execute(
      `UPDATE log_export_schedules SET last_run = ?, last_status = 'success', last_error = NULL, consecutive_failures = 0 WHERE id = ?`,
      [Math.floor(Date.now() / 1000), schedule.id]
    );

    await audit.log({
      username: 'scheduler',
      action: 'log_export_schedule_run',
      orgId: schedule.org_id,
      targetType: 'log_export_schedule',
      targetId: schedule.id,
      targetName: schedule.name,
      ipSource: 'scheduler',
      result: 'success',
      details: `${filename} → ${destinationName || 'local'} (${result.bytes} bytes)`,
    });
    webhook.fire('log_export.succeeded', {
      schedule: schedule.name, target: 'file', filename, destination: destinationName || 'local',
      bytes: result.bytes, severity: 'info',
      message: `Scheduled log export "${schedule.name}" ran → ${destinationName || 'local'}/${filename}`,
    }).catch(() => {});
  } catch (e) {
    await execute(
      `UPDATE log_export_schedules SET last_run = ?, last_status = 'failure', last_error = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
      [Math.floor(Date.now() / 1000), e.message.slice(0, 1000), schedule.id]
    ).catch(() => {});
    const streak = await queryOne('SELECT consecutive_failures FROM log_export_schedules WHERE id = ?', [schedule.id]).catch(() => null);
    await audit.log({
      username: 'scheduler',
      action: 'log_export_schedule_run',
      orgId: schedule.org_id,
      targetType: 'log_export_schedule',
      targetId: schedule.id,
      targetName: schedule.name,
      ipSource: 'scheduler',
      result: 'failure',
      details: e.message,
    }).catch(() => {});
    const n = streak?.consecutive_failures || 1;
    webhook.fire('log_export.failed', {
      schedule: schedule.name, error: e.message, consecutive_failures: n,
      severity: n >= 3 ? 'critical' : 'warning',
      message: `Scheduled log export "${schedule.name}" failed${n > 1 ? ` (${n} runs in a row)` : ''}: ${e.message}`,
    }).catch(() => {});
  }
}

function registerLogExportSchedule(schedule) {
  if (!cron.validate(schedule.cron_expr)) {
    console.warn(`[ScheduledJobs] Invalid cron for log export schedule "${schedule.name}": ${schedule.cron_expr}`);
    return false;
  }
  if (logExportTasks.has(schedule.id)) {
    logExportTasks.get(schedule.id).stop();
    logExportTasks.delete(schedule.id);
  }
  if (!schedule.enabled) return true;

  const task = cron.schedule(schedule.cron_expr, () => {
    runLogExportSchedule(schedule).catch(console.error);
  }, { timezone: TIMEZONE });

  logExportTasks.set(schedule.id, task);
  return true;
}

function unregisterLogExportSchedule(id) {
  if (logExportTasks.has(id)) {
    logExportTasks.get(id).stop();
    logExportTasks.delete(id);
  }
}

// ── SLA report schedules ─────────────────────────────────────────────────────
// Reuses services/slaReportService.js's generateReport() — the exact same
// code path POST /api/sla-reports/generate calls — so a scheduled report is
// byte-for-byte what a human clicking "Generate" would get, just with the
// period window computed from the schedule's period_mode instead of typed
// in by hand, and attributed to "scheduler" rather than a user.
function computePeriod(schedule) {
  const now = new Date();
  if (schedule.period_mode === 'trailing_days') {
    const days = schedule.period_days || 30;
    const to = Math.floor(now.getTime() / 1000);
    const from = to - days * 86400;
    return { from, to };
  }
  // previous_calendar_month (default): whatever month just ended relative
  // to when this fires. A schedule set for "1st of month, 06:00" firing on
  // e.g. March 1st reports on all of February — the natural meaning of
  // "monthly SLA report" for a client-facing deliverable.
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const firstOfPrevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return {
    from: Math.floor(firstOfPrevMonth.getTime() / 1000),
    to: Math.floor(firstOfThisMonth.getTime() / 1000),
  };
}

async function runSlaReportSchedule(schedule) {
  try {
    const { from, to } = computePeriod(schedule);
    const org = await queryOne('SELECT name FROM organizations WHERE id = ?', [schedule.org_id]);
    if (!org) throw new Error('Organization for this schedule no longer exists');

    const result = await slaReportService.generateReport({
      orgId: schedule.org_id, orgName: org.name,
      scope: schedule.scope_type, scopeId: schedule.scope_id || null,
      from, to, userId: null, username: `scheduler:${schedule.name}`,
    });

    let emailResult = { sent: false, reason: 'No recipients configured' };
    if (schedule.email_recipients) {
      const fs = require('fs');
      emailResult = await mailer.sendMail({
        to: schedule.email_recipients,
        subject: `${org.name} — Monthly SLA Report (${result.reportData.scopeName})`,
        text: `Your scheduled SLA/uptime report for ${result.reportData.scopeName} is attached.\n\n` +
              `Period: ${new Date(from * 1000).toISOString().slice(0, 10)} to ${new Date(to * 1000).toISOString().slice(0, 10)}\n` +
              `Devices covered: ${result.reportData.deviceCount}\n` +
              `Average uptime: ${result.reportData.avgUptimePct !== null ? result.reportData.avgUptimePct.toFixed(3) + '%' : 'n/a'}\n`,
        html: `<p>Your scheduled SLA/uptime report for <strong>${result.reportData.scopeName}</strong> is attached.</p>
               <p>Period: ${new Date(from * 1000).toISOString().slice(0, 10)} to ${new Date(to * 1000).toISOString().slice(0, 10)}<br/>
               Devices covered: ${result.reportData.deviceCount}<br/>
               Average uptime: ${result.reportData.avgUptimePct !== null ? result.reportData.avgUptimePct.toFixed(3) + '%' : 'n/a'}</p>`,
        attachments: [{ filename: result.fileName, content: fs.readFileSync(result.filePath) }],
      }).catch(e => ({ sent: false, reason: e.message }));
    }

    await execute(
      `UPDATE sla_report_schedules SET last_run = ?, last_status = 'success', last_error = NULL,
              last_report_id = ?, consecutive_failures = 0 WHERE id = ?`,
      [Math.floor(Date.now() / 1000), result.id, schedule.id]
    );

    webhook.fire('sla_report.generated', {
      org_id: schedule.org_id, schedule_name: schedule.name, report_id: result.id,
      scope: result.reportData.scopeName, device_count: result.reportData.deviceCount,
      avg_uptime_pct: result.reportData.avgUptimePct, severity: 'info',
      message: `Scheduled SLA report "${schedule.name}" generated for ${result.reportData.scopeName} ` +
               `(${result.reportData.deviceCount} device(s), avg uptime ${result.reportData.avgUptimePct ?? 'n/a'}%)` +
               (schedule.email_recipients ? `, email ${emailResult.sent ? 'sent' : 'skipped: ' + emailResult.reason}` : ''),
    }).catch(() => {});

    await audit.log({
      username: 'scheduler', action: 'sla_report_schedule_run', orgId: schedule.org_id, targetType: 'sla_report_schedule',
      targetId: schedule.id, targetName: schedule.name, ipSource: 'scheduler', result: 'success',
      details: `Report ${result.id} generated, email ${emailResult.sent ? 'sent' : 'skipped'}`,
    }).catch(() => {});
  } catch (e) {
    await execute(
      `UPDATE sla_report_schedules SET last_run = ?, last_status = 'failure', last_error = ?,
              consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
      [Math.floor(Date.now() / 1000), e.message.slice(0, 1000), schedule.id]
    ).catch(() => {});

    webhook.fire('sla_report.failed', {
      org_id: schedule.org_id, schedule_name: schedule.name, error: e.message, severity: 'warning',
      message: `Scheduled SLA report "${schedule.name}" FAILED: ${e.message}`,
    }).catch(() => {});

    await audit.log({
      username: 'scheduler', action: 'sla_report_schedule_run', orgId: schedule.org_id, targetType: 'sla_report_schedule',
      targetId: schedule.id, targetName: schedule.name, ipSource: 'scheduler', result: 'failure',
      details: e.message,
    }).catch(() => {});

    throw e;
  }
}

function registerSlaReportSchedule(schedule) {
  if (!cron.validate(schedule.cron_expr)) {
    console.warn(`[ScheduledJobs] Invalid cron for SLA report schedule "${schedule.name}": ${schedule.cron_expr}`);
    return false;
  }
  if (slaReportTasks.has(schedule.id)) {
    slaReportTasks.get(schedule.id).stop();
    slaReportTasks.delete(schedule.id);
  }
  if (!schedule.enabled) return true;

  const task = cron.schedule(schedule.cron_expr, () => {
    runSlaReportSchedule(schedule).catch(err => console.error(`[ScheduledJobs] SLA report run failed for "${schedule.name}":`, err.message));
  }, { timezone: TIMEZONE });

  slaReportTasks.set(schedule.id, task);
  return true;
}

function unregisterSlaReportSchedule(id) {
  if (slaReportTasks.has(id)) {
    slaReportTasks.get(id).stop();
    slaReportTasks.delete(id);
  }
}

// ── Group device-count snapshots ─────────────────────────────────────────────
// Powers the Groups page's "+3 since yesterday" trend indicator. One row
// per group per day, upserted daily — not a schedule a user creates/edits
// (unlike backup/log-export/SLA schedules above), so it isn't in the
// backup/logExport/slaReport task Maps or registered from a DB table; it's
// just always-on for the life of the process, same idea as the poller's own
// tick loop.
//
// ON DUPLICATE KEY UPDATE makes this safe to run more than once for the
// same day (e.g. a restart right after midnight) — it just re-overwrites
// today's count rather than creating a second row or erroring.
let groupSnapshotTask = null;

async function snapshotGroupDeviceCounts() {
  try {
    await execute(
      `INSERT INTO group_device_count_snapshots (group_id, snapshot_date, device_count)
       SELECT g.id, CURDATE(), COUNT(d.id)
         FROM \`groups\` g LEFT JOIN devices d ON d.group_id = g.id
        GROUP BY g.id
       ON DUPLICATE KEY UPDATE device_count = VALUES(device_count)`
    );
  } catch (e) {
    console.error('[ScheduledJobs] Group device-count snapshot failed:', e.message);
  }
}

// ── Boot / shutdown ──────────────────────────────────────────────────────────
async function start() {
  try {
    const backupRows = await query('SELECT * FROM backup_schedules WHERE enabled = 1');
    let registered = 0;
    for (const s of backupRows) if (registerBackupSchedule(s)) registered++;
    console.log(`✅ ScheduledJobs: loaded ${registered} active backup schedule(s)`);
  } catch (e) {
    console.error('[ScheduledJobs] Failed to load backup schedules — will not retry until restart:', e.message);
  }

  try {
    const logRows = await query('SELECT * FROM log_export_schedules WHERE enabled = 1');
    let registered = 0;
    for (const s of logRows) if (registerLogExportSchedule(s)) registered++;
    console.log(`✅ ScheduledJobs: loaded ${registered} active log export schedule(s)`);
  } catch (e) {
    console.error('[ScheduledJobs] Failed to load log export schedules — will not retry until restart:', e.message);
  }

  try {
    const slaRows = await query('SELECT * FROM sla_report_schedules WHERE enabled = 1');
    let registered = 0;
    for (const s of slaRows) if (registerSlaReportSchedule(s)) registered++;
    console.log(`✅ ScheduledJobs: loaded ${registered} active SLA report schedule(s)`);
  } catch (e) {
    console.error('[ScheduledJobs] Failed to load SLA report schedules — will not retry until restart:', e.message);
  }

  // Daily group device-count snapshot — 00:10 so it lands just after
  // midnight in TIMEZONE, same convention as the other cron expressions
  // in this file. Also run once immediately on boot: if the process was
  // down at 00:10 (deploy, crash-restart), today's snapshot would
  // otherwise just be missing until tomorrow's run, silently breaking the
  // trend for a day rather than erroring anywhere visible.
  try {
    groupSnapshotTask = cron.schedule('10 0 * * *', () => { snapshotGroupDeviceCounts(); }, { timezone: TIMEZONE });
    snapshotGroupDeviceCounts();
    console.log('✅ ScheduledJobs: group device-count snapshot scheduled (daily 00:10)');
  } catch (e) {
    console.error('[ScheduledJobs] Failed to schedule group device-count snapshot:', e.message);
  }
}

function stop() {
  for (const task of backupTasks.values()) task.stop();
  for (const task of logExportTasks.values()) task.stop();
  for (const task of slaReportTasks.values()) task.stop();
  backupTasks.clear();
  logExportTasks.clear();
  slaReportTasks.clear();
  if (groupSnapshotTask) { groupSnapshotTask.stop(); groupSnapshotTask = null; }
}

module.exports = {
  start, stop,
  registerBackupSchedule, unregisterBackupSchedule, runBackupSchedule,
  registerLogExportSchedule, unregisterLogExportSchedule, runLogExportSchedule,
  registerSlaReportSchedule, unregisterSlaReportSchedule, runSlaReportSchedule,
};