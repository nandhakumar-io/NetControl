// services/webTerminal.js — HTTP/HTTPS relay terminal
// Works even when SSH port 22 is blocked — agent polls for commands,
// sends output back. Full PTY emulation over plain HTTP.
//
// STRUCTURAL FIX (this revision): session state used to live in a plain
// in-memory `Map`, scoped to a single cluster worker process. That was the
// real bug behind "Relay output stream lost" — Node's cluster scheduler
// round-robins every new HTTP connection across workers, it does NOT pin a
// browser (or an agent) to the worker that handled its previous request.
// So POST /open could create a session on worker A, and the very next
// request — the browser's GET .../output EventSource connection, or the
// agent's GET .../pending poll — could land on worker B, which had never
// heard of that session: instant 404, regardless of any auth/rate-limit fix
// layered on top. Exactly the class of bug services/bus.js was built to fix
// for the metrics SSE feed; this just never got the same treatment.
//
// Fix: session metadata + queues now live in Redis (shared across workers),
// with real-time delivery (output chunks, input wake-ups, pending-agent
// wake-ups) going through services/bus.js's existing pub/sub — which
// already transparently falls back to an in-process EventEmitter when
// REDIS_URL isn't set, so single-process local dev keeps working with zero
// extra config. Only the durable bits (session hash, input/pending queues)
// need an explicit Map-vs-Redis branch, since bus.js's fallback doesn't
// persist anything — fine, because without Redis you're single-process
// anyway and the Map lives in that one process for the life of the request.
//
// Previous fixes retained as-is: agentRelayLimiter on all agent-facing
// endpoints; SSE auth accepts ?token= (EventSource can't set headers);
// session-owner isolation on input/close.

'use strict';
const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { agentRelayLimiter } = require('../middleware/rateLimiter');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const bus    = require('./bus');
require('dotenv').config();

const router = express.Router();

const SESSION_TTL_SEC = 5 * 60;      // 5 min inactivity — same window as before
const CLOSED_TTL_SEC  = 30;          // grace period so in-flight polls still see `closed`
const redis = bus.getClient();       // null in single-process fallback mode

// ── Durable session state (Map when no Redis, Redis hash/lists when there is) ─
//
// In-memory fallback mirrors the exact shape/behavior of the original
// implementation, so single-process dev is unchanged.
const memSessions = new Map(); // sessionId -> { deviceId, deviceName, userId, inputQueue[], created, lastActive, agentConnected, closed }

function sKey(id)  { return `term:session:${id}`; }
function iKey(id)  { return `term:input:${id}`; }
function pKey(dId) { return `term:pending:${dId}`; }
function aKey()    { return `term:active`; }

async function createSession(sessionId, { deviceId, deviceName, userId }) {
  const now = Date.now();
  if (redis) {
    await redis.hset(sKey(sessionId), {
      deviceId, deviceName, userId, created: now, lastActive: now,
      agentConnected: '0', closed: '0',
    });
    await redis.expire(sKey(sessionId), SESSION_TTL_SEC);
    await redis.sadd(aKey(), sessionId);
  } else {
    memSessions.set(sessionId, {
      deviceId, deviceName, userId, inputQueue: [], created: now, lastActive: now,
      agentConnected: false, closed: false,
    });
  }
}

async function getSession(sessionId) {
  if (redis) {
    const h = await redis.hgetall(sKey(sessionId));
    if (!h || !h.deviceId) return null;
    return {
      deviceId: h.deviceId, deviceName: h.deviceName, userId: h.userId,
      created: Number(h.created), lastActive: Number(h.lastActive),
      agentConnected: h.agentConnected === '1', closed: h.closed === '1',
    };
  }
  return memSessions.get(sessionId) || null;
}

async function touchSession(sessionId) {
  const now = Date.now();
  if (redis) {
    const exists = await redis.exists(sKey(sessionId));
    if (!exists) return;
    await redis.hset(sKey(sessionId), 'lastActive', now);
    await redis.expire(sKey(sessionId), SESSION_TTL_SEC);
  } else {
    const s = memSessions.get(sessionId);
    if (s) s.lastActive = now;
  }
}

async function markAgentConnected(sessionId) {
  if (redis) await redis.hset(sKey(sessionId), 'agentConnected', '1');
  else { const s = memSessions.get(sessionId); if (s) s.agentConnected = true; }
}

async function closeSession(sessionId) {
  if (redis) {
    const key = sKey(sessionId);
    if (await redis.exists(key)) await redis.hset(key, 'closed', '1');
    await redis.expire(key, CLOSED_TTL_SEC);
    await redis.del(iKey(sessionId));
    await redis.srem(aKey(), sessionId);
  } else {
    const s = memSessions.get(sessionId);
    if (s) s.closed = true;
    memSessions.delete(sessionId);
  }
}

async function listSessions() {
  if (redis) {
    const ids = await redis.smembers(aKey());
    const out = [];
    for (const id of ids) {
      const s = await getSession(id);
      if (!s) { redis.srem(aKey(), id).catch(() => {}); continue; }
      out.push({ sessionId: id, deviceId: s.deviceId, deviceName: s.deviceName, agentConnected: s.agentConnected, created: s.created, lastActive: s.lastActive });
    }
    return out;
  }
  return Array.from(memSessions.entries()).map(([id, s]) => ({
    sessionId: id, deviceId: s.deviceId, deviceName: s.deviceName,
    agentConnected: s.agentConnected, created: s.created, lastActive: s.lastActive,
  }));
}

// ── Input queue (browser keystrokes -> waiting agent poll) ────────────────────
async function pushInput(sessionId, data) {
  if (redis) {
    await redis.rpush(iKey(sessionId), data);
    await redis.expire(iKey(sessionId), SESSION_TTL_SEC);
  } else {
    const s = memSessions.get(sessionId);
    if (s) s.inputQueue.push(data);
  }
  bus.publish(`term:input-ready:${sessionId}`, {});
}

async function drainInput(sessionId) {
  if (redis) {
    const key = iKey(sessionId);
    const items = await redis.lrange(key, 0, -1);
    if (items.length) await redis.del(key);
    return items.join('');
  }
  const s = memSessions.get(sessionId);
  if (!s || !s.inputQueue.length) return '';
  return s.inputQueue.splice(0).join('');
}

// ── Pending-for-agent queue (one per device — "a browser is waiting for you") ─
async function enqueuePending(deviceId, sessionId) {
  if (redis) {
    await redis.rpush(pKey(deviceId), sessionId);
    await redis.expire(pKey(deviceId), 60);
  }
  bus.publish(`term:pending-ready:${deviceId}`, {});
}

async function dequeuePending(deviceId) {
  if (redis) {
    while (true) {
      const id = await redis.lpop(pKey(deviceId));
      if (!id) return null;
      const s = await getSession(id);
      if (s && !s.closed && !s.agentConnected) return id;
    }
  }
  for (const [id, s] of memSessions.entries()) {
    if (s.deviceId === deviceId && !s.agentConnected && !s.closed) return id;
  }
  return null;
}

// ── Stale-session sweep ────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    const cutoff = Date.now() - SESSION_TTL_SEC * 1000;
    const sessions = redis ? await listSessions() : Array.from(memSessions.entries()).map(([id, s]) => ({ sessionId: id, lastActive: s.lastActive }));
    for (const s of sessions) {
      if (s.lastActive < cutoff) {
        bus.publish(`term:output:${s.sessionId}`, { type: 'closed', data: '\r\n[Session expired — no activity for 5 min]\r\n' });
        await closeSession(s.sessionId);
      }
    }
  } catch (e) {
    console.error('[WebTerminal] Stale-session sweep failed:', e.message);
  }
}, 60000);

// ── Helpers ────────────────────────────────────────────────────────────────────
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

async function agentAuthMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-api-key' });
  try {
    const device = await queryOne(
      'SELECT id, name FROM devices WHERE agent_key_hash = ?',
      [hashKey(key)]
    );
    if (!device) return res.status(403).json({ error: 'Invalid key' });
    req.agentDevice = device;
    next();
  } catch { res.status(500).json({ error: 'DB error' }); }
}

// ── POST /api/terminal/open/:deviceId — client opens a session ────────────────
router.post('/open/:deviceId', requireAuth, async (req, res) => {
  const { deviceId } = req.params;
  const device = await queryOne('SELECT id, name FROM devices WHERE id = ?', [deviceId]).catch(() => null);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  if (req.user.role !== 'admin') {
    const access = await queryOne(
      'SELECT 1 FROM devices d ' +
      'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
      'WHERE d.id = ?',
      [req.user.id, deviceId]
    ).catch(() => null);
    if (!access) return res.status(403).json({ error: 'Access denied to this device' });
  }

  const sessionId = uuidv4();
  try {
    await createSession(sessionId, { deviceId, deviceName: device.name, userId: req.user.id });
    await enqueuePending(deviceId, sessionId);
  } catch (e) {
    return res.status(500).json({ error: `Could not create session: ${e.message}` });
  }

  res.json({ sessionId, deviceId, deviceName: device.name });
});

// ── GET /api/terminal/session/:sessionId/output — SSE stream to browser ───────
router.get('/session/:sessionId/output', async (req, res) => {
  let token = null;
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token) {
    const url = new URL(req.url, 'http://localhost');
    token = url.searchParams.get('token');
  }
  if (!token) { res.status(401).end(); return; }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const liveUser = await queryOne('SELECT enabled FROM users WHERE id = ?', [payload.id]).catch(() => null);
    if (!liveUser || !liveUser.enabled) { res.status(403).end(); return; }
  }
  catch { res.status(403).end(); return; }

  const { sessionId } = req.params;
  const s = await getSession(sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  await touchSession(sessionId);

  if (!s.agentConnected) {
    res.write(`data: ${JSON.stringify({ type: 'status', data: '\x1b[90m[Waiting for agent to connect…]\x1b[0m\r\n' })}\n\n`);
  }

  const unsub = bus.subscribe(`term:output:${sessionId}`, (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (payload.type === 'closed') res.end();
    } catch {}
  });

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    bus.unsubscribe(`term:output:${sessionId}`, unsub);
  });
});

// ── POST /api/terminal/session/:sessionId/input — browser sends keystrokes ────
router.post('/session/:sessionId/input', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const s = await getSession(sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.userId !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Not your session' });

  await touchSession(sessionId);
  const { data } = req.body;
  if (!data) return res.json({ ok: true });

  await pushInput(sessionId, data);
  res.json({ ok: true });
});

// ── DELETE /api/terminal/session/:sessionId — browser closes session ──────────
router.delete('/session/:sessionId', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const s = await getSession(sessionId);
  if (s && s.userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your session' });
  }
  if (s) {
    bus.publish(`term:output:${sessionId}`, { type: 'closed', data: '\r\n[Session closed]\r\n' });
    await closeSession(sessionId);
    bus.publish(`term:input-ready:${sessionId}`, {});
  }
  res.json({ ok: true });
});

// ── GET /api/terminal/device/:deviceId/pending — agent polls for sessions ─────
router.get('/device/:deviceId/pending', agentRelayLimiter, agentAuthMiddleware, async (req, res) => {
  const deviceId = req.agentDevice.id;
  let settled = false;
  const finish = async (sessionId) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    bus.unsubscribe(`term:pending-ready:${deviceId}`, wake);
    if (sessionId) {
      await markAgentConnected(sessionId);
      bus.publish(`term:output:${sessionId}`, { type: 'status', data: '\x1b[90m[Agent connected — starting shell…]\x1b[0m\r\n' });
      res.json({ session: { sessionId } });
    } else {
      res.json({ session: null });
    }
  };

  const already = await dequeuePending(deviceId).catch(() => null);
  if (already) return finish(already);

  const timeout = setTimeout(() => finish(null), 25000);
  const wake = bus.subscribe(`term:pending-ready:${deviceId}`, async () => {
    const id = await dequeuePending(deviceId).catch(() => null);
    if (id) finish(id);
  });

  req.on('close', () => {
    if (!settled) { settled = true; clearTimeout(timeout); bus.unsubscribe(`term:pending-ready:${deviceId}`, wake); }
  });
});

// ── GET /api/terminal/session/:sessionId/agent-input — agent polls for input ──
router.get('/session/:sessionId/agent-input', agentRelayLimiter, agentAuthMiddleware, async (req, res) => {
  const { sessionId } = req.params;
  const s = await getSession(sessionId);
  if (!s || s.closed) return res.json({ data: null, closed: true });

  await touchSession(sessionId);

  const immediate = await drainInput(sessionId);
  if (immediate) return res.json({ data: immediate, closed: false });

  let settled = false;
  const finish = async () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    bus.unsubscribe(`term:input-ready:${sessionId}`, wake);
    const data = await drainInput(sessionId);
    const cur = await getSession(sessionId);
    res.json({ data: data || null, closed: !cur || cur.closed });
  };

  const timeout = setTimeout(finish, 20000);
  const wake = bus.subscribe(`term:input-ready:${sessionId}`, finish);

  req.on('close', () => {
    if (!settled) { settled = true; clearTimeout(timeout); bus.unsubscribe(`term:input-ready:${sessionId}`, wake); }
  });
});

// ── POST /api/terminal/session/:sessionId/output — agent posts shell output ───
router.post('/session/:sessionId/output', agentRelayLimiter, agentAuthMiddleware, async (req, res) => {
  const { sessionId } = req.params;
  const s = await getSession(sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  await touchSession(sessionId);
  const { data, closed } = req.body;

  if (data) bus.publish(`term:output:${sessionId}`, { type: 'data', data });

  if (closed) {
    bus.publish(`term:output:${sessionId}`, { type: 'closed', data: '\r\n[Shell exited]\r\n' });
    await closeSession(sessionId);
  }

  res.json({ ok: true, closed: !!closed });
});

// ── GET /api/terminal/sessions — active sessions list ─────────────────────────
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    res.json(await listSessions());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router };