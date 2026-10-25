// services/sebQuit.js — orchestrates "quit SEB, confirm exit, then (optionally)
// shut the PC down" across one or many devices.
//
// Per-device state machine (seb_quit_items.state):
//
//   queued ──► no_connection          no live SEB connection matched this device
//          ├─► failed                 SEB Server auth/HTTP error or instruction rejected
//          └─► waiting_exit           SEB_QUIT instruction registered
//                 ├─► timeout         SEB never reported CLOSED/DISABLED in time
//                 ├─► cancelled       run cancelled while waiting
//                 └─► exited          SEB Server reports the connection closed
//                                     (+ optional endpoint process check agrees)
//                        └─► (if shutdown requested)
//                            shutdown_pending ─► shutdown_sent | shutdown_failed | cancelled | skipped
//   skipped                           rejected before the run started (maintenance, non-Windows, busy)
//
// HARD RULE: a shutdown is only ever sent from the `exited` state. Timeouts,
// failures, interrupted runs and cancellations NEVER power a machine off.
//
// "Endpoint confirms SEB exited" = SEB Server's own connection status flips to
// CLOSED/DISABLED (the SEB client reports its own disconnect), optionally
// cross-checked with a WinRM `tasklist` so a stale server-side status can't
// trigger a shutdown while the browser process is still alive.
'use strict';

const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db');
const seb = require('./sebServer');
const winrm = require('./winrm');
const audit = require('./audit');
const webhook = require('./webhook');
const { isUnderMaintenance, maintenanceBlockedReason } = require('./maintenance');

const NOW = Symbol('NOW');

function intEnv(name, def, min, max) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
}
const POLL_MS             = () => intEnv('SEB_POLL_INTERVAL_MS', 3000, 1000, 30000);
const DEFAULT_TIMEOUT_SEC = () => intEnv('SEB_QUIT_TIMEOUT_SEC', 120, 15, 900);
const MAX_TIMEOUT_SEC     = 900;
const SHUTDOWN_DELAY_SEC  = () => intEnv('SEB_SHUTDOWN_DELAY_SEC', 5, 0, 120);
const VERIFY_PROCESS      = () => (process.env.SEB_VERIFY_PROCESS ?? 'true').toLowerCase() !== 'false';
const PROCESS_FILTER      = () => (process.env.SEB_PROCESS_FILTER || 'SafeExamBrowser*').replace(/[^\w.*-]/g, '');
const INSTRUCT_CONCURRENCY = 8;
const STALE_HEARTBEAT_SEC = 120;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clip = (s, n = 480) => String(s ?? '').slice(0, n);

async function pool(list, limit, fn) {
  const queue = list.slice();
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// ── persistence helpers ──────────────────────────────────────────────────────
const ITEM_COLS = new Set(['state', 'details', 'seb_status', 'connection_token',
  'instruction_sent_at', 'exited_at', 'shutdown_at']);

async function setItem(item, fields) {
  const cols = Object.keys(fields).filter(c => ITEM_COLS.has(c));
  if (!cols.length) return;
  for (const c of cols) item[c] = fields[c] === NOW ? new Date() : fields[c];
  const sets = cols.map(c => (fields[c] === NOW ? `\`${c}\` = NOW()` : `\`${c}\` = ?`));
  const params = cols.filter(c => fields[c] !== NOW).map(c => (c === 'details' ? clip(fields[c]) : fields[c]));
  await execute(`UPDATE seb_quit_items SET ${sets.join(', ')} WHERE id = ?`, [...params, item.id]);
}

async function isCancelled(runId) {
  const r = await queryOne('SELECT status FROM seb_quit_runs WHERE id = ?', [runId]);
  return !r || r.status === 'cancelled';
}

async function heartbeat(runId) {
  await execute('UPDATE seb_quit_runs SET heartbeat_at = NOW() WHERE id = ? AND status = \'running\'', [runId]);
}

function auditItem(run, item, action, result, details) {
  return audit.log({
    userId: run.user.id, username: run.user.username, orgId: run.orgId,
    action, targetType: 'device', targetId: item.device.id, targetName: item.device.name,
    ipSource: run.ip, result, details: clip(`[exam ${run.examId}] ${details}`),
  }).catch(() => {});
}

// Final run status derived from what is actually stored — one implementation
// shared by normal completion and the stale-run sweeper.
async function finalizeRun(runId) {
  const run = await queryOne('SELECT status, shutdown_after FROM seb_quit_runs WHERE id = ?', [runId]);
  if (!run || run.status !== 'running') return; // cancelled/finished already
  const items = await query('SELECT state FROM seb_quit_items WHERE run_id = ?', [runId]);
  const okState = run.shutdown_after ? 'shutdown_sent' : 'exited';
  const ok = items.filter(i => i.state === okState).length;
  const status = ok === items.length && items.length ? 'completed' : ok === 0 ? 'failed' : 'partial';
  await execute('UPDATE seb_quit_runs SET status = ?, finished_at = NOW() WHERE id = ? AND status = \'running\'', [status, runId]);
}

// ── endpoint-side check ──────────────────────────────────────────────────────
// true  = SEB process still alive, false = gone, null = could not check
async function sebProcessRunning(device) {
  if (!VERIFY_PROCESS() || device.os_type !== 'windows') return null;
  try {
    const r = await winrm.execCommand(device, `tasklist /FI "IMAGENAME eq ${PROCESS_FILTER()}" /NH`);
    return /^\s*\S+\.exe\s+\d+/im.test(r.stdout || '');
  } catch {
    return null; // WinRM unavailable — rely on SEB Server's status alone
  }
}

// ── shutdown (only reachable from `exited`) ──────────────────────────────────
async function shutdownDevice(run, item) {
  try {
    const delay = SHUTDOWN_DELAY_SEC();
    await setItem(item, { state: 'shutdown_pending', details: `SEB exited — shutting down in ${delay}s` });
    if (delay) await sleep(delay * 1000);

    if (await isCancelled(run.id)) {
      await setItem(item, { state: 'cancelled', details: 'Run cancelled before shutdown was sent (SEB had already exited)' });
      await auditItem(run, item, 'seb_quit_shutdown', 'partial', 'cancelled before shutdown');
      return;
    }

    // Re-read the device at the last moment: maintenance mode may have been
    // switched on while we were waiting for SEB to exit.
    const fresh = await queryOne('SELECT * FROM devices WHERE id = ?', [item.device.id]);
    if (!fresh) throw new Error('Device no longer exists');
    if (isUnderMaintenance(fresh)) {
      const why = maintenanceBlockedReason(fresh);
      await setItem(item, { state: 'skipped', details: `SEB exited, shutdown not sent: ${why}` });
      await auditItem(run, item, 'seb_quit_shutdown', 'partial', why);
      return;
    }

    const { performAction } = require('../routes/actions'); // lazy: avoids a load-time cycle
    const msg = await performAction('shutdown', fresh);
    await setItem(item, { state: 'shutdown_sent', shutdown_at: NOW, details: `SEB exited; ${msg}` });
    await auditItem(run, item, 'seb_quit_shutdown', 'success', `SEB exited, ${msg}`);
    webhook.fire('device.shutdown', {
      device_id: item.device.id, device_name: item.device.name,
      performed_by: run.user.username, severity: 'info',
      message: `shutdown sent to ${item.device.name} after SEB exit (exam ${run.examId}) by ${run.user.username}`,
    }).catch(() => {});
  } catch (e) {
    await setItem(item, { state: 'shutdown_failed', details: `SEB exited, but shutdown failed: ${e.message}` }).catch(() => {});
    await auditItem(run, item, 'seb_quit_shutdown', 'failure', e.message);
  }
}

// ── the run ──────────────────────────────────────────────────────────────────
async function orchestrate(run) {
  const items = run.items.filter(i => i.state === 'queued');
  try {
    if (!items.length) return;

    // 1) One monitoring fetch resolves every device in scope.
    let connections;
    try {
      connections = await seb.getMonitoring(run.examId);
    } catch (e) {
      for (const item of items) {
        await setItem(item, { state: 'failed', details: e.message });
        await auditItem(run, item, 'seb_quit', 'failure', e.message);
      }
      return;
    }

    const claimed = new Set();
    const toInstruct = [];
    for (const item of items) {
      const { con, by } = seb.matchConnectionDetailed(item.device, connections);
      if (!con) {
        const d = by === 'binding_miss'
          ? `No SEB connection in exam ${run.examId} carries this device's bound identifier "${item.device.seb_match_key}" — re-bind it or clear the binding`
          : `No SEB connection found for this device in exam ${run.examId} (matched on IP / hostname)`;
        await setItem(item, { state: 'no_connection', details: d });
        await auditItem(run, item, 'seb_quit', 'partial', d);
        continue;
      }
      if (seb.isTerminal(con.status)) {
        const d = `SEB connection is already ${con.status} — nothing to quit, no shutdown sent`;
        await setItem(item, { state: 'no_connection', seb_status: con.status, details: d });
        await auditItem(run, item, 'seb_quit', 'partial', d);
        continue;
      }
      if (claimed.has(con.token)) {
        const d = 'Same SEB connection matched another device in this run (shared IP?) — skipped to avoid quitting the wrong client';
        await setItem(item, { state: 'failed', details: d });
        await auditItem(run, item, 'seb_quit', 'failure', d);
        continue;
      }
      claimed.add(con.token);
      item.connection_token = con.token;
      item.seb_status = con.status;
      toInstruct.push(item);
    }

    // 2) Register SEB_QUIT (bounded concurrency).
    await pool(toInstruct, INSTRUCT_CONCURRENCY, async (item) => {
      try {
        await seb.registerQuit(run.examId, item.connection_token);
        await setItem(item, {
          state: 'waiting_exit', connection_token: item.connection_token, seb_status: item.seb_status,
          instruction_sent_at: NOW, details: 'SEB_QUIT instruction registered — waiting for SEB to exit (typically 5–15s)',
        });
      } catch (e) {
        await setItem(item, { state: 'failed', details: `Could not register SEB_QUIT: ${e.message}` });
        await auditItem(run, item, 'seb_quit', 'failure', e.message);
      }
    });

    // 3) Track outcome until every device exits, or the deadline passes.
    const deadline = Date.now() + run.timeoutSec * 1000;
    const shutdowns = [];
    for (;;) {
      const waiting = items.filter(i => i.state === 'waiting_exit');
      if (!waiting.length) break;

      if (await isCancelled(run.id)) {
        for (const item of waiting) {
          await setItem(item, { state: 'cancelled', details: 'Run cancelled — the SEB_QUIT instruction was already sent and cannot be recalled; no shutdown sent' });
          await auditItem(run, item, 'seb_quit', 'partial', 'run cancelled while waiting');
        }
        break;
      }
      if (Date.now() >= deadline) {
        for (const item of waiting) {
          const d = `SEB did not report exit within ${run.timeoutSec}s (last status ${item.seb_status || 'unknown'}) — no shutdown sent`;
          await setItem(item, { state: 'timeout', details: d });
          await auditItem(run, item, 'seb_quit', 'failure', d);
        }
        break;
      }

      await sleep(POLL_MS());
      await heartbeat(run.id);

      let cons;
      try { cons = await seb.getMonitoring(run.examId); }
      catch { continue; } // transient SEB Server hiccup — keep waiting until the deadline

      for (const item of waiting) {
        let con = cons.find(c => c.token === item.connection_token);
        if (!con) {
          try { con = await seb.getConnection(run.examId, item.connection_token); } catch { /* keep waiting */ }
        }
        if (!con) continue;
        if (con.status !== item.seb_status) await setItem(item, { seb_status: con.status });
        if (!seb.isTerminal(con.status)) continue;

        const alive = await sebProcessRunning(item.device);
        if (alive === true) {
          await setItem(item, { details: `SEB Server reports ${con.status}, but the SEB process is still running on the endpoint — waiting` });
          continue;
        }
        const verified = alive === false ? 'confirmed by SEB Server and endpoint process check' : 'confirmed by SEB Server';
        await setItem(item, { state: 'exited', exited_at: NOW, seb_status: con.status, details: `SEB exited (${verified})` });
        await auditItem(run, item, 'seb_quit', 'success', `SEB exited (${verified})`);
        if (run.shutdownAfter) shutdowns.push(shutdownDevice(run, item));
      }
    }
    await Promise.all(shutdowns);
  } catch (e) {
    console.error(`[SebQuit] run ${run.id} crashed:`, e);
    for (const item of items) {
      if (['queued', 'waiting_exit'].includes(item.state)) {
        await setItem(item, { state: 'failed', details: `Internal error: ${e.message}` }).catch(() => {});
      }
    }
  } finally {
    await finalizeRun(run.id).catch(err => console.error('[SebQuit] finalize failed:', err.message));
  }
}

/**
 * Creates the run + item rows and starts orchestration in the background.
 *   devices: raw device rows (already org/group/access checked by the route)
 *   skipped: [{ device, reason }] rejected up front — recorded so the UI shows why
 */
async function startRun({ orgId, user, ip, examId, scopeType, scopeId, scopeName, shutdownAfter, timeoutSec, devices, skipped = [] }) {
  const runId = uuidv4();
  const timeout = Math.min(Math.max(parseInt(timeoutSec, 10) || DEFAULT_TIMEOUT_SEC(), 15), MAX_TIMEOUT_SEC);

  await execute(
    `INSERT INTO seb_quit_runs
       (id, org_id, exam_id, scope_type, scope_id, scope_name, shutdown_after, timeout_sec,
        status, created_by, created_by_username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    [runId, orgId, examId, scopeType, scopeId || null, clip(scopeName, 255), shutdownAfter ? 1 : 0, timeout, user.id, user.username]
  );

  const run = { id: runId, orgId, user, ip, examId, shutdownAfter: !!shutdownAfter, timeoutSec: timeout, items: [] };

  const mk = (device, state, details) => ({
    id: uuidv4(), device, state, details: details || null,
    connection_token: null, seb_status: null,
  });
  for (const device of devices) run.items.push(mk(device, 'queued', 'Queued'));
  for (const s of skipped) run.items.push(mk(s.device, 'skipped', s.reason));

  for (const item of run.items) {
    await execute(
      `INSERT INTO seb_quit_items (id, run_id, device_id, device_name, ip_address, state, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [item.id, runId, item.device.id, item.device.name, item.device.ip_address, item.state, clip(item.details)]
    );
  }
  for (const item of run.items.filter(i => i.state === 'skipped')) {
    auditItem(run, item, 'seb_quit', 'partial', item.details);
  }

  setImmediate(() => { orchestrate(run).catch(e => console.error('[SebQuit] orchestrate:', e)); });
  return { runId, timeoutSec: timeout };
}

async function cancelRun(runId, orgId) {
  const r = await execute(
    'UPDATE seb_quit_runs SET status = \'cancelled\', finished_at = NOW() WHERE id = ? AND org_id = ? AND status = \'running\'',
    [runId, orgId]
  );
  if (r.affectedRows > 0) {
    await execute(
      `UPDATE seb_quit_items 
         SET state = 'cancelled', 
             details = CASE 
               WHEN state = 'waiting_exit' THEN 'Run cancelled — SEB_QUIT instruction was sent, but PC shutdown is blocked'
               WHEN state = 'shutdown_pending' THEN 'Run cancelled — PC shutdown blocked'
               ELSE 'Run cancelled'
             END
       WHERE run_id = ? AND state IN ('queued', 'waiting_exit', 'shutdown_pending')`,
      [runId]
    );
    return true;
  }
  return false;
}

async function getRun(runId, orgId) {
  const run = await queryOne('SELECT * FROM seb_quit_runs WHERE id = ? AND org_id = ?', [runId, orgId]);
  if (!run) return null;
  // connection_token is intentionally not returned to the browser.
  const items = await query(
    `SELECT id, device_id, device_name, ip_address, state, seb_status, details,
            instruction_sent_at, exited_at, shutdown_at, updated_at
       FROM seb_quit_items WHERE run_id = ? ORDER BY device_name`,
    [runId]
  );
  return { ...run, items };
}

async function listRuns(orgId, limit = 20) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  return query(
    `SELECT r.id, r.exam_id, r.scope_type, r.scope_name, r.shutdown_after, r.status,
            r.created_by_username, r.created_at, r.finished_at,
            (SELECT COUNT(*) FROM seb_quit_items i WHERE i.run_id = r.id) AS device_count
       FROM seb_quit_runs r WHERE r.org_id = ? ORDER BY r.created_at DESC LIMIT ${safeLimit}`,
    [orgId]
  );
}

// Devices that already have a quit in flight (blocks double-submits).
async function devicesInFlight(deviceIds) {
  if (!deviceIds.length) return new Set();
  const rows = await query(
    `SELECT DISTINCT i.device_id FROM seb_quit_items i
       JOIN seb_quit_runs r ON r.id = i.run_id
      WHERE r.status = 'running' AND i.state IN ('queued','waiting_exit','exited','shutdown_pending')
        AND i.device_id IN (${deviceIds.map(() => '?').join(',')})`,
    deviceIds
  );
  return new Set(rows.map(r => r.device_id));
}

// Runs whose worker died (no heartbeat) must not stay "running" forever, and
// their half-finished devices must never be left looking like a pending shutdown.
// Called by poller.js. NEVER sends a shutdown.
async function sweepStale() {
  const stale = await query(
    `SELECT id, shutdown_after FROM seb_quit_runs
      WHERE status = 'running' AND heartbeat_at < (NOW() - INTERVAL ${STALE_HEARTBEAT_SEC} SECOND)`
  );
  for (const r of stale) {
    await execute(
      `UPDATE seb_quit_items SET state = 'failed',
              details = 'Run interrupted (server restarted) — SEB state unknown; no shutdown was sent'
        WHERE run_id = ? AND (state IN ('queued','waiting_exit','shutdown_pending')
              OR (state = 'exited' AND ? = 1))`,
      [r.id, r.shutdown_after ? 1 : 0]
    );
    await finalizeRun(r.id);
  }
  return stale.length;
}

let _sweepTimer = null;
function startSweeper() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => { sweepStale().catch(e => console.error('[SebQuit] sweep:', e.message)); }, 60 * 1000);
  _sweepTimer.unref?.();
  sweepStale().catch(() => {});
}
function stopSweeper() { if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; } }

module.exports = {
  startRun, cancelRun, getRun, listRuns, devicesInFlight, sweepStale, startSweeper, stopSweeper,
  DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC, SHUTDOWN_DELAY_SEC,
};