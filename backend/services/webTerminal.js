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
const { queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { verifyDeviceOrgAccess } = require('../middleware/tenant');
const { agentRelayLimiter } = require('../middleware/rateLimiter');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const bus    = require('./bus');
const { redisReady: _redisReady, withRedisTimeout } = require('./redisSafe');
require('dotenv').config();

const router = express.Router();

const SESSION_TTL_SEC = 10 * 60;     // idle window before a session is reaped — matches services/sshProxy.js
const CLOSED_TTL_SEC  = 30;          // grace period so in-flight polls still see `closed`
const BUFFER_MAX_CHUNKS = 500;       // capped scrollback replay log, same approach as services/sshProxy.js
const redis = bus.getClient();       // non-null even if Redis is unreachable — see services/redisSafe.js
function redisReady() { return _redisReady(redis, bus); }

// ── Durable session state (Map when no Redis, Redis hash/lists when there is) ─
//
// In-memory fallback mirrors the exact shape/behavior of the original
// implementation, so single-process dev is unchanged.
const memSessions = new Map(); // sessionId -> { deviceId, deviceName, userId, inputQueue[], created, lastActive, agentConnected, closed }

// Lazily creates a memSessions entry if one doesn't exist yet — needed
// because a session can start out fully on Redis and only need the local
// fallback later, mid-flight, if Redis becomes unreachable partway through.
function ensureLocal(sessionId, defaults = {}) {
  let s = memSessions.get(sessionId);
  if (!s) {
    s = { inputQueue: [], buffer: [], created: Date.now(), lastActive: Date.now(), agentConnected: false, closed: false, ...defaults };
    memSessions.set(sessionId, s);
  }
  return s;
}

function sKey(id)  { return `term:session:${id}`; }
function iKey(id)  { return `term:input:${id}`; }
function pKey(dId) { return `term:pending:${dId}`; }
function aKey()    { return `term:active`; }
function bKey(id)  { return `term:buf:${id}`; }

async function createSession(sessionId, { deviceId, deviceName, userId }) {
  const now = Date.now();
  if (redisReady()) {
    try {
      await withRedisTimeout(redis.hset(sKey(sessionId), {
        deviceId, deviceName, userId, created: now, lastActive: now,
        agentConnected: '0', closed: '0',
      }));
      await withRedisTimeout(redis.expire(sKey(sessionId), SESSION_TTL_SEC));
      await withRedisTimeout(redis.sadd(aKey(), sessionId));
      return;
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable creating session ${sessionId}, using local fallback:`, e.message);
    }
  }
  ensureLocal(sessionId, { deviceId, deviceName, userId, created: now, lastActive: now });
}

async function getSession(sessionId) {
  if (redisReady()) {
    try {
      const h = await withRedisTimeout(redis.hgetall(sKey(sessionId)));
      if (h && h.deviceId) {
        return {
          deviceId: h.deviceId, deviceName: h.deviceName, userId: h.userId,
          created: Number(h.created), lastActive: Number(h.lastActive),
          agentConnected: h.agentConnected === '1', closed: h.closed === '1',
        };
      }
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable reading session ${sessionId}, checking local fallback:`, e.message);
    }
  }
  return memSessions.get(sessionId) || null;
}

async function touchSession(sessionId) {
  const now = Date.now();
  if (redisReady()) {
    try {
      const exists = await withRedisTimeout(redis.exists(sKey(sessionId)));
      if (exists) {
        await withRedisTimeout(redis.hset(sKey(sessionId), 'lastActive', now));
        await withRedisTimeout(redis.expire(sKey(sessionId), SESSION_TTL_SEC));
      }
      return;
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable touching session ${sessionId}, using local fallback:`, e.message);
    }
  }
  const s = memSessions.get(sessionId);
  if (s) s.lastActive = now;
}

async function markAgentConnected(sessionId) {
  if (redisReady()) {
    try {
      await withRedisTimeout(redis.hset(sKey(sessionId), 'agentConnected', '1'));
      return;
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable marking agent connected for ${sessionId}, using local fallback:`, e.message);
    }
  }
  const s = memSessions.get(sessionId);
  if (s) s.agentConnected = true;
}

async function closeSession(sessionId) {
  if (redisReady()) {
    try {
      const key = sKey(sessionId);
      if (await withRedisTimeout(redis.exists(key))) await withRedisTimeout(redis.hset(key, 'closed', '1'));
      await withRedisTimeout(redis.expire(key, CLOSED_TTL_SEC));
      await withRedisTimeout(redis.del(iKey(sessionId)));
      await withRedisTimeout(redis.del(bKey(sessionId)));
      await withRedisTimeout(redis.srem(aKey(), sessionId));
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable closing session ${sessionId}:`, e.message);
    }
  }
  const s = memSessions.get(sessionId);
  if (s) s.closed = true;
  memSessions.delete(sessionId);
}

async function listSessions() {
  if (redisReady()) {
    try {
      const ids = await withRedisTimeout(redis.smembers(aKey()));
      const out = [];
      for (const id of ids) {
        const s = await getSession(id);
        if (!s) { redis.srem(aKey(), id).catch(() => {}); continue; }
        out.push({ sessionId: id, deviceId: s.deviceId, deviceName: s.deviceName, agentConnected: s.agentConnected, created: s.created, lastActive: s.lastActive });
      }
      return out;
    } catch (e) {
      console.error('[WebTerminal] Redis unreachable listing sessions, falling back to local:', e.message);
    }
  }
  return Array.from(memSessions.entries()).map(([id, s]) => ({
    sessionId: id, deviceId: s.deviceId, deviceName: s.deviceName,
    agentConnected: s.agentConnected, created: s.created, lastActive: s.lastActive,
  }));
}

// ── Scrollback buffer (agent output -> replayed to a browser that (re)attaches) ─
// Same idea as services/sshProxy.js's replay buffer: lets a browser that
// reconnects — because it navigated away and came back, or the SSE stream
// hiccuped — see everything it missed instead of a blank terminal, without
// needing the agent to resend anything.
async function appendBuffer(sessionId, data) {
  if (redisReady()) {
    try {
      await withRedisTimeout(redis.rpush(bKey(sessionId), data));
      await withRedisTimeout(redis.ltrim(bKey(sessionId), -BUFFER_MAX_CHUNKS, -1));
      await withRedisTimeout(redis.expire(bKey(sessionId), SESSION_TTL_SEC));
      return;
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable buffering output for ${sessionId}, using local fallback:`, e.message);
    }
  }
  const s = ensureLocal(sessionId);
  s.buffer.push(data);
  if (s.buffer.length > BUFFER_MAX_CHUNKS) s.buffer.splice(0, s.buffer.length - BUFFER_MAX_CHUNKS);
}

async function getBuffer(sessionId) {
  if (redisReady()) {
    try {
      return (await withRedisTimeout(redis.lrange(bKey(sessionId), 0, -1))).join('');
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable reading buffer for ${sessionId}, using local fallback:`, e.message);
    }
  }
  return (memSessions.get(sessionId)?.buffer || []).join('');
}

// ── Input queue (browser keystrokes -> waiting agent poll) ────────────────────
async function pushInput(sessionId, data) {
  let usedRedis = false;
  if (redisReady()) {
    try {
      await withRedisTimeout(redis.rpush(iKey(sessionId), data));
      await withRedisTimeout(redis.expire(iKey(sessionId), SESSION_TTL_SEC));
      usedRedis = true;
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable queuing input for ${sessionId}, using local fallback:`, e.message);
    }
  }
  if (!usedRedis) ensureLocal(sessionId).inputQueue.push(data);
  bus.publish(`term:input-ready:${sessionId}`, {});
}

async function drainInput(sessionId) {
  if (redisReady()) {
    try {
      const key = iKey(sessionId);
      const items = await withRedisTimeout(redis.lrange(key, 0, -1));
      if (items.length) await withRedisTimeout(redis.del(key));
      return items.join('');
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable draining input for ${sessionId}, using local fallback:`, e.message);
    }
  }
  const s = memSessions.get(sessionId);
  if (!s || !s.inputQueue.length) return '';
  return s.inputQueue.splice(0).join('');
}

// ── Pending-for-agent queue (one per device — "a browser is waiting for you") ─
async function enqueuePending(deviceId, sessionId) {
  if (redisReady()) {
    try {
      await withRedisTimeout(redis.rpush(pKey(deviceId), sessionId));
      await withRedisTimeout(redis.expire(pKey(deviceId), 60));
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable enqueuing pending session for device ${deviceId} — agent poll will still pick it up via local fallback:`, e.message);
    }
  }
  bus.publish(`term:pending-ready:${deviceId}`, {});
}

async function dequeuePending(deviceId) {
  if (redisReady()) {
    try {
      while (true) {
        const id = await withRedisTimeout(redis.lpop(pKey(deviceId)));
        if (!id) break;
        const s = await getSession(id);
        if (s && !s.closed && !s.agentConnected) return id;
      }
      return null;
    } catch (e) {
      console.error(`[WebTerminal] Redis unreachable dequeuing pending for device ${deviceId}, checking local fallback:`, e.message);
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
    const sessions = await listSessions();
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

// ── POST /api/terminal/open/:deviceId — client opens (or reattaches to) a
// session ────────────────────────────────────────────────────────────────
// STRUCTURAL FIX: sessionId used to be a fresh uuidv4() every call, so
// navigating away from a device's terminal and back always produced a
// brand new session — same underlying gap as services/sshProxy.js had for
// the direct-SSH path (see that file's header comment for the full
// rationale). Deriving the id from (userId, deviceId) instead makes this
// endpoint idempotent: an existing, still-alive session for that user+
// device is found and reattached to — same relay session, same scrollback
// (see appendBuffer/getBuffer) — rather than opening a second one the
// agent would have to juggle two shells for.
router.post('/open/:deviceId', requireAuth, async (req, res) => {
  const { deviceId } = req.params;
  const device = await queryOne('SELECT id, name, org_id FROM devices WHERE id = ?', [deviceId]).catch(() => null);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  try {
    await verifyDeviceOrgAccess(req, device);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, code: e.code });
  }

  if (req.user.role !== 'admin') {
    const access = await queryOne(
      'SELECT 1 FROM devices d ' +
      'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
      'WHERE d.id = ?',
      [req.user.id, deviceId]
    ).catch(() => null);
    if (!access) return res.status(403).json({ error: 'Access denied to this device' });
  }

  const sessionId = `${req.user.id}:${deviceId}`;

  const existing = await getSession(sessionId).catch(() => null);
  if (existing && !existing.closed) {
    await touchSession(sessionId);
    console.log(`[WebTerminal] Reattaching to existing session ${sessionId} for device ${deviceId} (${device.name})`);
    return res.json({ sessionId, deviceId, deviceName: device.name, reattached: true });
  }

  try {
    await createSession(sessionId, { deviceId, deviceName: device.name, userId: req.user.id });
    await enqueuePending(deviceId, sessionId);
    console.log(`[WebTerminal] Session ${sessionId} opened + enqueued for device ${deviceId} (${device.name})`);
  } catch (e) {
    return res.status(500).json({ error: `Could not create session: ${e.message}` });
  }

  res.json({ sessionId, deviceId, deviceName: device.name, reattached: false });
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
    const liveUser = await queryOne('SELECT enabled, role FROM users WHERE id = ?', [payload.id]).catch(() => null);
    if (!liveUser || !liveUser.enabled) { res.status(403).end(); return; }
  }
  catch { res.status(403).end(); return; }

  const { sessionId } = req.params;
  const s = await getSession(sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  // SECURITY FIX: this route checked the JWT was valid and the account
  // enabled, but never that the session actually belonged to that user —
  // unlike POST /session/:sessionId/input and DELETE /session/:sessionId
  // right below, which both do this check. sessionId is `${userId}:
  // ${deviceId}`, so any authenticated user who can see or guess another
  // user's session id could read that user's live terminal output (device
  // shell command results, file listings, credentials typed at a prompt,
  // etc.) on any device, including a device in another org. Same rule as
  // the sibling routes: the session owner, or a global admin.
  if (payload.id !== s.userId && liveUser.role !== 'admin') {
    return res.status(403).json({ error: 'Not your session' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  await touchSession(sessionId);

  if (!s.agentConnected) {
    res.write(`data: ${JSON.stringify({ type: 'status', data: '\x1b[90m[Waiting for agent to connect…]\x1b[0m\r\n' })}\n\n`);
  }

  // Reattach case: a browser navigating back to a device it already had a
  // session open for. Replay everything buffered so far so the terminal
  // shows the same scrollback instead of coming up blank, then the live
  // subscription below carries everything from this point on.
  const backlog = await getBuffer(sessionId).catch(() => '');
  if (backlog) {
    try { res.write(`data: ${JSON.stringify({ type: 'data', data: backlog })}\n\n`); } catch {}
  }

  const unsub = bus.subscribe(`term:output:${sessionId}`, (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (payload.type === 'closed') res.end();
    } catch {}
  });

  // The ping doubles as an "attached client" heartbeat — same idea as
  // services/sshProxy.js's activity ping — so a session stays alive while
  // someone actually has it open even through long idle stretches at a
  // shell prompt, instead of only being kept alive by shell output/input.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
    touchSession(sessionId).catch(() => {});
  }, 15000);
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
  console.log(`[WebTerminal] Agent poll for pending: device=${deviceId} (${req.agentDevice.name})`);
  let settled = false;
  const finish = async (sessionId) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    bus.unsubscribe(`term:pending-ready:${deviceId}`, wake);
    if (sessionId) {
      console.log(`[WebTerminal] Handing session ${sessionId} to agent for device ${deviceId}`);
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

  if (data) {
    await appendBuffer(sessionId, data);
    bus.publish(`term:output:${sessionId}`, { type: 'data', data });
  }

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