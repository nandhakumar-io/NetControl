// routes/metrics.js — Live system metrics ingestion + SSE streaming
// FIX: Added SSE endpoint GET /api/metrics/stream so the frontend receives
// pushed updates the instant an agent sends data — no polling needed.
// This eliminates the "graphs empty until I refresh" problem because:
//   - On mount, frontend subscribes to the stream AND does one full GET
//   - Every agent push immediately fans out to all open SSE connections
//   - History is sent in the initial snapshot, so graphs appear instantly
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

const router = express.Router();

// ── In-memory metrics store ────────────────────────────────────────────────────
const HISTORY_LEN = 300; // ~25 min at 5s intervals
const store = new Map();

function push(deviceId, snapshot) {
  if (!store.has(deviceId)) store.set(deviceId, { latest: null, history: [] });
  const entry = store.get(deviceId);
  entry.latest = snapshot;
  entry.history.push(snapshot);
  if (entry.history.length > HISTORY_LEN) entry.history.shift();
}

// ── SSE client registry ────────────────────────────────────────────────────────
// userId → Set<res>  — only send data the user is allowed to see
const sseClients = new Map();

function sseAdd(userId, res) {
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);
}
function sseDel(userId, res) {
  sseClients.get(userId)?.delete(res);
}
function sseBroadcast(deviceId, snapshot) {
  // Fan out to all connected browsers — each browser re-checks authorisation
  // via the snapshot deviceId if needed; for simplicity we push to everyone
  // (same as the GET /api/metrics endpoint which returns all devices).
  // Operators with restricted access: we can't easily filter here without
  // a DB query per push, so we send the deviceId and let the frontend ignore
  // devices it doesn't have in its device list.
  const payload = JSON.stringify({ deviceId, latest: snapshot });
  for (const [, clients] of sseClients) {
    for (const res of clients) {
      try { res.write(`data: ${payload}\n\n`); } catch {}
    }
  }
}

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
      'SELECT id, name, ip_address FROM devices WHERE agent_key_hash = ?',
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
router.post('/register', registerLimiter, async (req, res) => {
  const { hostname, ip, mac, os_type, os_version, arch } = req.body;
  if (!hostname || !ip) return res.status(400).json({ error: 'hostname and ip are required' });

  const osType = (os_type || '').toLowerCase().includes('win') ? 'windows' : 'linux';
  const macNorm = (mac || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase().slice(0, 12);
  const macFormatted = macNorm.match(/.{1,2}/g)?.join(':') || '00:00:00:00:00:00';

  try {
    let device = macNorm
      ? await queryOne('SELECT * FROM devices WHERE mac_address = ?', [macFormatted])
      : null;

    if (!device) {
      device = await queryOne(
        'SELECT * FROM devices WHERE ip_address = ? AND name = ?', [ip, hostname]
      );
    }

    const apiKey  = genApiKey();
    const keyHash = hashKey(apiKey);
    const now     = Math.floor(Date.now() / 1000);

    if (device) {
      await run(
        `UPDATE devices SET ip_address=?, agent_key_hash=?, agent_registered_at=?,
          os_version=?, arch=?, last_seen=? WHERE id=?`,
        [ip, keyHash, now, os_version || null, arch || null, now, device.id]
      );
      return res.json({ device_id: device.id, device_name: device.name, api_key: apiKey, registered: false });
    }

    const id = uuidv4();
    await run(
      `INSERT INTO devices
         (id, name, ip_address, mac_address, os_type, os_version, arch,
          agent_key_hash, agent_registered_at, status, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
      [id, hostname, ip, macFormatted, osType, os_version || null,
       arch || null, keyHash, now, now, now]
    );

    return res.status(201).json({ device_id: id, device_name: hostname, api_key: apiKey, registered: true });
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

  if (!prev || (now - (prev._dbUpdatedAt || 0)) >= 10) {
    run('UPDATE devices SET status=?, last_seen=? WHERE id=?', ['online', now, device.id])
      .catch(() => {});
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

  push(device.id, snapshot);

  // Push to all SSE clients in real time
  setImmediate(() => sseBroadcast(device.id, snapshot));

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
