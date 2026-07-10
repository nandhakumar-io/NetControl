// routes/metrics.js — Live system metrics ingestion + SSE streaming
// FIXED: Agent registration now properly checks for IP+MAC duplicates,
// returns device status indicating if it's new or existing, and handles
// metric-only updates without duplication
'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute: run } = require('../db');
const { requireAuth }          = require('../middleware/auth');
const { requireOrgContext }    = require('../middleware/tenant');
const { agentIngestLimiter, registerLimiter, sseStreamLimiter } = require('../middleware/rateLimiter');
const { evaluateAlerts, pushNotification } = require('./alerts');
const webhook = require('../services/webhook');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();
const bus = require('../services/bus');

const router = express.Router();

// ── In-memory metrics store ────────────────────────────────────────────────────
// NOTE: this is a per-worker MIRROR, not the source of truth. Every worker
// subscribes to the 'metrics' bus channel below and applies every snapshot
// locally — including ones that arrived on a *different* worker via a
// different agent POST. That's what makes GET /api/metrics and the SSE
// stream consistent no matter which clustered worker a request lands on.
const HISTORY_LEN = 300; // ~25 min at 5s intervals
const store = new Map();

function applySnapshot(deviceId, snapshot) {
  if (!store.has(deviceId)) store.set(deviceId, { latest: null, history: [] });
  const entry = store.get(deviceId);
  entry.latest = snapshot;
  entry.history.push(snapshot);
  if (entry.history.length > HISTORY_LEN) entry.history.shift();
}

// ── device_id -> org_id cache ──────────────────────────────────────────────────
// BUG THIS FIXES: this whole file predates multi-tenancy and never filtered
// anything by org. The in-memory `store`, the SSE broadcast fan-out, and the
// GET routes below all treated every device as globally visible — so once a
// device's org_id was fixed (see the agent-registration fix), its *metrics*
// still leaked to every org's dashboard/monitoring page, live and historical
// alike, because nothing here ever checked org_id at all (worse: the
// `role !== 'admin'` checks meant instance-admins — who routinely manage
// several client orgs — saw literally everyone's metrics unconditionally).
//
// This cache lets the hot ingest/broadcast path (agent posts every ~5s)
// avoid a DB round trip per snapshot: agent ingest already has org_id from
// agentAuth and primes the cache directly; anything else (poller-driven
// device_status events, SSE connect) falls back to a lazy DB lookup that's
// cached from then on. A cache entry of `null` still counts as "resolved"
// (e.g. a device that got deleted mid-flight) so we don't hammer the DB for
// it on every subsequent broadcast.
const deviceOrgCache = new Map();

function primeDeviceOrg(deviceId, orgId) {
  deviceOrgCache.set(deviceId, orgId ?? null);
}

async function getDeviceOrgId(deviceId) {
  if (deviceOrgCache.has(deviceId)) return deviceOrgCache.get(deviceId);
  const row = await queryOne('SELECT org_id FROM devices WHERE id = ?', [deviceId]);
  const orgId = row ? (row.org_id ?? null) : null;
  deviceOrgCache.set(deviceId, orgId);
  return orgId;
}

// ── SSE client registry (local to this worker only) ───────────────────────────
// userId → Set<res>  — only send data the user is allowed to see.
// Each `res` also carries `res._orgId` (the org that was active when the
// browser connected) so broadcasts below can filter by it — see
// sseBroadcastLocal/sseBroadcastDeviceStatus.
const sseClients = new Map();

function sseAdd(userId, orgId, res) {
  res._orgId = orgId;
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);
}
function sseDel(userId, res) {
  sseClients.get(userId)?.delete(res);
}
async function sseBroadcastLocal(deviceId, snapshot, knownOrgId = undefined) {
  // Fan out to browsers connected to THIS worker. Cross-worker fan-out is
  // handled by the bus subscription below, which calls this same function
  // on every worker once a snapshot is published.
  const orgId = knownOrgId !== undefined ? knownOrgId : await getDeviceOrgId(deviceId);
  if (orgId === null) return; // unknown/orphan device — fail closed, broadcast to nobody
  const payload = JSON.stringify({ deviceId, latest: snapshot });
  for (const [, clients] of sseClients) {
    for (const res of clients) {
      if (res._orgId !== orgId) continue;
      try { res.write(`data: ${payload}\n\n`); } catch {}
    }
  }
}

// ── Cross-worker sync ──────────────────────────────────────────────────────────
// Single subscription point: whether a snapshot originated on this worker or
// another one, it flows through here so local store + local SSE clients stay
// in sync everywhere.
bus.subscribe('metrics', ({ deviceId, snapshot, orgId }) => {
  applySnapshot(deviceId, snapshot);
  if (orgId !== undefined) primeDeviceOrg(deviceId, orgId);
  sseBroadcastLocal(deviceId, snapshot, orgId).catch(() => {});
}, { skipSelf: true });

// Device status transitions (from the poller's TCP probes, or agent
// heartbeats coming back online) — pushed as a distinct message `type` so
// the frontend can tell it apart from a metrics snapshot and patch its
// devices list instead of its metrics map.
async function sseBroadcastDeviceStatus(deviceId, status, knownOrgId = undefined) {
  const orgId = knownOrgId !== undefined ? knownOrgId : await getDeviceOrgId(deviceId);
  if (orgId === null) return; // unknown/orphan device — fail closed
  const payload = JSON.stringify({ type: 'device_status', deviceId, status });
  for (const [, clients] of sseClients) {
    for (const res of clients) {
      if (res._orgId !== orgId) continue;
      try { res.write(`data: ${payload}\n\n`); } catch {}
    }
  }
}
bus.subscribe('device_status', ({ deviceId, status, orgId }) => {
  sseBroadcastDeviceStatus(deviceId, status, orgId).catch(() => {});
}, { skipSelf: true });

// ── Helpers ────────────────────────────────────────────────────────────────────
function genApiKey() { return 'nca_' + crypto.randomBytes(24).toString('hex'); }
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

// SSE accepts token from Authorization header OR ?token= query param.
// Made async (was sync) because — unlike a normal request going through
// requireAuth — the JWT payload itself doesn't carry active_org_id (it's
// only ever resolved live from the DB; see middleware/auth.js). Without this
// live lookup the SSE stream had no org context at all to filter by, which
// is half of why metrics leaked across orgs in the first place.
async function extractUser(req) {
  let token = null;
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) {
    const url = new URL(req.url, 'http://localhost');
    token = url.searchParams.get('token');
  }
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const liveUser = await queryOne('SELECT id, role, enabled, active_org_id FROM users WHERE id = ?', [payload.id]);
    if (!liveUser || !liveUser.enabled) return null;
    return { ...payload, role: liveUser.role, activeOrgId: liveUser.active_org_id || null };
  } catch { return null; }
}

// ── Agent auth ─────────────────────────────────────────────────────────────────
async function agentAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['x-metrics-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-api-key header' });
  const keyHash = hashKey(key);
  try {
    const row = await queryOne(
      'SELECT id, name, ip_address, status, org_id FROM devices WHERE agent_key_hash = ?',
      [keyHash]
    );
    if (!row) return res.status(403).json({ error: 'Invalid API key' });
    req.agentDevice = row;
    primeDeviceOrg(row.id, row.org_id); // hot path: avoid a lookup on every ingest
    next();
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
}

// ── GET /api/metrics/stream — SSE push stream ─────────────────────────────────
// Browser connects once; server pushes every agent update in real time.
// On connect: immediately sends the full current snapshot so graphs appear
// without waiting for the next agent push.
//
// Org-filtered on both ends: the initial snapshot only includes devices
// belonging to the connecting user's active org, and the res object is
// tagged with that org so every subsequent live push (sseBroadcastLocal /
// sseBroadcastDeviceStatus) skips it if a snapshot arrives for a different
// org. If the user switches orgs client-side, the existing "switch org"
// flow already forces a full page reload (see OrganizationsPage.jsx), which
// reconnects this stream under the new org — so no separate re-tag path is
// needed here.
router.get('/stream', sseStreamLimiter, async (req, res) => {
  const user = await extractUser(req);
  if (!user) { res.status(401).end(); return; }
  if (!user.activeOrgId) { res.status(400).end(); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseAdd(user.id, user.activeOrgId, res);

  // Send full current snapshot immediately so graphs show on connect —
  // filtered to devices in this user's active org.
  const snapshot = {};
  for (const [id, entry] of store.entries()) {
    const orgId = await getDeviceOrgId(id);
    if (orgId === user.activeOrgId) snapshot[id] = { latest: entry.latest, history: entry.history };
  }
  try { res.write(`data: ${JSON.stringify({ type: 'snapshot', data: snapshot })}\n\n`); } catch {}

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    sseDel(user.id, res);
  });
});

// ── POST /api/metrics/register ─────────────────────────────────────────────────
// FIXED: Proper device deduplication logic:
//   1. First try to find by MAC address (most reliable identifier)
//   2. If MAC exists, update the device (same device, possibly new IP)
//   3. If MAC doesn't exist, try IP+hostname combo (legacy behavior)
//   4. If nothing found, create new device
//
// Returns:
//   {
//     device_id: uuid,
//     device_name: hostname,
//     api_key: string,
//     registered: boolean,  // true if NEW device, false if existing
//     action: 'created' | 'updated',  // 'created' for new, 'updated' for existing
//     status: 'needs_approval' | 'approved'  // Frontend uses this for modal
//   }
//
// SECURITY: Registration requires AGENT_REGISTRATION_SECRET in x-registration-secret header
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

router.post('/register', registerLimiter, async (req, res) => {
  // ── Resolve which org this agent belongs to ────────────────────────────
  // Preferred: a per-org enrollment token (see db/migrate-agent-enrollment.js
  // + routes/orgs.js GET/POST .../enrollment-token). Each org has its own
  // token, so the org_id below comes from *which token was used*, not from
  // anything the agent can just claim in its request body.
  //
  // Legacy fallback: the old single global AGENT_REGISTRATION_SECRET.
  // BUG THIS SECTION FIXES: this used to be the *only* path, and it never
  // resolved an org_id at all — new agent devices were inserted with
  // org_id = NULL. Every other device route filters `WHERE org_id = ?`,
  // so those devices were invisible on the Devices page (including the
  // approval queue) even though their metrics kept flowing in fine, since
  // POST /api/metrics (ingest) authenticates by agent_key_hash with no org
  // filter at all. The legacy path only makes sense for a single-org
  // install, so it's only honored when exactly one organization exists.
  const enrollmentToken = req.headers['x-enrollment-token'];
  const legacySecret = req.headers['x-registration-secret'];
  let orgId = null;

  if (enrollmentToken) {
    const org = await queryOne('SELECT id FROM organizations WHERE agent_enrollment_token = ?', [enrollmentToken]);
    if (!org) return res.status(401).json({ error: 'Invalid enrollment token' });
    orgId = org.id;
  } else if (legacySecret) {
    const regSecret = process.env.AGENT_REGISTRATION_SECRET;
    if (!regSecret) {
      return res.status(500).json({ error: 'Agent registration is not configured on the server' });
    }
    if (!timingSafeEqualStr(legacySecret, regSecret)) {
      return res.status(401).json({ error: 'Invalid or missing registration secret' });
    }
    const orgs = await query('SELECT id FROM organizations LIMIT 2');
    if (orgs.length !== 1) {
      return res.status(400).json({
        error: 'This install has multiple organizations — register with a per-org x-enrollment-token instead of the legacy shared secret so the agent lands in the right one.',
      });
    }
    orgId = orgs[0].id;
  } else {
    return res.status(401).json({ error: 'Missing x-enrollment-token (or legacy x-registration-secret) header' });
  }

  const { hostname, ip, mac, os_type, os_version, arch } = req.body;
  if (!hostname || !ip) return res.status(400).json({ error: 'hostname and ip are required' });

  const osType = (os_type || '').toLowerCase().includes('win') ? 'windows' : 'linux';
  const macNorm = (mac || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase().slice(0, 12);
  const macFormatted = macNorm.match(/.{1,2}/g)?.join(':') || '00:00:00:00:00:00';

  try {
    const apiKey  = genApiKey();
    const keyHash = hashKey(apiKey);
    const now     = Math.floor(Date.now() / 1000);

    // FIXED: Proper deduplication logic
    // Strategy: MAC is the most reliable identifier
    // 1. If MAC provided and exists in DB (within this org) → same device (update it)
    // 2. If MAC doesn't exist but IP+hostname match (within this org) → legacy match (update)
    // 3. Otherwise → new device (create)
    //
    // Both lookups are scoped to `org_id = ?` — without that, an agent
    // re-registering with a different org's token than it originally used
    // could match another tenant's device by coincidence (private IP
    // ranges and generic hostnames like "DESKTOP-1" collide across
    // separate clients constantly) and silently reassign it. Dedup must
    // never cross a tenant boundary.

    let device = null;
    let action = null;

    // Try to find by MAC first (most reliable)
    if (macNorm && macNorm !== '000000000000') {
      device = await queryOne(
        'SELECT id, name, ip_address, mac_address, status FROM devices WHERE mac_address = ? AND org_id = ?',
        [macFormatted, orgId]
      );
      if (device) {
        action = 'updated';
      }
    }

    // If not found by MAC, try IP+hostname (legacy behavior).
    // BUG FIX: this used to match on `name`, the user-editable display name
    // set via PUT /api/devices/:id — so renaming a device in the UI
    // permanently broke this fallback (the agent always sends its raw OS
    // hostname, which no longer matches the renamed `name`). Match on the
    // persistent `hostname` column instead, which is only ever set here at
    // registration time and never touched by the rename endpoint.
    if (!device) {
      device = await queryOne(
        'SELECT id, name, ip_address, mac_address, status FROM devices WHERE ip_address = ? AND hostname = ? AND org_id = ?',
        [ip, hostname, orgId]
      );
      if (device) {
        action = 'updated';
      }
    }

    // If device already exists, just update the key and return
    if (device) {
      // Update agent key, OS info, and last seen timestamp.
      // NOTE: hostname is intentionally NOT overwritten here beyond keeping
      // it in sync with what the agent reports — `name` (display name) is
      // left alone so admin renames survive re-registration.
      await run(
        `UPDATE devices SET ip_address=?, mac_address=?, hostname=?, agent_key_hash=?, 
         agent_registered_at=?, os_version=?, arch=?, last_seen=? WHERE id=? AND org_id=?`,
        [ip, macFormatted, hostname, keyHash, now, os_version || null, arch || null, now, device.id, orgId]
      );

      console.log(`[Agent] Updated existing device: ${device.name} (${device.id})`);

      return res.json({
        device_id: device.id,
        device_name: device.name,
        api_key: apiKey,
        registered: false,  // Not a new registration
        action: 'updated',
        status: 'approved'  // Existing devices are already approved
      });
    }

    // NEW DEVICE: Create with "needs_approval" status
    // The frontend should show a modal prompting the user to review and approve
    const id = uuidv4();
    const approvalStatus = 'needs_approval';  // Not auto-approved anymore

    await run(
      `INSERT INTO devices
         (id, name, hostname, ip_address, mac_address, os_type, os_version, arch,
          agent_key_hash, agent_registered_at, status, last_seen, created_at, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, hostname, hostname, ip, macFormatted, osType, os_version || null,
       arch || null, keyHash, now, approvalStatus, now, now, orgId]
    );

    console.log(`[Agent] Registered new device: ${hostname} (${id}) → org ${orgId}`);

    require('../services/webhook').fire('system.agent_registered', {
      device_id: id, device_name: hostname, ip, severity: 'info',
      message: `New agent registered: ${hostname} (${ip}) — awaiting approval`,
    }).catch(() => {});

    return res.status(201).json({
      device_id: id,
      device_name: hostname,
      api_key: apiKey,
      registered: true,  // This IS a new registration
      action: 'created',
      status: 'needs_approval'  // Frontend shows modal for approval
    });

  } catch (e) {
    console.error('[metrics/register]', e.message);
    res.status(500).json({ error: 'Registration failed: ' + e.message });
  }
});

// ── POST /api/metrics (agent ingest) ──────────────────────────────────────────
// Tracks the last time we actually wrote last_seen/status to the DB per
// device — deliberately NOT stored on the snapshot object. Storing it there
// (as `_dbUpdatedAt`) meant it got re-stamped to `now` on every single
// request whether or not a write happened, so the very next request's
// "(now - prev._dbUpdatedAt) >= 10" check always read a ~5s-old value (the
// agent's own post interval) and was permanently false after the first ever
// write. Net effect: the DB got updated exactly once — right after a
// process restart when `store` was empty — and never again, while the
// in-memory store kept accumulating fine. last_seen froze, the poller
// correctly (from its point of view) aged it past the grace window and
// marked it offline forever, and the frontend's `live` check (which gates
// on device.status==='online') kept showing "offline / no metrics" even
// though fresh data was arriving the whole time.
const lastDbWrite = new Map();

router.post('/', agentIngestLimiter, agentAuth, async (req, res) => {
  const device = req.agentDevice;
  const { cpu, ram, disk, network, uptime, os, hostname, processes } = req.body;

  const now = Math.floor(Date.now() / 1000);

  if ((now - (lastDbWrite.get(device.id) || 0)) >= 10 && device.status !== 'needs_approval') {
    lastDbWrite.set(device.id, now);
    run('UPDATE devices SET status=?, last_seen=? WHERE id=?', ['online', now, device.id])
      .catch(() => {});
    if (device.status && device.status !== 'online') {
      sseBroadcastDeviceStatus(device.id, 'online', device.org_id).catch(() => {});
      bus.publish('device_status', { deviceId: device.id, status: 'online', orgId: device.org_id });
      require('../services/webhook').fire('device.online', {
        device_id: device.id, device_name: device.name, severity: 'info',
        message: `${device.name} came back online`,
      }).catch(() => {});
    }
  } else if (device.status === 'needs_approval') {
    // Still keep last_seen fresh so the admin can see the agent is alive
    // and reporting, without flipping status away from needs_approval.
    run('UPDATE devices SET last_seen=? WHERE id=?', [now, device.id]).catch(() => {});
  }

  const snapshot = {
    ts:           now,
    cpu:          typeof cpu === 'number' ? Math.round(cpu * 10) / 10 : null,
    ram:          ram?.used != null && ram?.total != null ? ram : null,
    disk:         Array.isArray(disk) ? disk : null,
    network:      network?.rxSec != null ? network : (network?.rx != null ? network : null),
    uptime:       typeof uptime === 'number' ? uptime : null,
    os:           typeof os === 'string' ? os : null,
    hostname:     typeof hostname === 'string' ? hostname : null,
    processes:    Array.isArray(processes) ? processes.slice(0, 10) : null,
  };

  // Apply locally FIRST, unconditionally — this is what makes the data show
  // up for the agent that just posted it, regardless of Redis's health.
  // BUG FIX: previously this only happened via the bus subscription below,
  // which meant a message had to make a full round-trip through Redis
  // before even the SAME worker that received the POST would see it. If
  // Redis was down/unreachable/misconfigured, the agent still got its 200
  // OK (this route doesn't await the publish), but the snapshot vanished —
  // nothing local, nothing cross-worker. An actively-reporting agent would
  // show up as fully silent on every dashboard with no error surfaced
  // anywhere. Applying locally here removes Redis as a single point of
  // failure for the worker that's actually talking to the agent; the bus
  // publish below is now purely a "let other workers know too" nice-to-have.
  applySnapshot(device.id, snapshot);
  sseBroadcastLocal(device.id, snapshot, device.org_id).catch(() => {});
  bus.publish('metrics', { deviceId: device.id, snapshot, orgId: device.org_id });
  recordHistoryBucket(device.id, snapshot);

  // Fire alert evaluation asynchronously
  setImmediate(() => evaluateAlerts(device.id, snapshot));

  res.json({ ok: true, device_id: device.id });
});

// ── GET /api/metrics/policies — agent fetches its effective restriction rules ──
// Returns the union of: global policies (device_id AND group_id both NULL),
// policies scoped to this device's group, and policies scoped to this exact
// device. The agent caches this locally and re-polls every ~60s.
router.get('/policies', agentAuth, async (req, res) => {
  try {
    const device = req.agentDevice;
    const full = await queryOne('SELECT group_id, os_type FROM devices WHERE id = ?', [device.id]);
    const rows = await query(
      `SELECT id, process_name, match_type, action, os_type FROM process_policies
        WHERE enabled = 1
          AND (
            device_id = ?
            OR (device_id IS NULL AND (group_id IS NULL OR group_id = ?))
          )`,
      [device.id, full?.group_id || null]
    );
    // Filter by OS if the policy specifies one
    const deviceOs = (full?.os_type || '').toLowerCase();
    const filtered = rows.filter(r => !r.os_type || r.os_type.toLowerCase() === deviceOs);
    res.json(filtered.map(r => ({ id: r.id, process_name: r.process_name, match_type: r.match_type, action: r.action })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/metrics/violation — agent reports a restricted-process hit ──────
router.post('/violation', agentIngestLimiter, agentAuth, async (req, res) => {
  try {
    const device = req.agentDevice;
    const { policy_id, process_name, pid, action_taken, kill_result } = req.body;
    if (!process_name?.trim()) return res.status(400).json({ error: 'process_name is required' });

    const id  = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    await run(
      `INSERT INTO process_violations
         (id, device_id, policy_id, process_name, pid, action_taken, kill_result, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, device.id, policy_id || null, process_name.trim(), pid || null,
       ['alert', 'kill'].includes(action_taken) ? action_taken : 'alert',
       kill_result || null, now]
    );

    const blocked  = action_taken === 'kill';
    const severity = blocked ? 'critical' : 'warning';
    const message  = `Restricted process "${process_name.trim()}"${pid ? ` (PID ${pid})` : ''} ${blocked ? 'was blocked' : 'was detected'} on ${device.name}`;

    // Notify admins — same pattern as alert_notifications so they show up
    // in the existing Alerts bell/page without any new UI plumbing.
    try {
      const admins = await query('SELECT id FROM users WHERE role = ? AND enabled = 1', ['admin']);
      for (const admin of admins) {
        await run(
          `INSERT INTO alert_notifications (id, user_id, rule_id, device_id, severity, message, triggered_at, read_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, NULL)`,
          [uuidv4(), admin.id, device.id, severity, message, now]
        );
      }
      pushNotification(admins.map(a => a.id), {
        type: 'process_violation', severity, device_id: device.id, device_name: device.name,
        process_name: process_name.trim(), pid: pid || null, action_taken: blocked ? 'kill' : 'alert',
        message, triggered_at: now,
      });
    } catch (e) { console.error('[Violation] notify failed:', e.message); }

    webhook.fire('process.violation', {
      device_id: device.id, device_name: device.name, process_name: process_name.trim(),
      pid: pid || null, action_taken: blocked ? 'kill' : 'alert', severity, message,
    }).catch(() => {});

    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Persistent history (metrics_history table) ────────────────────────────────
// The in-memory `store` above is a ~25-min ring buffer that resets on every
// restart — fine for the live Monitoring page, useless for "compare this
// week vs last week". This upserts one row per device per 60s bucket using
// sum/max/n so the write is a single atomic UPSERT no matter how many
// samples (agent posts ~every 5s) land in that minute — no read before
// write, no extra round trip on the ingest hot path. See
// db/migrate-metrics-history.js for the table + the averaging rationale.
function recordHistoryBucket(deviceId, snapshot) {
  const bucketTs = Math.floor(snapshot.ts / 60) * 60;
  const ramPct   = snapshot.ram ? (snapshot.ram.used / snapshot.ram.total) * 100 : null;
  const diskPct  = Array.isArray(snapshot.disk) && snapshot.disk[0] ? snapshot.disk[0].use : null;
  const rx       = snapshot.network?.rxSec ?? null;
  const tx       = snapshot.network?.txSec ?? null;

  run(
    `INSERT INTO metrics_history
       (device_id, bucket_ts, cpu_sum, cpu_max, cpu_n, ram_pct_sum, ram_pct_max, ram_n,
        disk_pct_sum, disk_pct_max, disk_n, net_rx_sum, net_tx_sum, net_n)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       cpu_sum      = cpu_sum      + VALUES(cpu_sum),
       cpu_max      = GREATEST(cpu_max, VALUES(cpu_max)),
       cpu_n        = cpu_n        + VALUES(cpu_n),
       ram_pct_sum  = ram_pct_sum  + VALUES(ram_pct_sum),
       ram_pct_max  = GREATEST(ram_pct_max, VALUES(ram_pct_max)),
       ram_n        = ram_n        + VALUES(ram_n),
       disk_pct_sum = disk_pct_sum + VALUES(disk_pct_sum),
       disk_pct_max = GREATEST(disk_pct_max, VALUES(disk_pct_max)),
       disk_n       = disk_n       + VALUES(disk_n),
       net_rx_sum   = net_rx_sum   + VALUES(net_rx_sum),
       net_tx_sum   = net_tx_sum   + VALUES(net_tx_sum),
       net_n        = net_n        + VALUES(net_n)`,
    [
      deviceId, bucketTs,
      snapshot.cpu ?? 0, snapshot.cpu ?? 0, snapshot.cpu != null ? 1 : 0,
      ramPct ?? 0, ramPct ?? 0, ramPct != null ? 1 : 0,
      diskPct ?? 0, diskPct ?? 0, diskPct != null ? 1 : 0,
      rx ?? 0, tx ?? 0, (rx != null || tx != null) ? 1 : 0,
    ]
  ).catch(e => console.error('[metrics] history bucket write failed:', e.message));
}

function csvEscape(val) {
  const s = val === null || val === undefined ? '' : String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// range -> [lookback seconds, bucket-grouping seconds]
// '90d' and '1y' only became cheap to offer once metrics_history_daily
// existed (see services/metricsRollup.js) - a year at 1-day buckets is
// ~365 rows/device instead of ~525k raw 1-min rows.
const RANGE_PRESETS = {
  '1h':  [3600,        60],     // 60 x 1-min points
  '24h': [86400,       300],    // 288 x 5-min points
  '7d':  [7 * 86400,   3600],   // 168 x 1-hr points
  '30d': [30 * 86400,  21600],  // 120 x 6-hr points
  '90d': [90 * 86400,  86400],  // 90 x 1-day points
  '1y':  [365 * 86400, 86400],  // 365 x 1-day points
};

// Raw 60s buckets only live for this long before being compacted into
// metrics_history_daily (see services/metricsRollup.js) - used here purely
// to decide which table(s) a given [fromTs,toTs] window needs to read from.
const { COMPRESS_AFTER_DAYS } = require('../services/metricsRollup');

// SECURITY FIX: this used to only check anything for non-admins, and even
// then only checked group access — never org. An admin (who in this
// multi-tenant app can be a member of several client orgs) got every
// device's history/export with no org filter at all, and even the
// non-admin path could match a device in the *wrong* org if a group_id
// ever collided (defense in depth). Now everyone — admin included — must
// have the device belong to req.orgId, and non-admins additionally need
// explicit group access, same as before.
async function assertMetricsAccess(req, res) {
  const device = await queryOne('SELECT id, group_id FROM devices WHERE id = ? AND org_id = ?', [req.params.deviceId, req.orgId]);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return false; }
  if (req.user.role !== 'admin') {
    const access = await queryOne(
      'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
      [req.user.id, device.group_id]
    );
    if (!access) { res.status(403).json({ error: 'Access denied' }); return false; }
  }
  return true;
}

// Resolves ?range=1h|24h|7d|30d or ?from=&to= (unix seconds) + optional
// ?bucket= override (seconds) into a concrete [fromTs, toTs, bucketSeconds].
function resolveRangeQuery(req) {
  const now = Math.floor(Date.now() / 1000);
  let fromTs, toTs, bucketSeconds;

  if (req.query.from && req.query.to) {
    fromTs = parseInt(req.query.from);
    toTs   = parseInt(req.query.to);
    const span = Math.max(1, toTs - fromTs);
    // Auto-pick a sensible bucket width for custom ranges so a 6-month
    // custom range doesn't try to return 250k raw 1-min rows. Mirrors the
    // widths used by RANGE_PRESETS above (including the 90d/1y day-bucket
    // tiers) so a custom range of, say, 400 days gets the same ~1 row/day
    // shape a '1y' preset would, instead of getting stuck at the 6h bucket
    // that used to be the widest option here.
    bucketSeconds =
      span <= 3600            ? 60 :
      span <= 86400            ? 300 :
      span <= 7 * 86400        ? 3600 :
      span <= 30 * 86400       ? 21600 :
      86400;
  } else {
    const preset = RANGE_PRESETS[req.query.range] || RANGE_PRESETS['24h'];
    toTs = now;
    fromTs = now - preset[0];
    bucketSeconds = preset[1];
  }
  if (req.query.bucket) bucketSeconds = Math.max(60, parseInt(req.query.bucket) || bucketSeconds);
  return { fromTs, toTs, bucketSeconds };
}

// Raw metrics_history only holds ~COMPRESS_AFTER_DAYS days — anything older
// has already been folded into metrics_history_daily and deleted from the
// raw table (see services/metricsRollup.js). A query window that reaches
// further back than that (90d/1y presets, or any custom range spanning
// more than a month) therefore needs to pull from BOTH tables and merge
// them, or the older portion of the range would silently come back empty
// even though the data is still retained — just at daily granularity.
// day_ts/bucket_ts share the same "seconds since epoch, floored" shape so
// UNION ALL-ing them before the outer GROUP BY is safe and keeps the
// sum/max/n weighted-average math identical either way.
async function fetchHistoryRows(deviceId, fromTs, toTs, bucketSeconds) {
  return query(
    `SELECT
       FLOOR(ts / ?) * ? AS ts,
       SUM(cpu_n) AS cpu_n,        CASE WHEN SUM(cpu_n)  > 0 THEN SUM(cpu_sum)      / SUM(cpu_n)  END AS cpu_avg,
       MAX(cpu_max)  AS cpu_max,
       SUM(ram_n) AS ram_n,        CASE WHEN SUM(ram_n)  > 0 THEN SUM(ram_pct_sum)  / SUM(ram_n)  END AS ram_avg,
       MAX(ram_pct_max)  AS ram_max,
       SUM(disk_n) AS disk_n,      CASE WHEN SUM(disk_n) > 0 THEN SUM(disk_pct_sum) / SUM(disk_n) END AS disk_avg,
       MAX(disk_pct_max) AS disk_max,
       SUM(net_n) AS net_n,        CASE WHEN SUM(net_n)  > 0 THEN SUM(net_rx_sum)   / SUM(net_n)  END AS net_rx_avg,
       CASE WHEN SUM(net_n)  > 0 THEN SUM(net_tx_sum)   / SUM(net_n)  END AS net_tx_avg
     FROM (
       SELECT bucket_ts AS ts, cpu_sum, cpu_max, cpu_n, ram_pct_sum, ram_pct_max, ram_n,
              disk_pct_sum, disk_pct_max, disk_n, net_rx_sum, net_tx_sum, net_n
       FROM metrics_history
       WHERE device_id = ? AND bucket_ts BETWEEN ? AND ?
       UNION ALL
       SELECT day_ts AS ts, cpu_sum, cpu_max, cpu_n, ram_pct_sum, ram_pct_max, ram_n,
              disk_pct_sum, disk_pct_max, disk_n, net_rx_sum, net_tx_sum, net_n
       FROM metrics_history_daily
       WHERE device_id = ? AND day_ts BETWEEN ? AND ?
     ) combined
     GROUP BY ts
     ORDER BY ts ASC`,
    [bucketSeconds, bucketSeconds, deviceId, fromTs, toTs, deviceId, fromTs, toTs]
  );
}


// ── Group-wise metrics history ────────────────────────────────────────────────
// Same durable metrics_history/metrics_history_daily tables as the per-device
// history endpoint below, but aggregated across every device in a group so a
// group can be viewed as a single trend line ("how is the whole 'Lab 3' group
// trending") instead of clicking through devices one at a time. Combined
// series sums sum/n across all member devices per bucket before dividing, so
// it's a true device-weighted average, not an average-of-averages. A
// per-device breakdown (avg/max over the whole window) rides along in the
// same response so the frontend can render a legend/table without a second
// round trip per device.
// SECURITY FIX: same class of bug as assertMetricsAccess above — this used
// to only gate non-admins, and never checked org at all. Now the group
// must belong to req.orgId for anyone, admin included.
async function assertGroupAccess(req, res) {
  const group = await queryOne('SELECT id FROM `groups` WHERE id = ? AND org_id = ?', [req.params.groupId, req.orgId]);
  if (!group) { res.status(404).json({ error: 'Group not found' }); return false; }
  if (req.user.role !== 'admin') {
    const access = await queryOne(
      'SELECT 1 FROM user_group_access WHERE user_id = ? AND group_id = ?',
      [req.user.id, req.params.groupId]
    );
    if (!access) { res.status(403).json({ error: 'Access denied to this group' }); return false; }
  }
  return true;
}

async function fetchGroupCombinedRows(deviceIds, fromTs, toTs, bucketSeconds) {
  if (!deviceIds.length) return [];
  const placeholders = deviceIds.map(() => '?').join(',');
  return query(
    `SELECT
       FLOOR(ts / ?) * ? AS ts,
       SUM(cpu_n) AS cpu_n,   CASE WHEN SUM(cpu_n)  > 0 THEN SUM(cpu_sum)      / SUM(cpu_n)  END AS cpu_avg,
       MAX(cpu_max)  AS cpu_max,
       SUM(ram_n) AS ram_n,   CASE WHEN SUM(ram_n)  > 0 THEN SUM(ram_pct_sum)  / SUM(ram_n)  END AS ram_avg,
       MAX(ram_pct_max)  AS ram_max,
       SUM(disk_n) AS disk_n, CASE WHEN SUM(disk_n) > 0 THEN SUM(disk_pct_sum) / SUM(disk_n) END AS disk_avg,
       MAX(disk_pct_max) AS disk_max,
       SUM(net_n) AS net_n,   CASE WHEN SUM(net_n)  > 0 THEN SUM(net_rx_sum)   / SUM(net_n)  END AS net_rx_avg,
       CASE WHEN SUM(net_n)  > 0 THEN SUM(net_tx_sum)   / SUM(net_n)  END AS net_tx_avg
     FROM (
       SELECT bucket_ts AS ts, cpu_sum, cpu_max, cpu_n, ram_pct_sum, ram_pct_max, ram_n,
              disk_pct_sum, disk_pct_max, disk_n, net_rx_sum, net_tx_sum, net_n
       FROM metrics_history
       WHERE device_id IN (${placeholders}) AND bucket_ts BETWEEN ? AND ?
       UNION ALL
       SELECT day_ts AS ts, cpu_sum, cpu_max, cpu_n, ram_pct_sum, ram_pct_max, ram_n,
              disk_pct_sum, disk_pct_max, disk_n, net_rx_sum, net_tx_sum, net_n
       FROM metrics_history_daily
       WHERE device_id IN (${placeholders}) AND day_ts BETWEEN ? AND ?
     ) combined
     GROUP BY ts
     ORDER BY ts ASC`,
    [bucketSeconds, bucketSeconds, ...deviceIds, fromTs, toTs, ...deviceIds, fromTs, toTs]
  );
}

async function fetchPerDeviceSummary(deviceIds, fromTs, toTs) {
  if (!deviceIds.length) return [];
  const placeholders = deviceIds.map(() => '?').join(',');
  return query(
    `SELECT device_id,
       CASE WHEN SUM(cpu_n)  > 0 THEN SUM(cpu_sum)      / SUM(cpu_n)  END AS cpu_avg,  MAX(cpu_max)      AS cpu_max,
       CASE WHEN SUM(ram_n)  > 0 THEN SUM(ram_pct_sum)  / SUM(ram_n)  END AS ram_avg,  MAX(ram_pct_max)  AS ram_max,
       CASE WHEN SUM(disk_n) > 0 THEN SUM(disk_pct_sum) / SUM(disk_n) END AS disk_avg, MAX(disk_pct_max) AS disk_max,
       CASE WHEN SUM(net_n)  > 0 THEN SUM(net_rx_sum)   / SUM(net_n)  END AS net_rx_avg,
       CASE WHEN SUM(net_n)  > 0 THEN SUM(net_tx_sum)   / SUM(net_n)  END AS net_tx_avg
     FROM (
       SELECT device_id, cpu_sum, cpu_max, cpu_n, ram_pct_sum, ram_pct_max, ram_n,
              disk_pct_sum, disk_pct_max, disk_n, net_rx_sum, net_tx_sum, net_n
       FROM metrics_history WHERE device_id IN (${placeholders}) AND bucket_ts BETWEEN ? AND ?
       UNION ALL
       SELECT device_id, cpu_sum, cpu_max, cpu_n, ram_pct_sum, ram_pct_max, ram_n,
              disk_pct_sum, disk_pct_max, disk_n, net_rx_sum, net_tx_sum, net_n
       FROM metrics_history_daily WHERE device_id IN (${placeholders}) AND day_ts BETWEEN ? AND ?
     ) combined
     GROUP BY device_id`,
    [...deviceIds, fromTs, toTs, ...deviceIds, fromTs, toTs]
  );
}

// GET /api/metrics/group/:groupId/history?range=1h|24h|7d|30d|90d|1y&from=&to=&bucket=
router.get('/group/:groupId/history', requireAuth, requireOrgContext, async (req, res) => {
  try {
    if (!(await assertGroupAccess(req, res))) return;
    const group = await queryOne('SELECT id, name FROM `groups` WHERE id = ? AND org_id = ?', [req.params.groupId, req.orgId]);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const devices = await query('SELECT id, name, status FROM devices WHERE group_id = ? AND org_id = ? ORDER BY name', [req.params.groupId, req.orgId]);
    const deviceIds = devices.map(d => d.id);

    const { fromTs, toTs, bucketSeconds } = resolveRangeQuery(req);
    const [points, perDevice] = await Promise.all([
      fetchGroupCombinedRows(deviceIds, fromTs, toTs, bucketSeconds),
      fetchPerDeviceSummary(deviceIds, fromTs, toTs),
    ]);

    const summaryById = new Map(perDevice.map(r => [r.device_id, r]));
    const devicesSummary = devices.map(d => ({
      device_id: d.id, name: d.name, status: d.status,
      ...(summaryById.get(d.id) || { cpu_avg: null, cpu_max: null, ram_avg: null, ram_max: null,
        disk_avg: null, disk_max: null, net_rx_avg: null, net_tx_avg: null }),
    }));

    res.json({
      group: { id: group.id, name: group.name },
      from: fromTs, to: toTs, bucketSeconds,
      device_count: devices.length,
      points, devices: devicesSummary,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/metrics/group/:groupId/history/export?range=&from=&to= — CSV of the
// combined group series, same shape/columns as the per-device CSV export.
router.get('/group/:groupId/history/export', requireAuth, requireOrgContext, async (req, res) => {
  try {
    if (!(await assertGroupAccess(req, res))) return;
    const group = await queryOne('SELECT id, name FROM `groups` WHERE id = ? AND org_id = ?', [req.params.groupId, req.orgId]);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const deviceIds = (await query('SELECT id FROM devices WHERE group_id = ? AND org_id = ?', [req.params.groupId, req.orgId])).map(r => r.id);
    const { fromTs, toTs, bucketSeconds } = resolveRangeQuery(req);
    const rows = await fetchGroupCombinedRows(deviceIds, fromTs, toTs, bucketSeconds);

    const cols = ['timestamp', 'cpu_avg_pct', 'cpu_max_pct', 'ram_avg_pct', 'ram_max_pct',
                  'disk_avg_pct', 'disk_max_pct', 'net_rx_avg_bps', 'net_tx_avg_bps'];
    const header = cols.join(',');
    const round2 = v => v == null ? '' : Math.round(v * 100) / 100;
    const lines = rows.map(r => [
      new Date(r.ts * 1000).toISOString(),
      round2(r.cpu_avg), round2(r.cpu_max),
      round2(r.ram_avg), round2(r.ram_max),
      round2(r.disk_avg), round2(r.disk_max),
      round2(r.net_rx_avg), round2(r.net_tx_avg),
    ].map(csvEscape).join(','));
    const body = [header, ...lines].join('\n');

    const stamp = new Date().toISOString().slice(0, 10);
    const safeName = group.name.replace(/[^a-z0-9-_]+/gi, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="netcontrol-metrics-group-${safeName}-${stamp}.csv"`);
    res.send(body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SECURITY/CORRECTNESS FIX: this used to only restrict non-admins, and even
// then via user_group_access with no org filter at all — an admin (who in
// this multi-tenant app is very often a member of several client orgs) got
// every org's live metrics unconditionally, and a non-admin could in theory
// see another org's device if a group_id ever collided. Now the allowed-id
// set is always derived from `org_id = req.orgId` first, and non-admins are
// additionally narrowed to their accessible groups within that org.
router.get('/', requireAuth, requireOrgContext, async (req, res) => {
  try {
    const result = {};
    let orgDeviceRows;
    if (req.user.role !== 'admin') {
      orgDeviceRows = await query(
        'SELECT d.id FROM devices d ' +
        'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
        'WHERE d.org_id = ?',
        [req.user.id, req.orgId]
      );
    } else {
      orgDeviceRows = await query('SELECT id FROM devices WHERE org_id = ?', [req.orgId]);
    }
    const allowedIds = new Set(orgDeviceRows.map(r => r.id));
    for (const [id, entry] of store.entries()) {
      if (allowedIds.has(id)) result[id] = { latest: entry.latest, history: entry.history };
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/metrics/:deviceId ─────────────────────────────────────────────────
router.get('/:deviceId', requireAuth, requireOrgContext, async (req, res) => {
  try {
    if (!(await assertMetricsAccess(req, res))) return;
    const entry = store.get(req.params.deviceId);
    if (!entry) return res.json({ latest: null, history: [] });
    res.json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/metrics/:deviceId/history?range=1h|24h|7d|30d&from=&to=&bucket= ──
// Long-term, pre-aggregated history for the Monitoring History/comparison
// page. Unlike GET /:deviceId (in-memory, ~25 min), this reads from the
// durable metrics_history table and can go back as far as retention allows.
router.get('/:deviceId/history', requireAuth, requireOrgContext, async (req, res) => {
  try {
    if (!(await assertMetricsAccess(req, res))) return;
    const { fromTs, toTs, bucketSeconds } = resolveRangeQuery(req);
    const rows = await fetchHistoryRows(req.params.deviceId, fromTs, toTs, bucketSeconds);
    res.json({ from: fromTs, to: toTs, bucketSeconds, points: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/metrics/:deviceId/history/export?range=&from=&to=&format=csv ────
// CSV is the format used everywhere else this app exports tabular data (see
// routes/audit.js) and the one every spreadsheet/BI tool (Excel, Sheets,
// Grafana CSV panels, etc.) reads natively — so it's what's offered here too.
router.get('/:deviceId/history/export', requireAuth, requireOrgContext, async (req, res) => {
  try {
    if (!(await assertMetricsAccess(req, res))) return;
    const device = await queryOne('SELECT name FROM devices WHERE id = ? AND org_id = ?', [req.params.deviceId, req.orgId]);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const { fromTs, toTs, bucketSeconds } = resolveRangeQuery(req);
    const rows = await fetchHistoryRows(req.params.deviceId, fromTs, toTs, bucketSeconds);

    const cols = ['timestamp', 'cpu_avg_pct', 'cpu_max_pct', 'ram_avg_pct', 'ram_max_pct',
                  'disk_avg_pct', 'disk_max_pct', 'net_rx_avg_bps', 'net_tx_avg_bps'];
    const header = cols.join(',');
    const round2 = v => v == null ? '' : Math.round(v * 100) / 100;
    const lines = rows.map(r => [
      new Date(r.ts * 1000).toISOString(),
      round2(r.cpu_avg), round2(r.cpu_max),
      round2(r.ram_avg), round2(r.ram_max),
      round2(r.disk_avg), round2(r.disk_max),
      round2(r.net_rx_avg), round2(r.net_tx_avg),
    ].map(csvEscape).join(','));
    const body = [header, ...lines].join('\n');

    const stamp = new Date().toISOString().slice(0, 10);
    const safeName = device.name.replace(/[^a-z0-9-_]+/gi, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="netcontrol-metrics-${safeName}-${stamp}.csv"`);
    res.send(body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;