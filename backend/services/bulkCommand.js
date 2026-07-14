// services/bulkCommand.js — "run this one command across 40 devices and
// watch the results stream in live, retry the ones that failed."
//
// Reuses the exact same SSH/WinRM execution path as the single-device
// /api/actions/exec endpoint (services/ssh.js / services/winrm.js) — this
// is that same building block fanned out over a device list with bounded
// concurrency.
//
// STRUCTURAL FIX (this revision): job state + event log used to live in a
// plain in-memory `jobs` Map, scoped to a single cluster worker process.
// That was the real bug behind "bulk run just sits there, nothing
// executes" — Node's cluster scheduler round-robins every new HTTP
// connection across workers, it does NOT pin a browser to the worker that
// handled its previous request. So POST /run could create (and fully run!)
// a job on worker A, while the browser's very next request — the
// EventSource connecting to GET /:runId/stream — could land on worker B,
// which had never heard of that runId: instant 404. EventSource swallows
// that as a retryable error and just keeps reconnecting forever, so the
// console shows every device stuck at "pending" even though the commands
// already executed (and were already audit-logged) on worker A. Exactly
// the class of bug services/bus.js was built to fix for the metrics SSE
// feed, and services/webTerminal.js was already fixed for — this just
// never got the same treatment.
//
// Fix: durable job metadata + the replay event log now live in Redis
// (shared across workers), with real-time delivery going through
// services/bus.js's existing pub/sub — which already transparently falls
// back to an in-process EventEmitter when REDIS_URL isn't set, so a
// single-process/no-Redis dev setup keeps working unchanged (with the same
// single-process caveat this codebase already accepts elsewhere).
'use strict';
const { v4: uuidv4 } = require('uuid');
const ssh = require('./ssh');
const winrm = require('./winrm');
const audit = require('./audit');
const bus = require('./bus');

const MAX_CONCURRENCY = 8;       // don't open 40 simultaneous SSH/WinRM connections at once
const PER_DEVICE_TIMEOUT_MS = 30000;
const JOB_TTL_SEC = 30 * 60; // jobs older than this get swept up so state doesn't grow forever

const redis = bus.getClient(); // null in single-process fallback mode
const memJobs = new Map();     // runId -> job, used only when redis is null

function jKey(id) { return `bulk:job:${id}`; }
function eKey(id) { return `bulk:events:${id}`; }
function chan(id) { return `bulk:events:${id}`; }

async function createJob(runId, { command, orgId, userId, username, total }) {
  const now = Date.now();
  if (redis) {
    await redis.hset(jKey(runId), {
      command, orgId, userId, username, total,
      status: 'running', startedAt: now,
    });
    await redis.expire(jKey(runId), JOB_TTL_SEC);
  } else {
    memJobs.set(runId, {
      runId, command, orgId, userId, username, total,
      startedAt: now, status: 'running', events: [], listeners: new Set(),
    });
  }
}

async function getJob(runId) {
  if (redis) {
    const h = await redis.hgetall(jKey(runId));
    if (!h || !h.command) return null;
    return {
      runId, command: h.command, orgId: h.orgId, userId: h.userId, username: h.username,
      total: Number(h.total), status: h.status,
      startedAt: Number(h.startedAt), finishedAt: h.finishedAt ? Number(h.finishedAt) : null,
    };
  }
  return memJobs.get(runId) || null;
}

async function finishJob(runId) {
  const now = Date.now();
  if (redis) {
    if (await redis.exists(jKey(runId))) await redis.hset(jKey(runId), 'status', 'done', 'finishedAt', now);
    await redis.expire(jKey(runId), JOB_TTL_SEC);
    await redis.expire(eKey(runId), JOB_TTL_SEC);
  } else {
    const job = memJobs.get(runId);
    if (job) { job.status = 'done'; job.finishedAt = now; }
    setTimeout(() => memJobs.delete(runId), JOB_TTL_SEC * 1000);
  }
}

// Appends to the durable replay log (Redis list, or the in-memory job's
// events array) AND fans the event out live to anyone currently attached —
// across every worker, via bus.js.
async function emit(runId, event) {
  if (redis) {
    await redis.rpush(eKey(runId), JSON.stringify(event));
    await redis.expire(eKey(runId), JOB_TTL_SEC);
  } else {
    memJobs.get(runId)?.events.push(event);
  }
  bus.publish(chan(runId), event);
}

// Replays everything so far (covers a client connecting mid-run, or right
// after it finished) then subscribes for live delivery. Returns the
// unsubscribe handle so the route can tear it down on 'close'.
async function attachStream(runId, res) {
  if (redis) {
    const raw = await redis.lrange(eKey(runId), 0, -1);
    for (const item of raw) {
      try { res.write(`data: ${item}\n\n`); } catch { return null; }
    }
  } else {
    const job = memJobs.get(runId);
    if (job) {
      for (const event of job.events) {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { return null; }
      }
    }
  }
  const unsub = bus.subscribe(chan(runId), (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone, route's 'close' handler cleans up */ }
  });
  return unsub;
}

function detachStream(runId, unsub) {
  if (unsub) bus.unsubscribe(chan(runId), unsub);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Kicks off a bulk run and returns immediately with a runId — execution
 * continues in the background (on whichever worker received this request;
 * that no longer matters, since job state and events are shared via
 * Redis/bus.js). Connect to the SSE stream, from any worker, to watch it.
 *
 * devices: array of already-loaded, already-permission-checked device
 * objects (with decrypted _ssh_password/_ssh_key/_winrm_password — see
 * routes/actions.js's loadDevice) — this function does no further access
 * control itself, same division of responsibility as runbookRunner.js.
 */
function startRun({ command, devices, userId, username, orgId }) {
  const runId = uuidv4();

  // Fire-and-forget — the caller gets runId back immediately and connects
  // the SSE stream separately, same pattern as discovery scans. Job
  // creation happens first so a stream that attaches super early always
  // finds the job (even with status still "running", total already set).
  (async () => {
    await createJob(runId, { command, orgId, userId, username, total: devices.length });
    await emit(runId, { type: 'start', runId, total: devices.length, command });
    try {
      await runPool(runId, command, devices, { userId, username });
    } catch (e) {
      await emit(runId, { type: 'fatal', message: e.message });
    } finally {
      await finishJob(runId);
      await emit(runId, { type: 'done', runId });
    }
  })().catch(e => console.error('[BulkCommand] Run failed to start:', e.message));

  return runId;
}

async function runPool(runId, command, devices, { userId, username }) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, devices.length) }, () => worker());

  async function worker() {
    while (cursor < devices.length) {
      const device = devices[cursor++];
      await emit(runId, { type: 'device_start', deviceId: device.id, deviceName: device.name });

      let status = 'success', output = '';
      const startedAt = Date.now();
      try {
        const exec = device.os_type === 'linux' ? ssh.execCommand : winrm.execCommand;
        const result = await withTimeout(exec(device, command), PER_DEVICE_TIMEOUT_MS, `Command on ${device.name}`);
        output = (result?.stdout ?? '').slice(0, 8000);
      } catch (e) {
        status = 'failure';
        output = e.message;
      }
      const durationMs = Date.now() - startedAt;

      await emit(runId, { type: 'device_result', deviceId: device.id, deviceName: device.name, status, output, durationMs });

      await audit.log({
        userId, username, action: 'bulk_exec_command',
        targetType: 'device', targetId: device.id, targetName: device.name,
        result: status === 'success' ? 'success' : 'failure',
        details: `Bulk command run: CMD: ${command}`,
      }).catch(() => {});
    }
  }

  await Promise.all(workers);
}

module.exports = { startRun, attachStream, detachStream, getJob };