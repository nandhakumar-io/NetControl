// routes/metrics.js — Live system metrics ingestion, auto-registration & retrieval
const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute: run } = require('../db');
const { requireAuth }          = require('../middleware/auth');
const { agentIngestLimiter, registerLimiter } = require('../middleware/rateLimiter');
const { evaluateAlerts }       = require('./alerts');
const crypto     = require('crypto');

const router = express.Router();

// ── In-memory metrics store ────────────────────────────────────────────────────
const HISTORY_LEN = 300; // ~25 min at 5s
const store = new Map();

function push(deviceId, snapshot) {
  if (!store.has(deviceId)) store.set(deviceId, { latest: null, history: [] });
  const entry = store.get(deviceId);
  entry.latest = snapshot;
  entry.history.push(snapshot);
  if (entry.history.length > HISTORY_LEN) entry.history.shift();
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function genApiKey() { return 'nca_' + crypto.randomBytes(24).toString('hex'); }
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }


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
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
}

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
// Uses agentIngestLimiter (600/min) NOT the global apiLimiter (which skips agent keys)
router.post('/', agentIngestLimiter, agentAuth, async (req, res) => {
  const device = req.agentDevice;
  const { cpu, ram, disk, network, uptime, os, hostname, processes } = req.body;

  const now  = Math.floor(Date.now() / 1000);
  const prev = store.get(device.id)?.latest;

  // DB update throttled to once per 10s to avoid hammering
  if (!prev || (now - (prev._dbUpdatedAt || 0)) >= 10) {
    run('UPDATE devices SET status=?, last_seen=? WHERE id=?', ['online', now, device.id])
      .catch(() => {});
  }

  const snapshot = {
    ts:          now,
    _dbUpdatedAt: now,
    cpu:         typeof cpu === 'number' ? Math.round(cpu * 10) / 10 : null,
    ram:         ram?.used != null && ram?.total != null ? ram : null,
    disk:        Array.isArray(disk) ? disk : null,
    network:     network?.rxSec != null ? network : (network?.rx != null ? network : null),
    uptime:      typeof uptime === 'number' ? uptime : null,
    os:          typeof os === 'string' ? os : null,
    hostname:    typeof hostname === 'string' ? hostname : null,
    processes:   Array.isArray(processes) ? processes.slice(0, 10) : null,
  };

  push(device.id, snapshot);

  // Fire alert evaluation asynchronously — don't block the response
  setImmediate(() => evaluateAlerts(device.id, snapshot));

  res.json({ ok: true, device_id: device.id });
});

// ── GET /api/metrics ───────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = {};
    if (req.user.role === 'operator') {
      // Only return metrics for devices in groups the operator can access
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
