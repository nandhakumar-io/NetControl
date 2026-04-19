// services/webTerminal.js — HTTP/HTTPS relay terminal
// Works even when SSH port 22 is blocked — agent polls for commands,
// sends output back. Full PTY emulation over plain HTTP.
//
// FIX: agentRelayLimiter applied to all agent-facing endpoints.
// Previously there was NO rate limiting on terminal relay calls, which meant:
//   - POST /output (called for every stdout chunk) had no protection
//   - GET /pending (25s poll loop) had no protection
// All three agent endpoints now use agentRelayLimiter (6000 req/min per api-key).
//
// SSE auth fix retained: GET /session/:id/output accepts ?token= query param
// because EventSource cannot set Authorization headers.

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { agentRelayLimiter } = require('../middleware/rateLimiter');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();

const router = express.Router();

// ── In-memory session store ────────────────────────────────────────────────────
// sessionId → { deviceId, deviceName, inputQueue[], outputClients Set,
//               agentPollRes, created, lastActive, agentConnected, closed }
const sessions = new Map();

// Clean up stale sessions every 60s (5 min inactivity)
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, s] of sessions.entries()) {
    if (s.lastActive < cutoff) {
      for (const res of s.outputClients) {
        try {
          res.write(`data: ${JSON.stringify({ type: 'closed', data: '\r\n[Session expired — no activity for 5 min]\r\n' })}\n\n`);
          res.end();
        } catch {}
      }
      sessions.delete(id);
    }
  }
}, 60000);

// ── Helpers ────────────────────────────────────────────────────────────────────
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }

// Agent auth — validates x-api-key against DB
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

  // SECURITY FIX: Operators can only open terminals to devices in their accessible groups
  if (req.user.role === 'operator') {
    const access = await queryOne(
      'SELECT 1 FROM devices d ' +
      'INNER JOIN user_group_access uga ON uga.group_id = d.group_id AND uga.user_id = ? ' +
      'WHERE d.id = ?',
      [req.user.id, deviceId]
    ).catch(() => null);
    if (!access) return res.status(403).json({ error: 'Access denied to this device' });
  }

  const sessionId = uuidv4();
  sessions.set(sessionId, {
    deviceId,
    deviceName:    device.name,
    userId:        req.user.id,   // SECURITY FIX: track owner for session isolation
    inputQueue:    [],
    outputClients: new Set(),
    agentPollRes:  null,
    agentConnected: false,
    created:       Date.now(),
    lastActive:    Date.now(),
    closed:        false,
  });

  res.json({ sessionId, deviceId, deviceName: device.name });
});

// ── GET /api/terminal/session/:sessionId/output — SSE stream to browser ───────
// Uses ?token= query param because EventSource cannot set Authorization headers.
router.get('/session/:sessionId/output', async (req, res) => {
  // Auth: accept token from header OR ?token= query param
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
    // SECURITY FIX: Check user is still enabled for SSE connections too
    const liveUser = await queryOne('SELECT enabled FROM users WHERE id = ?', [payload.id]).catch(() => null);
    if (!liveUser || !liveUser.enabled) { res.status(403).end(); return; }
  }
  catch { res.status(403).end(); return; }

  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  s.outputClients.add(res);
  s.lastActive = Date.now();

  if (!s.agentConnected) {
    res.write(`data: ${JSON.stringify({ type: 'status', data: '\x1b[90m[Waiting for agent to connect…]\x1b[0m\r\n' })}\n\n`);
  }

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    s.outputClients.delete(res);
  });
});

// ── POST /api/terminal/session/:sessionId/input — browser sends keystrokes ────
router.post('/session/:sessionId/input', requireAuth, (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  // SECURITY FIX: Only the session owner can send input (session isolation)
  if (s.userId !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Not your session' });

  s.lastActive = Date.now();
  const { data } = req.body;
  if (!data) return res.json({ ok: true });

  if (s.agentPollRes) {
    try { s.agentPollRes.json({ data }); s.agentPollRes = null; }
    catch { s.inputQueue.push(data); }
  } else {
    s.inputQueue.push(data);
  }
  res.json({ ok: true });
});

// ── DELETE /api/terminal/session/:sessionId — browser closes session ──────────
router.delete('/session/:sessionId', requireAuth, (req, res) => {
  const s = sessions.get(req.params.sessionId);
  // SECURITY FIX: Only the session owner or admin can close a session
  if (s && s.userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your session' });
  }
  if (s) {
    s.closed = true;
    for (const c of s.outputClients) {
      try { c.write(`data: ${JSON.stringify({ type: 'closed', data: '\r\n[Session closed]\r\n' })}\n\n`); c.end(); } catch {}
    }
    sessions.delete(req.params.sessionId);
  }
  res.json({ ok: true });
});

// ── GET /api/terminal/device/:deviceId/pending — agent polls for sessions ─────
// agentRelayLimiter: keyed by x-api-key, 6000 req/min — protects without
// blocking legitimate 25s long-poll loops.
router.get('/device/:deviceId/pending', agentRelayLimiter, agentAuthMiddleware, (req, res) => {
  const timeout = setTimeout(() => res.json({ session: null }), 25000);

  // Check immediately
  for (const [id, s] of sessions.entries()) {
    if (s.deviceId === req.agentDevice.id && !s.agentConnected && !s.closed) {
      clearTimeout(timeout);
      s.agentConnected = true;
      for (const c of s.outputClients) {
        try { c.write(`data: ${JSON.stringify({ type: 'status', data: '\x1b[90m[Agent connected — starting shell…]\x1b[0m\r\n' })}\n\n`); } catch {}
      }
      return res.json({ session: { sessionId: id } });
    }
  }

  req.on('close', () => clearTimeout(timeout));

  const check = setInterval(() => {
    for (const [id, s] of sessions.entries()) {
      if (s.deviceId === req.agentDevice.id && !s.agentConnected && !s.closed) {
        clearTimeout(timeout);
        clearInterval(check);
        s.agentConnected = true;
        for (const c of s.outputClients) {
          try { c.write(`data: ${JSON.stringify({ type: 'status', data: '\x1b[90m[Agent connected — starting shell…]\x1b[0m\r\n' })}\n\n`); } catch {}
        }
        return res.json({ session: { sessionId: id } });
      }
    }
  }, 500);

  setTimeout(() => clearInterval(check), 25500);
});

// ── GET /api/terminal/session/:sessionId/agent-input — agent polls for input ──
router.get('/session/:sessionId/agent-input', agentRelayLimiter, agentAuthMiddleware, (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s || s.closed) return res.json({ data: null, closed: true });

  s.lastActive = Date.now();

  if (s.inputQueue.length > 0) {
    return res.json({ data: s.inputQueue.splice(0).join(''), closed: false });
  }

  const timeout = setTimeout(() => {
    s.agentPollRes = null;
    res.json({ data: null, closed: s.closed });
  }, 20000);

  s.agentPollRes = {
    json: (body) => { clearTimeout(timeout); res.json(body); },
  };

  req.on('close', () => {
    clearTimeout(timeout);
    s.agentPollRes = null;
  });
});

// ── POST /api/terminal/session/:sessionId/output — agent posts shell output ───
router.post('/session/:sessionId/output', agentRelayLimiter, agentAuthMiddleware, (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  s.lastActive = Date.now();
  const { data, closed } = req.body;

  if (data) {
    for (const c of s.outputClients) {
      try { c.write(`data: ${JSON.stringify({ type: 'data', data })}\n\n`); } catch {}
    }
  }

  if (closed) {
    s.closed = true;
    for (const c of s.outputClients) {
      try { c.write(`data: ${JSON.stringify({ type: 'closed', data: '\r\n[Shell exited]\r\n' })}\n\n`); c.end(); } catch {}
    }
    sessions.delete(req.params.sessionId);
  }

  res.json({ ok: true, closed: s?.closed || false });
});

// ── GET /api/terminal/sessions — active sessions list ─────────────────────────
router.get('/sessions', requireAuth, (req, res) => {
  const list = [];
  for (const [id, s] of sessions.entries()) {
    list.push({
      sessionId:      id,
      deviceId:       s.deviceId,
      deviceName:     s.deviceName,
      agentConnected: s.agentConnected,
      created:        s.created,
      lastActive:     s.lastActive,
    });
  }
  res.json(list);
});

module.exports = { router };

