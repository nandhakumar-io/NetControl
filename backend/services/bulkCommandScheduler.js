// services/bulkCommandScheduler.js — cron engine for saved bulk command
// schedules (bulk_command_schedules table).
//
// Mirrors services/scheduledJobs.js: load-on-boot + node-cron,
// register/unregister per row, one process only (the poller — see
// poller.js), so a clustered web tier never fires the same run N times.
//
// Each firing reuses services/bulkCommand.js's startRun() — the exact same
// execution path as POST /api/bulk-command/run — then polls the job to
// completion so this can record last_run/last_status and fire a webhook,
// the same as every other scheduled job in this app.
'use strict';
const cron = require('node-cron');
const { query, queryOne, execute } = require('../db');
const { decrypt } = require('./crypto');
const audit = require('./audit');
const webhook = require('./webhook');
const bulkCommand = require('./bulkCommand');

const tasks = new Map(); // schedule.id -> cron task
const TIMEZONE = 'Asia/Kolkata'; // matches services/scheduler.js, services/scheduledJobs.js

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 90 * 60 * 1000; // 90 min ceiling — well above bulkCommand's own 1h per-device cap

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Same shape routes/bulkCommand.js's loadDevice() produces — decrypted
// creds attached, org-filtered so a schedule can never reach into another
// tenant's devices even if device_ids was somehow tampered with directly
// in the DB.
async function loadDevices(deviceIds, orgId) {
  if (!deviceIds.length) return { accessible: [], skipped: [] };
  const placeholders = deviceIds.map(() => '?').join(',');
  const rows = await query(
    `SELECT * FROM devices WHERE id IN (${placeholders}) AND org_id = ?`,
    [...deviceIds, orgId]
  );
  const found = new Map(rows.map(d => [d.id, d]));
  const accessible = [], skipped = [];
  for (const id of deviceIds) {
    const d = found.get(id);
    if (!d) { skipped.push({ deviceId: id, reason: 'Device not found' }); continue; }
    if (d.maintenance_mode) { skipped.push({ deviceId: id, deviceName: d.name, reason: 'Under maintenance' }); continue; }
    accessible.push({
      ...d,
      _ssh_password:   decrypt(d.ssh_password),
      _ssh_key:        decrypt(d.ssh_key),
      _winrm_password: decrypt(d.winrm_password),
    });
  }
  return { accessible, skipped };
}

// Waits for a bulkCommand run to reach status 'done', then summarizes
// pass/fail counts from its event log. Bounded so a device that's somehow
// hung past bulkCommand's own per-device timeout can't wedge the cron
// scheduler forever.
async function awaitCompletion(runId) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const job = await bulkCommand.getJob(runId);
    if (!job) throw new Error('Run disappeared before completing (job state expired)');
    if (job.status === 'done') break;
    await sleep(POLL_INTERVAL_MS);
  }
  const events = await bulkCommand.getEvents(runId);
  const results = events.filter(e => e.type === 'device_result');
  const succeeded = results.filter(e => e.status === 'success').length;
  const failed = results.filter(e => e.status === 'failure').length;
  return { succeeded, failed, total: results.length };
}

async function runSchedule(schedule) {
  const isScheduled = !!schedule?.id;
  try {
    const deviceIds = JSON.parse(schedule.device_ids || '[]');
    const { accessible, skipped } = await loadDevices(deviceIds, schedule.org_id);

    if (!accessible.length) {
      throw new Error(`No accessible devices to run against (${skipped.length} skipped)`);
    }

    const runId = bulkCommand.startRun({
      command: schedule.command, devices: accessible,
      userId: schedule.created_by, username: 'scheduler', orgId: schedule.org_id,
      timeoutMs: (schedule.timeout_sec || 30) * 1000,
    });

    const { succeeded, failed, total } = await awaitCompletion(runId);
    const status = failed === 0 ? 'success' : succeeded === 0 ? 'failure' : 'partial';
    const now = Math.floor(Date.now() / 1000);

    await execute(
      `UPDATE bulk_command_schedules
         SET last_run = ?, last_status = ?, last_error = NULL, last_run_id = ?,
             consecutive_failures = IF(? = 'failure', consecutive_failures + 1, 0)
       WHERE id = ?`,
      [now, status, runId, status, schedule.id]
    );

    const message = `Scheduled bulk command "${schedule.name}": ${succeeded}/${total} succeeded` +
      (skipped.length ? `, ${skipped.length} skipped` : '') +
      (failed ? `, ${failed} failed` : '');

    await webhook.fire(status === 'success' ? 'bulk_schedule.succeeded' : 'bulk_schedule.failed', {
      schedule_id: schedule.id, schedule_name: schedule.name, run_id: runId,
      succeeded, failed, total, skipped: skipped.length,
      severity: status === 'success' ? 'info' : (status === 'failure' ? 'critical' : 'warning'),
      message,
    }).catch(() => {});

    await audit.log({
      username: 'scheduler', action: 'bulk_command_schedule_run', orgId: schedule.org_id,
      targetType: 'bulk_command_schedule', targetId: schedule.id, targetName: schedule.name,
      ipSource: 'scheduler', result: status === 'failure' ? 'failure' : 'success', details: message,
    }).catch(() => {});

    return { runId, succeeded, failed, total, skipped };
  } catch (e) {
    if (isScheduled) {
      await execute(
        `UPDATE bulk_command_schedules
           SET last_run = ?, last_status = 'failure', last_error = ?, consecutive_failures = consecutive_failures + 1
         WHERE id = ?`,
        [Math.floor(Date.now() / 1000), e.message.slice(0, 1000), schedule.id]
      ).catch(() => {});

      const n = (schedule.consecutive_failures || 0) + 1;
      await webhook.fire('bulk_schedule.failed', {
        schedule_id: schedule.id, schedule_name: schedule.name, error: e.message,
        severity: n >= 3 ? 'critical' : 'warning',
        message: `Scheduled bulk command "${schedule.name}" failed${n > 1 ? ` (${n} runs in a row)` : ''}: ${e.message}`,
      }).catch(() => {});

      await audit.log({
        username: 'scheduler', action: 'bulk_command_schedule_run', orgId: schedule.org_id,
        targetType: 'bulk_command_schedule', targetId: schedule.id, targetName: schedule.name,
        ipSource: 'scheduler', result: 'failure', details: e.message,
      }).catch(() => {});
    }
    throw e;
  }
}

function registerSchedule(schedule) {
  if (!cron.validate(schedule.cron_expr)) {
    console.warn(`[BulkCommandScheduler] Invalid cron for schedule "${schedule.name}": ${schedule.cron_expr}`);
    return false;
  }
  if (tasks.has(schedule.id)) {
    tasks.get(schedule.id).stop();
    tasks.delete(schedule.id);
  }
  if (!schedule.enabled) return true;

  const task = cron.schedule(schedule.cron_expr, () => {
    runSchedule(schedule).catch(err => console.error(`[BulkCommandScheduler] Run failed for "${schedule.name}":`, err.message));
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
    const rows = await query('SELECT * FROM bulk_command_schedules WHERE enabled = 1');
    let registered = 0;
    for (const s of rows) if (registerSchedule(s)) registered++;
    console.log(`✅ BulkCommandScheduler: loaded ${registered} active bulk command schedule(s)`);
  } catch (e) {
    console.error('[BulkCommandScheduler] Failed to load schedules — will not retry until restart:', e.message);
  }
}

function stop() {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
}

module.exports = { start, stop, registerSchedule, unregisterSchedule, runSchedule };