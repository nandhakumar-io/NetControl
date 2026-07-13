// services/bulkCommand.js — "run this one command across 40 devices and
// watch the results stream in live, retry the ones that failed."
//
// Reuses the exact same SSH/WinRM execution path as the single-device
// /api/actions/exec endpoint (services/ssh.js / services/winrm.js) — this
// is that same building block fanned out over a device list with bounded
// concurrency, an in-memory job/event log so an SSE client can attach at
// any point (before, during, or — for replay — just after completion) and
// still see the whole run, and a stdlib-simple retry: re-running is just
// creating a new job scoped to the previously-failed device ids.
//
// Jobs live in-process only (like routes/metrics.js's `store` and SSE
// client map) — fine for a single-worker-per-request live console; a
// multi-worker cluster would need this behind Redis, same caveat this
// codebase already accepts elsewhere.
'use strict';
const { v4: uuidv4 } = require('uuid');
const ssh = require('./ssh');
const winrm = require('./winrm');
const audit = require('./audit');

const MAX_CONCURRENCY = 8;       // don't open 40 simultaneous SSH/WinRM connections at once
const PER_DEVICE_TIMEOUT_MS = 30000;
const JOB_TTL_MS = 30 * 60 * 1000; // jobs older than this get swept up so the Map doesn't grow forever

const jobs = new Map(); // runId -> job

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function emit(job, event) {
  job.events.push(event);
  for (const res of job.listeners) {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone, sseDel will clean it up on 'close' */ }
  }
}

function addListener(runId, res) {
  const job = jobs.get(runId);
  if (!job) return false;
  // Replay everything so far — covers the client connecting mid-run
  // (nothing missed) or right after it finished (still sees the full
  // result set instead of an empty stream).
  for (const event of job.events) {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
  }
  job.listeners.add(res);
  return true;
}
function removeListener(runId, res) {
  jobs.get(runId)?.listeners.delete(res);
}
function getJob(runId) {
  return jobs.get(runId) || null;
}

/**
 * Kicks off a bulk run and returns immediately with a runId — execution
 * continues in the background; connect to the SSE stream to watch it.
 *
 * devices: array of already-loaded, already-permission-checked device
 * objects (with decrypted _ssh_password/_ssh_key/_winrm_password — see
 * routes/actions.js's loadDevice) — this function does no further access
 * control itself, same division of responsibility as runbookRunner.js.
 */
function startRun({ command, devices, userId, username, orgId }) {
  const runId = uuidv4();
  const job = {
    runId, command, orgId, userId, username,
    total: devices.length,
    startedAt: Date.now(),
    status: 'running',
    events: [],
    listeners: new Set(),
  };
  jobs.set(runId, job);
  emit(job, { type: 'start', runId, total: devices.length, command });

  // Fire-and-forget — the caller gets runId back immediately and connects
  // the SSE stream separately, same pattern as discovery scans.
  runPool(job, devices).catch(e => {
    emit(job, { type: 'fatal', message: e.message });
  }).finally(() => {
    job.status = 'done';
    job.finishedAt = Date.now();
    emit(job, { type: 'done', runId });
    setTimeout(() => jobs.delete(runId), JOB_TTL_MS);
  });

  return runId;
}

async function runPool(job, devices) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, devices.length) }, () => worker());

  async function worker() {
    while (cursor < devices.length) {
      const device = devices[cursor++];
      emit(job, { type: 'device_start', deviceId: device.id, deviceName: device.name });

      let status = 'success', output = '';
      const startedAt = Date.now();
      try {
        const exec = device.os_type === 'linux' ? ssh.execCommand : winrm.execCommand;
        const result = await withTimeout(exec(device, job.command), PER_DEVICE_TIMEOUT_MS, `Command on ${device.name}`);
        output = (result?.stdout ?? '').slice(0, 8000);
      } catch (e) {
        status = 'failure';
        output = e.message;
      }
      const durationMs = Date.now() - startedAt;

      emit(job, { type: 'device_result', deviceId: device.id, deviceName: device.name, status, output, durationMs });

      await audit.log({
        userId: job.userId, username: job.username, action: 'bulk_exec_command',
        targetType: 'device', targetId: device.id, targetName: device.name,
        result: status === 'success' ? 'success' : 'failure',
        details: `Bulk command run: CMD: ${job.command}`,
      }).catch(() => {});
    }
  }

  await Promise.all(workers);
}

module.exports = { startRun, addListener, removeListener, getJob };