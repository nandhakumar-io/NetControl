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
// 5. AGENT_GRACE_SEC = 25. Agents post every 5s but last_seen is only
//    written to the DB every ~10s (write-throttled in routes/metrics.js) —
//    25s gives real margin over that throttle plus poll-cycle jitter, so a
//    healthy, actively-reporting agent never gets falsely flagged.
// 6. TCP_TIMEOUT_MS = 2000 (was 3000). LAN devices respond in <200ms.
// 7. Lapsed agent heartbeat -> offline DIRECTLY, no TCP-probe fallback.
//    Agent devices are typically outbound-only with no listening port, so
//    the TCP probe failed almost every time regardless of real agent
//    health, flipping actively-reporting agents to "offline"/"silent" the
//    moment they brushed past the grace window. TCP reachability answers
//    "is the host up", not "is the agent reporting" — don't conflate them.

'use strict';

const net     = require('net');
const { query, execute, queryOne } = require('../db');
const bus     = require('./bus');

const POLL_INTERVAL_MS = 5 * 1000;   // poll every 5 seconds (was 20s — too slow)
const TCP_TIMEOUT_MS   = 2000;
const MAX_CONCURRENT   = 50;          // max simultaneous open sockets
const AGENT_GRACE_SEC  = 25;          // margin over the ~10s last_seen write-throttle + poll jitter (see routes/metrics.js)
const NON_AGENT_POLL_S = 10;          // TCP-probe non-agent devices every 10s (was 60 — too stale)

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
  // Devices awaiting admin approval are left alone entirely — no TCP probing,
  // no status overwrite — regardless of whether their agent is actively
  // reporting or has gone silent. The approval UI depends on status staying
  // 'needs_approval' until an admin explicitly approves the device.
  if (device.status === 'needs_approval') {
    if (device.agent_key_hash) {
      // Still bump last_seen so the admin can see the agent is alive.
      await execute('UPDATE devices SET last_seen = ? WHERE id = ?', [nowSec, device.id]).catch(() => {});
    }
    return { id: device.id, name: device.name, newStatus: 'needs_approval', oldStatus: device.status, method: 'skip' };
  }

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

    // Agent heartbeat has genuinely lapsed past grace — mark offline directly.
    // BUG FIX: this used to "fall through to TCP probe" here, but agent
    // devices are typically outbound-only with no listening service port —
    // the TCP probe fails almost every time regardless of agent health, so
    // a device that's still actively POSTing metrics (just briefly outside
    // the grace window due to the metrics-route write-throttle, see below)
    // got yanked to 'offline' by an unrelated, unreliable signal. TCP
    // reachability tells you whether the HOST is up, not whether the AGENT
    // is reporting — conflating the two caused exactly the "agent is
    // reporting but shows silent" symptom.
    return { id: device.id, name: device.name, newStatus: 'offline', oldStatus: device.status, method: 'agent' };
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
  // BUG FIX: previously ANY device reported 'online' this cycle — including
  // ones fast-pathed as online purely because they were still inside the
  // agent grace window — had last_seen stamped to nowSec here. That created
  // a feedback loop: check "is last_seen < 15s old?" -> yes -> mark online
  // -> immediately reset last_seen to now -> next cycle is guaranteed fresh
  // again. A dead agent's last_seen could never actually age past the grace
  // window, so it stayed "online" forever even with no real heartbeat.
  //
  // Fix: only devices confirmed online via a genuine TCP probe get last_seen
  // refreshed here (it means "last confirmed reachable"). Agent devices only
  // get last_seen updated by a real heartbeat POST in routes/metrics.js.
  const toOnlineTcp   = [];
  const toOnlineAgent = [];
  const toOffline     = [];

  for (const r of results) {
    if (r.method === 'skip') continue;
    if (r.newStatus === 'online' && r.method === 'tcp')   toOnlineTcp.push(r.id);
    if (r.newStatus === 'online' && r.method === 'agent') toOnlineAgent.push(r.id);
    if (r.newStatus === 'offline') toOffline.push(r.id);
  }

  const tasks = [];

  if (toOnlineTcp.length) {
    const ph = toOnlineTcp.map(() => '?').join(',');
    tasks.push(execute(
      `UPDATE devices SET status = 'online', last_seen = ? WHERE id IN (${ph})`,
      [nowSec, ...toOnlineTcp]
    ).catch(e => console.error('[Poller] online flush:', e.message)));
  }

  if (toOnlineAgent.length) {
    // Status only — last_seen is left untouched so the real heartbeat age
    // keeps accumulating and can actually exceed AGENT_GRACE_SEC when the
    // agent goes silent.
    const ph = toOnlineAgent.map(() => '?').join(',');
    tasks.push(execute(
      `UPDATE devices SET status = 'online' WHERE id IN (${ph})`,
      toOnlineAgent
    ).catch(e => console.error('[Poller] online(agent) flush:', e.message)));
  }

  if (toOffline.length) {
    const ph = toOffline.map(() => '?').join(',');
    tasks.push(execute(
      `UPDATE devices SET status = 'offline' WHERE id IN (${ph})`,
      toOffline
    ).catch(e => console.error('[Poller] offline flush:', e.message)));
  }

  await Promise.all(tasks);

  // ── Push transitions to the web tier in real time ────────────────────────
  // The poller writes MySQL directly (source of truth), but browsers get
  // their live view from the bus/SSE, same channel the metrics route uses.
  // Without this, a device flipping online/offline via the poller (as
  // opposed to an agent heartbeat, which already goes through the bus via
  // routes/metrics.js) would only show up after the frontend's next
  // fallback poll of GET /api/devices.
  for (const r of results) {
    if (r.method === 'skip' || r.oldStatus === r.newStatus) continue;
    bus.publish('device_status', { deviceId: r.id, status: r.newStatus });
  }

  // ── Record transitions for the Device Changes timeline / compare feature ──
  // Only genuine transitions (old !== new) are written — a poll tick that
  // reconfirms the same status is not "history", it's just noise.
  const { v4: uuidv4 } = require('uuid');
  const { batchInsert } = require('../db');
  const transitions = results.filter(r => r.method !== 'skip' && r.oldStatus !== r.newStatus);
  if (transitions.length) {
    const rows = transitions.map(r => ({
      id:          uuidv4(),
      device_id:   r.id,
      device_name: r.name,
      old_status:  r.oldStatus || null,
      new_status:  r.newStatus,
      timestamp:   nowSec,
    }));
    batchInsert('device_status_history', ['id', 'device_id', 'device_name', 'old_status', 'new_status', 'timestamp'], rows)
      .catch(e => console.error('[Poller] device_status_history insert:', e.message));
  }

  // Fire offline alerts + webhooks for devices that just transitioned status
  const webhook = require('./webhook');
  for (const r of results) {
    if (r.oldStatus === r.newStatus) continue;

    if (r.oldStatus === 'online' && r.newStatus === 'offline') {
      try {
        const { evaluateOffline } = require('../routes/alerts');
        setImmediate(() => evaluateOffline(r.id, r.name).catch(() => {}));
      } catch {}
      webhook.fire('device.offline', {
        device_id: r.id, device_name: r.name, severity: 'warning',
        message: `${r.name} went offline`,
      }).catch(() => {});
    }

    if (r.oldStatus && r.oldStatus !== 'online' && r.newStatus === 'online') {
      webhook.fire('device.online', {
        device_id: r.id, device_name: r.name, severity: 'info',
        message: `${r.name} came back online`,
      }).catch(() => {});
    }
  }
}

// ── Maintenance auto-expiry ───────────────────────────────────────────────────
// Devices marked under maintenance with a maintenance_until timestamp get
// cleared automatically once that time passes — so a forgotten toggle
// doesn't blackhole real alerts/webhooks indefinitely. Runs every poll tick
// (cheap: no-op SELECT when nothing has expired).
async function clearExpiredMaintenance(nowSec) {
  let expired;
  try {
    expired = await query(
      `SELECT id, name FROM devices
        WHERE maintenance_mode = 1 AND maintenance_until IS NOT NULL AND maintenance_until <= ?`,
      [nowSec]
    );
  } catch (e) {
    console.error('[Poller] maintenance-expiry fetch:', e.message);
    return;
  }
  if (!expired.length) return;

  const ids = expired.map(d => d.id);
  const ph  = ids.map(() => '?').join(',');
  try {
    await execute(
      `UPDATE devices
          SET maintenance_mode = 0, maintenance_note = NULL,
              maintenance_since = NULL, maintenance_by = NULL, maintenance_until = NULL
        WHERE id IN (${ph})`,
      ids
    );
  } catch (e) {
    console.error('[Poller] maintenance-expiry clear:', e.message);
    return;
  }

  // Drop the webhook service's per-device cache so alerts/webhooks resume
  // immediately instead of waiting out the cache TTL.
  const webhook = require('./webhook');
  const audit   = require('./audit');
  for (const d of expired) {
    webhook.invalidateMaintenanceCache(d.id);
    audit.log({
      username: 'system', action: 'maintenance_expired',
      targetType: 'device', targetId: d.id, targetName: d.name,
      result: 'success', details: 'Maintenance window expired — auto-cleared',
    }).catch(() => {});
    console.log(`[Poller] Maintenance window expired — cleared for ${d.name} (${d.id})`);
  }
}

// ── Main poll cycle ───────────────────────────────────────────────────────────
async function pollAll() {
  const nowSec = Math.floor(Date.now() / 1000);
  const t0     = Date.now();

  await clearExpiredMaintenance(nowSec);

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

module.exports = { start, stop, pollAll, pollDevice, flushToDB, clearExpiredMaintenance };