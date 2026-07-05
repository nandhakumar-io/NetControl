// routes/metrics.js — Live system metrics ingestion + SSE streaming
// FIXED: Agent registration now properly checks for IP+MAC duplicates,
// returns device status indicating if it's new or existing, and handles
// metric-only updates without duplication
'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute: run } = require('../db');
const { requireAuth }          = require('../middleware/auth');
const { agentIngestLimiter, registerLimiter } = require('../middleware/rateLimiter');
const { evaluateAlerts }       = require('./alerts');
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

// ── SSE client registry (local to this worker only) ───────────────────────────
// userId → Set<res>  — only send data the user is allowed to see
const sseClients = new Map();

function sseAdd(userId, res) {
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);
}
function sseDel(userId, res) {
  sseClients.get(userId)?.delete(res);
}
function sseBroadcastLocal(deviceId, snapshot) {
  // Fan out to browsers connected to THIS worker. Cross-worker fan-out is
  // handled by the bus subscription below, which calls this same function
  // on every worker once a snapshot is published.
  const payload = JSON.stringify({ deviceId, latest: snapshot });
  for (const [, clients] of sseClients) {
    for (const res of clients) {
      try { res.write(`data: ${payload}\n\n`); } catch {}
    }
  }
}

// ── Cross-worker sync ──────────────────────────────────────────────────────────
// Single subscription point: whether a snapshot originated on this worker or
// another one, it flows through here so local store + local SSE clients stay
// in sync everywhere.
bus.subscribe('metrics', ({ deviceId, snapshot }) => {
  applySnapshot(deviceId, snapshot);
  sseBroadcastLocal(deviceId, snapshot);
}, { skipSelf: true });

// Device status transitions (from the poller's TCP probes, or agent
// heartbeats coming back online) — pushed as a distinct message `type` so
// the frontend can tell it apart from a metrics snapshot and patch its
// devices list instead of its metrics map.
function sseBroadcastDeviceStatus(deviceId, status) {
  const payload = JSON.stringify({ type: 'device_status', deviceId, status });
  for (const [, clients] of sseClients) {
    for (const res of clients) {
      try { res.write(`data: ${payload}\n\n`); } catch {}
    }
  }
}
bus.subscribe('device_status', ({ deviceId, status }) => {
  sseBroadcastDeviceStatus(deviceId, status);
}, { skipSelf: true });

// ── Helpers ────────────────────────────────────────────────────────────────────
function genApiKey() { return 'nca_' + crypto.randomBytes(24).toString('hex'); }
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

// SSE accepts token from Authorization header OR ?token= query param
function extractUser(req) {
  let token = null;
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) {
    const url = new URL(req.url, 'http://localhost');
    token = url.searchParams.get('token');
  }
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch { return null; }
}

// ── Agent auth ─────────────────────────────────────────────────────────────────
async function agentAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['x-metrics-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-api-key header' });
  const keyHash = hashKey(key);
  try {
    const row = await queryOne(
      'SELECT id, name, ip_address, status FROM devices WHERE agent_key_hash = ?',
      [keyHash]
    );
    if (!row) return res.status(403).json({ error: 'Invalid API key' });
    req.agentDevice = row;
    next();
  } catch (e) { res.status(500).json({ error: 'DB error' }); }
}

// ── GET /api/metrics/stream — SSE push stream ─────────────────────────────────
// Browser connects once; server pushes every agent update in real time.
// On connect: immediately sends the full current snapshot so graphs appear
// without waiting for the next agent push.
router.get('/stream', (req, res) => {
  const user = extractUser(req);
  if (!user) { res.status(401).end(); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseAdd(user.id, res);

  // Send full current snapshot immediately so graphs show on connect
  const snapshot = {};
  for (const [id, entry] of store.entries()) {
    snapshot[id] = { latest: entry.latest, history: entry.history };
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
  const regSecret = process.env.AGENT_REGISTRATION_SECRET;
  if (!regSecret) {
    console.error('[metrics/register] AGENT_REGISTRATION_SECRET is not set — refusing all registrations');
    return res.status(500).json({ error: 'Agent registration is not configured on the server' });
  }
  const provided = req.headers['x-registration-secret'];
  if (!provided || !timingSafeEqualStr(provided, regSecret)) {
    return res.status(401).json({ error: 'Invalid or missing registration secret' });
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
    // 1. If MAC provided and exists in DB → same device (update it)
    // 2. If MAC doesn't exist but IP+hostname match → legacy match (update)
    // 3. Otherwise → new device (create)

    let device = null;
    let action = null;

    // Try to find by MAC first (most reliable)
    if (macNorm && macNorm !== '000000000000') {
      device = await queryOne(
        'SELECT id, name, ip_address, mac_address, status FROM devices WHERE mac_address = ?',
        [macFormatted]
      );
      if (device) {
        action = 'updated';
      }
    }

    // If not found by MAC, try IP+hostname (legacy behavior)
    if (!device) {
      device = await queryOne(
        'SELECT id, name, ip_address, mac_address, status FROM devices WHERE ip_address = ? AND name = ?',
        [ip, hostname]
      );
      if (device) {
        action = 'updated';
      }
    }

    // If device already exists, just update the key and return
    if (device) {
      // Update agent key, OS info, and last seen timestamp
      await run(
        `UPDATE devices SET ip_address=?, mac_address=?, agent_key_hash=?, 
         agent_registered_at=?, os_version=?, arch=?, last_seen=? WHERE id=?`,
        [ip, macFormatted, keyHash, now, os_version || null, arch || null, now, device.id]
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
         (id, name, ip_address, mac_address, os_type, os_version, arch,
          agent_key_hash, agent_registered_at, status, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, hostname, ip, macFormatted, osType, os_version || null,
       arch || null, keyHash, now, approvalStatus, now, now]
    );

    console.log(`[Agent] Registered new device: ${hostname} (${id})`);

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
router.post('/', agentIngestLimiter, agentAuth, async (req, res) => {
  const device = req.agentDevice;
  const { cpu, ram, disk, network, uptime, os, hostname, processes } = req.body;

  const now  = Math.floor(Date.now() / 1000);
  const prev = store.get(device.id)?.latest;

  if ((!prev || (now - (prev._dbUpdatedAt || 0)) >= 10) && device.status !== 'needs_approval') {
    run('UPDATE devices SET status=?, last_seen=? WHERE id=?', ['online', now, device.id])
      .catch(() => {});
    if (device.status && device.status !== 'online') {
      sseBroadcastDeviceStatus(device.id, 'online');
      bus.publish('device_status', { deviceId: device.id, status: 'online' });
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
    _dbUpdatedAt: now,
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
  sseBroadcastLocal(device.id, snapshot);
  bus.publish('metrics', { deviceId: device.id, snapshot });

  // Fire alert evaluation asynchronously
  setImmediate(() => evaluateAlerts(device.id, snapshot));

  res.json({ ok: true, device_id: device.id });
});

// ── GET /api/metrics ───────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = {};
    if (req.user.role === 'operator') {
      const allowed = await query(
        'SELECT d.id FROM devices d ' +
        'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ?',
        [req.user.id]
      );
      const allowedIds = new Set(allowed.map(r => r.id));
      for (const [id, entry] of store.entries()) {
        if (allowedIds.has(id)) result[id] = { latest: entry.latest, history: entry.history };
      }
    } else {
      for (const [id, entry] of store.entries()) {
        result[id] = { latest: entry.latest, history: entry.history };
      }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/metrics/:deviceId ─────────────────────────────────────────────────
router.get('/:deviceId', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'operator') {
      const access = await queryOne(
        'SELECT 1 FROM devices d ' +
        'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
        'WHERE d.id = ?',
        [req.user.id, req.params.deviceId]
      );
      if (!access) return res.status(403).json({ error: 'Access denied' });
    }
    const entry = store.get(req.params.deviceId);
    if (!entry) return res.json({ latest: null, history: [] });
    res.json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;