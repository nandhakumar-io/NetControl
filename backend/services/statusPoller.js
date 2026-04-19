// services/statusPoller.js
// Production-grade device status polling.
//
// KEY FIXES vs old version:
// 1. Agent last_seen is re-fetched FRESH per-device — never trusts the stale
//    batch-loaded value. Prevents a dead agent from holding "online" status.
// 2. Semaphore-controlled TCP probes — MAX_CONCURRENT sockets max, ever.
//    Safe for 1000+ devices without exhausting file descriptors.
// 3. Bulk DB updates — all status changes are flushed in 2 queries (online/offline)
//    not N individual UPDATEs. Scales to thousands.
// 4. Non-agent devices skip probing if probed recently (NON_AGENT_POLL_S).
//    This slashes unnecessary socket churn on stable fleets.
// 5. AGENT_GRACE_SEC = 45 (was 90). Agents post every 5s. 9 missed posts = dead.
// 6. TCP_TIMEOUT_MS = 2000 (was 3000). LAN devices respond in <200ms.

'use strict';

const net     = require('net');
const { query, execute, queryOne } = require('../db');

const POLL_INTERVAL_MS = 20 * 1000;  // base tick
const TCP_TIMEOUT_MS   = 2000;
const MAX_CONCURRENT   = 50;          // max simultaneous open sockets
const AGENT_GRACE_SEC  = 45;          // trust agent heartbeat for this long
const NON_AGENT_POLL_S = 60;          // TCP-probe non-agent devices at most this often

// Track last TCP probe time per device (in-memory, reset on restart)
const lastProbed = new Map();

const PROBE_PORTS = {
  linux:   [22, 80, 443, 8080, 3000],
  windows: [3389, 5985, 80, 443, 445],
  default: [22, 3389, 80, 443],
};

// ── Semaphore ─────────────────────────────────────────────────────────────────
class Semaphore {
  constructor(max) { this._max = max; this._cur = 0; this._q = []; }
  acquire() {
    return new Promise(r => {
      if (this._cur < this._max) { this._cur++; r(); }
      else this._q.push(r);
    });
  }
  release() {
    this._cur--;
    if (this._q.length && this._cur < this._max) { this._cur++; this._q.shift()(); }
  }
}
const sem = new Semaphore(MAX_CONCURRENT);

// ── TCP probe ─────────────────────────────────────────────────────────────────
function tcpProbe(host, port) {
  return new Promise(resolve => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(TCP_TIMEOUT_MS);
    s.on('connect', () => finish(true));
    s.on('timeout', () => finish(false));
    s.on('error',   () => finish(false));
    s.on('close',   () => finish(false));
    try { s.connect(port, host); } catch { finish(false); }
  });
}

// ── Probe device (race all ports, semaphore-gated) ────────────────────────────
async function isReachable(device) {
  const ports = PROBE_PORTS[device.os_type] || PROBE_PORTS.default;
  return new Promise(async resolve => {
    let remaining = ports.length;
    let found = false;
    const check = async (port) => {
      await sem.acquire();
      try {
        if (found) return;
        const up = await tcpProbe(device.ip_address, port);
        if (up && !found) { found = true; resolve(true); }
      } finally {
        sem.release();
        if (!found && --remaining === 0) resolve(false);
      }
    };
    ports.forEach(p => check(p));
  });
}

// ── Poll a single device ──────────────────────────────────────────────────────
async function pollDevice(device, nowSec) {
  // Agent path: re-fetch last_seen fresh to avoid trusting stale batch data
  if (device.agent_key_hash) {
    const fresh = await queryOne(
      'SELECT last_seen, status FROM devices WHERE id = ?',
      [device.id]
    ).catch(() => null);

    const lastSeen = fresh?.last_seen || 0;
    const ageSec   = nowSec - lastSeen;

    if (ageSec <= AGENT_GRACE_SEC) {
      // Agent is live — mark online if not already
      if (fresh.status !== 'online') {
        await execute(
          'UPDATE devices SET status = ?, last_seen = ? WHERE id = ?',
          ['online', nowSec, device.id]
        ).catch(() => {});
      }
      return { id: device.id, name: device.name, newStatus: 'online', oldStatus: device.status, method: 'agent' };
    }
    // Agent has gone silent — fall through to TCP probe
  }

  // Non-agent throttle: skip if probed recently
  if (!device.agent_key_hash) {
    const lp = lastProbed.get(device.id) || 0;
    if ((nowSec - lp) < NON_AGENT_POLL_S) {
      return { id: device.id, name: device.name, newStatus: device.status || 'unknown', oldStatus: device.status, method: 'skip' };
    }
  }

  lastProbed.set(device.id, nowSec);
  const up        = await isReachable(device);
  const newStatus = up ? 'online' : 'offline';
  return { id: device.id, name: device.name, newStatus, oldStatus: device.status, method: 'tcp' };
}

// ── Bulk flush status changes to DB ──────────────────────────────────────────
async function flushToDB(results, nowSec) {
  const toOnline  = [];
  const toOffline = [];

  for (const r of results) {
    if (r.method === 'skip') continue;
    if (r.newStatus === 'online')  toOnline.push(r.id);
    if (r.newStatus === 'offline') toOffline.push(r.id);
  }

  const tasks = [];

  if (toOnline.length) {
    const ph = toOnline.map(() => '?').join(',');
    tasks.push(execute(
      `UPDATE devices SET status = 'online', last_seen = ? WHERE id IN (${ph})`,
      [nowSec, ...toOnline]
    ).catch(e => console.error('[Poller] online flush:', e.message)));
  }

  if (toOffline.length) {
    const ph = toOffline.map(() => '?').join(',');
    tasks.push(execute(
      `UPDATE devices SET status = 'offline' WHERE id IN (${ph})`,
      toOffline
    ).catch(e => console.error('[Poller] offline flush:', e.message)));
  }

  await Promise.all(tasks);

  // Fire offline alerts for devices that just went offline
  for (const r of results) {
    if (r.oldStatus === 'online' && r.newStatus === 'offline') {
      try {
        const { evaluateOffline } = require('../routes/alerts');
        setImmediate(() => evaluateOffline(r.id, r.name).catch(() => {}));
      } catch {}
    }
  }
}

// ── Main poll cycle ───────────────────────────────────────────────────────────
async function pollAll() {
  const nowSec = Math.floor(Date.now() / 1000);
  const t0     = Date.now();

  let devices;
  try {
    devices = await query(
      'SELECT id, name, ip_address, os_type, status, last_seen, agent_key_hash FROM devices'
    );
  } catch (e) {
    console.error('[Poller] DB fetch error:', e.message);
    return;
  }

  if (!devices.length) return;

  // Run all device polls concurrently (semaphore limits socket usage)
  const settled = await Promise.allSettled(
    devices.map(d => pollDevice(d, nowSec))
  );

  const results = [];
  let errors    = 0;
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') results.push(settled[i].value);
    else { errors++; console.error(`[Poller] ${devices[i].name}:`, settled[i].reason?.message); }
  }

  await flushToDB(results, nowSec);

  // Stats log
  const counts = results.reduce((a, r) => {
    a[r.method]    = (a[r.method]    || 0) + 1;
    a[r.newStatus] = (a[r.newStatus] || 0) + 1;
    return a;
  }, {});

  const elapsed = Date.now() - t0;
  console.log(
    `[Poller] ${devices.length} devices | ` +
    `online:${counts.online||0} offline:${counts.offline||0} unknown:${counts.unknown||0} | ` +
    `agent:${counts.agent||0} tcp:${counts.tcp||0} skip:${counts.skip||0} err:${errors} | ${elapsed}ms`
  );
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
let _timer = null;

function start() {
  if (_timer) return;
  console.log(
    `[Poller] Starting — tick:${POLL_INTERVAL_MS/1000}s ` +
    `grace:${AGENT_GRACE_SEC}s maxSockets:${MAX_CONCURRENT} ` +
    `nonAgentInterval:${NON_AGENT_POLL_S}s`
  );
  pollAll().catch(console.error);
  _timer = setInterval(() => pollAll().catch(console.error), POLL_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, pollAll, pollDevice };

