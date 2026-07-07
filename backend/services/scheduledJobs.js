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
const { decrypt } = require('./crypto');
const audit = require('./audit');
const webhook = require('./webhook');
const backupService = require('./backupService');
const remoteBrowse = require('./remoteBrowse');
const destinations = require('./backupDestinations');

const backupTasks = new Map();     // schedule.id -> cron task
const logExportTasks = new Map();  // schedule.id -> cron task

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
              created_by, created_by_name, created_at)
       VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, '', 'pending', ?, ?, ?)`,
      [id, schedule.source_path, isRemoteSource ? schedule.source_device_id : null, sourceDeviceName, format,
       schedule.destination_id || null, destinationName, destination.type,
       null, `schedule:${schedule.name}`, nowSec]
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
      `UPDATE backups SET source_type = ?, archive_name = ?, size_bytes = ?, checksum_sha256 = ?,
              status = 'completed', completed_at = ? WHERE id = ?`,
      [sourceType, archiveName, result.bytes, result.checksum, Math.floor(Date.now() / 1000), id]
    );

    if (destination.type === 'local') {
      const rowsNewestFirst = await query(
        `SELECT id, archive_name FROM backups WHERE status = 'completed' AND destination_type = 'local' ORDER BY created_at DESC`
      );
      const removedIds = await backupService.pruneOldArchives(rowsNewestFirst);
      if (removedIds.length) {
        const placeholders = removedIds.map(() => '?').join(',');
        await execute(`DELETE FROM backups WHERE id IN (${placeholders})`, removedIds);
      }
    }

    await execute(
      `UPDATE backup_schedules SET last_run = ?, last_status = 'success', last_error = NULL WHERE id = ?`,
      [Math.floor(Date.now() / 1000), schedule.id]
    );

    await audit.log({
      username: 'scheduler',
      action: 'backup_schedule_run',
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
      `UPDATE backup_schedules SET last_run = ?, last_status = 'failure', last_error = ? WHERE id = ?`,
      [Math.floor(Date.now() / 1000), e.message.slice(0, 1000), schedule.id]
    ).catch(() => {});
    await audit.log({
      username: 'scheduler',
      action: 'backup_schedule_run',
      targetType: 'backup_schedule',
      targetId: schedule.id,
      targetName: schedule.name,
      ipSource: 'scheduler',
      result: 'failure',
      details: e.message,
    }).catch(() => {});
    webhook.fire('backup.failed', {
      schedule: schedule.name, error: e.message, severity: 'warning',
      message: `Scheduled backup "${schedule.name}" failed: ${e.message}`,
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
  const { generateAuditExport } = require('../routes/audit');
  try {
    const filters = typeof schedule.filters === 'string' ? JSON.parse(schedule.filters || '{}') : (schedule.filters || {});
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
      `UPDATE log_export_schedules SET last_run = ?, last_status = 'success', last_error = NULL WHERE id = ?`,
      [Math.floor(Date.now() / 1000), schedule.id]
    );

    await audit.log({
      username: 'scheduler',
      action: 'log_export_schedule_run',
      targetType: 'log_export_schedule',
      targetId: schedule.id,
      targetName: schedule.name,
      ipSource: 'scheduler',
      result: 'success',
      details: `${filename} → ${destinationName || 'local'} (${result.bytes} bytes)`,
    });
  } catch (e) {
    await execute(
      `UPDATE log_export_schedules SET last_run = ?, last_status = 'failure', last_error = ? WHERE id = ?`,
      [Math.floor(Date.now() / 1000), e.message.slice(0, 1000), schedule.id]
    ).catch(() => {});
    await audit.log({
      username: 'scheduler',
      action: 'log_export_schedule_run',
      targetType: 'log_export_schedule',
      targetId: schedule.id,
      targetName: schedule.name,
      ipSource: 'scheduler',
      result: 'failure',
      details: e.message,
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
}

function stop() {
  for (const task of backupTasks.values()) task.stop();
  for (const task of logExportTasks.values()) task.stop();
  backupTasks.clear();
  logExportTasks.clear();
}

module.exports = {
  start, stop,
  registerBackupSchedule, unregisterBackupSchedule, runBackupSchedule,
  registerLogExportSchedule, unregisterLogExportSchedule, runLogExportSchedule,
};