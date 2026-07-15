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
// 7. Lapsed agent heartbeat -> TCP-probe fallback before offline. Agent
//    devices are typically outbound-only with no listening port most of
//    the time, so a plain TCP probe alone isn't a substitute for the
//    heartbeat — but a HOST that's genuinely reachable (SSH/RDP/WinRM open,
//    etc.) shouldn't show "offline" just because its agent crashed or lost
//    connectivity to the backend. Ping/TCP is checked first as the
//    fallback signal once the heartbeat has lapsed; last_seen itself is
//    never touched by this probe so the heartbeat clock stays honest (see
//    the comment in pollDevice()/flushToDB() for why that matters).

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
// `freshMap` is a Map<deviceId, {last_seen, status}> for ALL agent devices,
// built with ONE query per poll cycle in pollAll() — see the comment there
// for why. Falls back to a per-device query only if no map is supplied
// (keeps this function usable standalone, e.g. from tests).
async function pollDevice(device, nowSec, freshMap = null) {
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

  // Agent path: re-fetch last_seen fresh to avoid trusting stale batch data.
  //
  // SCALE FIX: this used to run `SELECT last_seen, status FROM devices
  // WHERE id = ?` as its OWN separate query, once PER agent device, every
  // single poll cycle (5s). At 800 agent devices that's 800 concurrent
  // individual round-trips fired at once via Promise.allSettled in
  // pollAll() — every 5 seconds, forever. Against a 100-connection pool
  // (queueLimit 500), a full boot/reconnect burst pushes 800 requests at
  // 100 available connections; the ~200 that don't fit under the queue
  // limit get rejected outright, not queued. Each rejection landed here as
  // `fresh === null` — and then `fresh.status` below threw a TypeError,
  // which Promise.allSettled turned into a silently-dropped rejected
  // result for that device: no status update that cycle at all. A device
  // stuck in that failure pattern (e.g. consistently one of the ~200 that
  // miss the pool on every cycle) would sit at whatever status it started
  // at — "unknown" forever for anything added after the pool started
  // filling up — even though it's actively reporting and perfectly
  // reachable. Fixed two ways: (1) one batched query for ALL agent devices
  // per cycle instead of N individual ones (see pollAll), so this hot path
  // no longer scales with fleet size at all; (2) a null `fresh` is now
  // handled explicitly instead of crashing, so a genuinely failed lookup
  // just skips this device for one cycle instead of raising.
  if (device.agent_key_hash) {
    const fresh = freshMap
      ? freshMap.get(device.id)
      : await queryOne('SELECT last_seen, status FROM devices WHERE id = ?', [device.id]).catch(() => null);

    if (!fresh) {
      // Couldn't get a fresh read this cycle (pool contention, transient
      // DB hiccup, or the device vanished mid-cycle) — leave status exactly
      // as it was rather than guessing. It'll be re-evaluated next cycle
      // 5s later; one skipped tick is invisible in practice, unlike a
      // crash that drops the device from status tracking entirely.
      return { id: device.id, name: device.name, newStatus: device.status || 'unknown', oldStatus: device.status, method: 'skip' };
    }

    const lastSeen = fresh.last_seen || 0;
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

    // Agent heartbeat has genuinely lapsed past grace. Before declaring the
    // device offline, fall back to a TCP reachability probe — the same
    // check non-agent devices get. This is the fix for "the PC is right
    // there on the network, agent just isn't reporting, but it shows
    // offline": a crashed agent service, a firewall rule that blocks
    // outbound-to-backend but not inbound probes, or an agent that's
    // simply not installed correctly yet all previously read as "offline"
    // even though the host answers on a probe port.
    //
    // IMPORTANT: unlike the non-agent TCP path below, this must NOT touch
    // last_seen — last_seen has to stay a pure record of "last real agent
    // heartbeat" or the exact feedback loop described in flushToDB's
    // comment comes back (a TCP-confirmed-but-agent-dead device would keep
    // last_seen artificially fresh forever, so it would always read as
    // "agent online" next cycle instead of "reachable but agent is down").
    // Status is allowed to reflect ping; the heartbeat clock is not.
    const lp = lastProbed.get(device.id) || 0;
    if ((nowSec - lp) >= NON_AGENT_POLL_S) {
      lastProbed.set(device.id, nowSec);
      const reachable = await isReachable(device);
      if (reachable) {
        return { id: device.id, name: device.name, newStatus: 'online', oldStatus: device.status, method: 'agent-ping-fallback' };
      }
    }

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
async function flushToDB(results, nowSec, devices) {
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
    // agent-ping-fallback (heartbeat lapsed, but a TCP probe found the host
    // reachable) is intentionally bucketed with pure agent confirmations —
    // both are status-only updates that leave last_seen as the untouched
    // heartbeat clock. See the comment in pollDevice() for why.
    if (r.newStatus === 'online' && (r.method === 'agent' || r.method === 'agent-ping-fallback')) toOnlineAgent.push(r.id);
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
  //
  // orgId is included here (from the `devices` fetch above, which now
  // selects org_id) so routes/metrics.js's SSE broadcast can filter this
  // event to only the browsers watching that device's org, instead of
  // fanning it out to every connected user regardless of tenant.
  const orgById = new Map(devices.map(d => [d.id, d.org_id]));
  for (const r of results) {
    if (r.method === 'skip' || r.oldStatus === r.newStatus) continue;
    bus.publish('device_status', { deviceId: r.id, status: r.newStatus, orgId: orgById.get(r.id) ?? null });
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

        // evaluateOffline above only ever fires once, right at the moment
        // of transition — fine for an immediate-notify rule, but a
        // duration-gated one (e.g. the "offline > 5 min" template,
        // min_duration_sec) needs additional chances to notice enough time
        // has passed while the device is still down. Re-check once a
        // minute, bailing out the moment it's back online (or after 30
        // checks / ~30 min, so a device that stays offline for days
        // doesn't leave a timer running indefinitely — the eventual
        // online transition is what actually clears the incident anyway).
        let checks = 0;
        const recheck = setInterval(async () => {
          checks++;
          if (checks > 30) { clearInterval(recheck); return; }
          try {
            const current = await queryOne('SELECT status FROM devices WHERE id = ?', [r.id]);
            if (!current || current.status !== 'offline') { clearInterval(recheck); return; }
            await evaluateOffline(r.id, r.name);
          } catch { clearInterval(recheck); }
        }, 60000);
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
      username: 'system', action: 'maintenance_expired', orgId: d.org_id,
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
      'SELECT id, name, ip_address, os_type, status, last_seen, agent_key_hash, org_id FROM devices'
    );
  } catch (e) {
    console.error('[Poller] DB fetch error:', e.message);
    return;
  }

  if (!devices.length) {
    await execute(
      `INSERT INTO poller_heartbeat (id, last_run_at, devices_polled, cycle_ms, pid)
       VALUES (1, ?, 0, ?, ?)
       ON DUPLICATE KEY UPDATE last_run_at = VALUES(last_run_at),
         devices_polled = 0, cycle_ms = VALUES(cycle_ms), pid = VALUES(pid)`,
      [nowSec, Date.now() - t0, process.pid]
    ).catch(() => {});
    return;
  }

  // ── Batched freshness fetch for agent devices ────────────────────────────
  // ONE query for every agent device this cycle instead of N individual
  // ones inside pollDevice() — see the long comment in pollDevice() for why
  // that mattered at 800-device scale. Non-agent devices don't need this at
  // all (they're TCP-probed, not DB-freshness-checked).
  const agentIds = devices.filter(d => d.agent_key_hash).map(d => d.id);
  let freshMap = new Map();
  if (agentIds.length) {
    try {
      const ph = agentIds.map(() => '?').join(',');
      const freshRows = await query(
        `SELECT id, last_seen, status FROM devices WHERE id IN (${ph})`,
        agentIds
      );
      freshMap = new Map(freshRows.map(r => [r.id, r]));
    } catch (e) {
      console.error('[Poller] agent freshness batch-fetch error:', e.message);
      // freshMap stays empty — pollDevice() treats a missing entry as
      // "couldn't confirm this cycle" and leaves status untouched rather
      // than guessing, so a single bad cycle degrades gracefully instead
      // of flipping every agent device to a wrong status at once.
    }
  }

  // Run all device polls concurrently (semaphore limits socket usage)
  const settled = await Promise.allSettled(
    devices.map(d => pollDevice(d, nowSec, freshMap))
  );

  const results = [];
  let errors    = 0;
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') results.push(settled[i].value);
    else { errors++; console.error(`[Poller] ${devices[i].name}:`, settled[i].reason?.message); }
  }

  await flushToDB(results, nowSec, devices);

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
    `agent:${counts.agent||0} ping-fallback:${counts['agent-ping-fallback']||0} tcp:${counts.tcp||0} skip:${counts.skip||0} err:${errors} | ${elapsed}ms`
  );

  // Heartbeat — see db/migrate-poller-heartbeat.js for why this exists.
  // Upsert rather than insert: this is a single always-current row, not a
  // history log (device_status_history already covers "what changed and
  // when" — this only ever answers "is the poller alive right now").
  await execute(
    `INSERT INTO poller_heartbeat (id, last_run_at, devices_polled, cycle_ms, pid)
     VALUES (1, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE last_run_at = VALUES(last_run_at),
       devices_polled = VALUES(devices_polled), cycle_ms = VALUES(cycle_ms), pid = VALUES(pid)`,
    [nowSec, devices.length, elapsed, process.pid]
  ).catch(e => console.error('[Poller] heartbeat write failed:', e.message));
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